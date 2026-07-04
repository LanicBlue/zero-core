// Flow action tool (project-flow F1) — requirement → code-merge unified flow
//
// # File spec
//
// ## Core
// F4 stage of the project-flow redesign (see
// docs/design/project-flow/project-flow.md §2/§4). One action-switched tool
// `Flow`. The transition + write-doc-section + emit-signal logic and the
// compound verify logic are SHARED with the REST requirement-router via
// `flow-actions.ts` (src/server/flow-actions.ts) — the runtime ctx carries
// `ctx.flowActions` (injected by agent-service, mirroring requirementStore).
// This file is now a thin adapter: it resolves the workspace / target agent /
// delegateTask / gitIntegration from ctx and forwards to ctx.flowActions.
// Single source — REST and runtime can never drift.
//
// Stage scope:
//   - create  → write RequirementRecord at status="found" AND write the
//               requirement document's Intent section to
//               `{workspace}/docs/requirements/{id}.md` (server-side fs; the
//               doc is a FILE, never enters the DB). The natural
//               `requirements.create` op doubles as the `created` signal.
//   - list    → filter by projectId / status / priority.
//   - get     → return a single record (record only; messages excluded).
//   - pick    → found→discuss + write Summary section + emit `requirements.picked`.
//   - ready   → discuss→ready + emit `requirements.ready`.
//   - plan    → ready→plan + write Plan section + create feature worktree +
//               emit `requirements.planned`.
//   - startBuild → plan→build + emit `requirements.buildStarted`.
//   - finishBuild → build→verify + write Coverage section + emit `requirements.buildFinished`.
//   - verify  → COMPOUND: delegate PM coverage judgement (blocking await)
//               + submitCoverageVerdict (APPROVED → archivist merge +
//               verify→closed + emit `verified`; REJECTED → rework verify→build
//               + emit `rejected`) + write Decision Log.
//
// ## Naming
// `Flow` covers the requirement→code-merge flow as one action tool. Capability
// lives in the tool; whether an action is exposed to an agent vs. only to a
// user is a toolPolicy concern, not a structural one.
//
// ## Inputs
// - ctx.requirementStore (RequirementStore — required; tool stays gated off
//   otherwise via CONDITIONAL_TOOLS).
// - ctx.flowActions (FlowActions — injected by agent-service; the shared
//   backend with the REST router). Falls back to ad-hoc ctx assembly when a
//   legacy test harness wires requirementStore but not flowActions.
// - ctx.contextBundle.workspaceDir OR ctx.workingDir (resolved workspace for
//   the docs/requirements/{id}.md write).
// - ctx.delegateTask / ctx.gitIntegration / ctx.pmService — runtime-only
//   handles surfaced by agent-service (verify delegate + plan worktree).
//
// ## Output
// - export const flowTool (buildTool result).
//

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { RequirementRecord } from "../../shared/types.js";

/**
 * FlowActions backend shape (project-flow F4). Imported as a TYPE-ONLY ref so
 * the runtime layer never imports the server-layer module at runtime — the
 * backend is injected via ctx.flowActions (agent-service wiring). Test
 * harnesses build their own via createFlowActions imported directly from the
 * server module.
 */
export type FlowActionsLike = {
	create(input: {
		projectId: string;
		title: string;
		description?: string;
		priority?: "low" | "normal" | "high" | "critical";
		impactScope?: string;
		source?: "analyst" | "user";
	}): { requirement: RequirementRecord; docNote: string };
	list(filter?: { projectId?: string; status?: string; priority?: string }): RequirementRecord[];
	get(id: string): RequirementRecord | undefined;
	transition(input: {
		id: string;
		action: "pick" | "ready" | "plan" | "startBuild" | "finishBuild";
		body?: string;
		projectId?: string;
	}): { requirement: RequirementRecord; docNote: string; worktreeNote: string };
	verify(input: {
		id: string;
		projectId?: string;
		source: any;
	}): Promise<{ requirement: RequirementRecord; text: string; applied: boolean }>;
};

// NOTE: the named-signal emitter + the doc-section writer live in the shared
// backend (src/server/flow-actions.ts). The runtime tool only forwards; it
// never imports the server-layer hub directly (conventions.md).

// ---------------------------------------------------------------------------
// Flat action schema — one tool, multiple actions
// ---------------------------------------------------------------------------
// NOTE: deliberately a FLAT z.object (NOT z.discriminatedUnion), matching the
// project-tool.ts / agent-registry.ts pattern. LLM tool-calling protocols
// (OpenAI/GLM/Anthropic function-calling) require the top-level parameters
// schema to be `type: object`; a top-level `oneOf`/discriminated union is
// dropped or mis-parsed by most providers, so the model calls the tool with
// `{}` and zod then rejects it. The action enum validates the discriminator;
// per-action required fields are checked at runtime inside execute.

export const flowActionSchema = z.object({
	action: z.enum([
		"create", "list", "get",
		// F2 transition actions (each = transitionStatus + write doc section +
		// emit a named hook signal).
		"pick", "ready", "plan", "startBuild", "finishBuild",
		// F3 compound action: verify (delegate PM coverage judgement +
		// submitCoverageVerdict → APPROVED: merge + closed + emit `verified`;
		// REJECTED: rework verify→build + emit `rejected`). See
		// docs/design/project-flow/project-flow.md §2/§3.
		"verify",
	]),
	// create
	projectId: z.string().optional(),
	title: z.string().optional(),
	description: z.string().optional(),
	priority: z.enum(["low", "normal", "high", "critical"]).optional(),
	impactScope: z.string().optional(),
	// list / get / transition actions
	status: z.string().optional(),
	id: z.string().optional(),
	// pick: Summary section body; plan: Plan section body;
	// finishBuild: Coverage section body; verify: Decision Log body is composed
	// from the PM verdict (the optional summary is the lead's note for PM).
	// Optional — empty body still creates the section header so the doc
	// structure is present.
	summary: z.string().optional(),
	plan: z.string().optional(),
	coverage: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the workspace dir for the docs/requirements write. */
function resolveWorkspaceDir(ctx: any): string | undefined {
	const bundle = ctx?.contextBundle;
	if (bundle && typeof bundle.workspaceDir === "string" && bundle.workspaceDir) {
		return bundle.workspaceDir;
	}
	const wd = ctx?.workingDir;
	return typeof wd === "string" && wd ? wd : undefined;
}

/** Resolve the projectId from ctx bundle or input. */
function resolveProjectId(ctx: any, input: any, fallback?: string): string | undefined {
	const fromBundle = ctx?.contextBundle?.projectId ?? ctx?.projectId;
	return fromBundle ?? input.projectId ?? fallback;
}

/**
 * Fetch the FlowActions backend for this ctx. The backend is injected by
 * agent-service via ctx.flowActions (single source — the REST router uses the
 * same object). Test harnesses that exercised the legacy direct-store path
 * must now wire ctx.flowActions themselves (see f1/f2/f3 tests).
 */
function getFlowActions(ctx: any): FlowActionsLike | undefined {
	return (ctx?.flowActions as FlowActionsLike | undefined) ?? undefined;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const flowTool = buildTool({
	name: "Flow",
	description:
		"Requirement → code-merge unified flow tool. create/list/get + transition actions (pick/ready/plan/startBuild/finishBuild) + compound verify (PM coverage judgement + merge).",
	prompt:
		"Manage the project requirement flow via a single action-switched tool (project-flow).\n\n" +
		"Read/create:\n" +
		"- { action:'create', projectId, title, description?, priority?, impactScope? } — new requirement at status='found' + write its Intent section to `{workspace}/docs/requirements/{id}.md` (a FILE, never the DB). Emits `requirements.create`.\n" +
		"- { action:'list', projectId?, status?, priority? } — list requirements (filterable).\n" +
		"- { action:'get', id } — one requirement record (messages excluded).\n\n" +
		"Transitions (each = transitionStatus + write doc section + emit a named hook signal `requirements.<signal>`):\n" +
		"- { action:'pick', id, summary? }        — found→discuss, writes Summary section. Emits `requirements.picked`.\n" +
		"- { action:'ready', id }                  — discuss→ready. Emits `requirements.ready` (default delivery-work trigger).\n" +
		"- { action:'plan', id, plan? }            — ready→plan, writes Plan section + creates the feature worktree. Emits `requirements.planned`.\n" +
		"- { action:'startBuild', id }             — plan→build. Emits `requirements.buildStarted`.\n" +
		"- { action:'finishBuild', id, coverage? } — build→verify, writes Coverage section. Emits `requirements.buildFinished`.\n\n" +
		"Compound verify (project-flow §2/§3) — call when the requirement is in 'verify':\n" +
		"- { action:'verify', id, summary? } — BLOCKING. Delegates the PM coverage judgement; on APPROVED drives archivist merge feature→main + verify→closed + writes Decision Log + emits `requirements.verified`; on REJECTED records feedback + returns the requirement to 'build' for rework + writes Decision Log + emits `requirements.rejected`.\n\n" +
		"Illegal transitions return a friendly `Error: ...` with the valid next statuses.",
	meta: {
		category: "project",
		isReadOnly: false,
		isConcurrencySafe: false,
		isDestructive: false,
	},

	inputSchema: flowActionSchema,

	execute: async (input, ctx) => {
		const actions = getFlowActions(ctx);
		if (!actions) {
			return "Error: Flow tool requires ctx.flowActions (inject via agent-service; the shared backend with the REST router)";
		}

		switch (input.action) {
			case "create": {
				const projectId = resolveProjectId(ctx, input);
				if (!projectId) {
					return "Error: projectId is required for action:create (provide it on the call or via the session context bundle)";
				}
				if (!input.title) {
					return "Error: title is required for action:create";
				}
				try {
					const { requirement: req, docNote } = actions.create({
						projectId,
						title: input.title,
						description: input.description,
						priority: input.priority,
						impactScope: input.impactScope,
						// RequirementSource is typed "analyst" | "user"; the agent
						// path uses "analyst" (the agent-vs-analyst collapse is
						// deferred). REST/UI passes "user".
						source: "analyst",
					});
					return `Requirement created: ${req.id}\nTitle: ${req.title}\nStatus: ${req.status}${docNote}`;
				} catch (err) {
					return `Error: create failed — ${(err as Error).message}`;
				}
			}

			case "list": {
				const result = actions.list({
					projectId: input.projectId,
					status: input.status,
					priority: input.priority,
				});
				return JSON.stringify(result);
			}

			case "get": {
				if (!input.id) {
					return "Error: id is required for action:get";
				}
				const result = actions.get(input.id);
				if (!result) {
					return `Error: Requirement not found: ${input.id}`;
				}
				return JSON.stringify(result);
			}

			case "pick":
			case "ready":
			case "plan":
			case "startBuild":
			case "finishBuild": {
				if (!input.id) {
					return `Error: id is required for action:${input.action}`;
				}
				const projectId = resolveProjectId(ctx, input);
				const sectionBody =
					input.action === "pick" ? input.summary :
					input.action === "plan" ? input.plan :
					input.action === "finishBuild" ? input.coverage :
					undefined;

				try {
					const { requirement: updated, docNote, worktreeNote } = actions.transition({
						id: input.id,
						action: input.action,
						body: sectionBody,
						projectId,
					});

					// F3: plan also creates the feature worktree. The shared
					// backend kicked off createFeatureWorktree fire-and-forget;
					// for the runtime plan action we AWAIT it so the lead lands
					// in the worktree for the follow-up startBuild / Orchestrate.
					// The created path is surfaced on ctx.featureWorkspace.
					let runtimeWorktreeNote = worktreeNote;
					if (input.action === "plan") {
						const gi = (ctx as any)?.gitIntegration;
						const ws = resolveWorkspaceDir(ctx);
						if (gi && ws) {
							try {
								const wt = await gi.createFeatureWorktree(ws, input.id, projectId);
								if (wt?.ok && wt.worktreePath) {
									(ctx as any).featureWorkspace = wt.worktreePath;
									runtimeWorktreeNote = ` (worktree: ${wt.worktreePath})`;
								} else if (wt?.branch) {
									runtimeWorktreeNote = ` (worktree fallback: main workspace)`;
								}
							} catch (err) {
								runtimeWorktreeNote = ` (worktree creation failed: ${(err as Error).message})`;
							}
						}
					}

					return `Requirement ${input.action}: ${updated.id} → ${updated.status}${docNote}${runtimeWorktreeNote}`;
				} catch (err) {
					const e = err as Error & { validTargets?: string[] };
					const targets = e.validTargets?.length ? ` Valid next: ${e.validTargets.join(", ")}` : "";
					return `Error: ${input.action} transition failed — ${e.message}.${targets}`;
				}
			}

			case "verify": {
				// F3 compound action (project-flow §2/§3). The runtime path
				// DELEGATES the PM coverage judgement (blocking await). The
				// REST/UI path supplies the verdict directly (no delegation) —
				// that variant lives in the requirement-router, not here.
				if (!input.id) {
					return "Error: id is required for action:verify";
				}
				if (!(ctx as any)?.delegateTask) {
					return "Error: delegateTask not available — cannot invoke PM";
				}
				const req = actions.get(input.id);
				if (!req) return `Error: requirement not found: ${input.id}`;
				const targetAgentId = req.reviewerAgentId ?? req.createdByAgentId;
				if (!targetAgentId) {
					return (
						"Error: requirement has no reviewerAgentId / createdByAgentId — cannot resolve PM " +
						"for coverage judgement (PM is addressed by req-recorded agentId, not by role scan)."
					);
				}
				const projectId = resolveProjectId(ctx, input, req.projectId);
				try {
					const result = await actions.verify({
						id: input.id,
						projectId,
						source: {
							kind: "delegate",
							targetAgentId,
							summary: input.summary,
							delegateTask: (ctx as any).delegateTask,
						},
					});
					return result.text;
				} catch (err) {
					return `Error: verify failed — ${(err as Error).message}`;
				}
			}

			default:
				return `Error: unknown action: ${(input as any).action}`;
		}
	},
});
