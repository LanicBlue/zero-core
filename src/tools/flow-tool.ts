// Flow action tool (project-flow F1) — requirement → code-merge unified flow
//
// # File spec (tool-decoupling sub-4 迁新签名)
//
// ## Core
// F4 stage of the project-flow redesign (see
// docs/design/project-flow/project-flow.md §2/§4). One action-switched tool
// `Flow`. The transition + write-doc-section + emit-signal logic and the
// compound verify logic are SHARED with the REST requirement-router via
// `flow-actions.ts` (src/server/flow-actions.ts) — callerCtx.flowActions is
// the shared backend (injected by agent-service, mirroring requirementStore).
// This file is now a thin adapter: it resolves the workspace / gitIntegration
// from callerCtx and forwards to callerCtx.flowActions.
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
//   - verify  → COMPOUND: verdict-driven. The caller supplies a coverage
//               verdict (covered/reason); submitCoverageVerdict (APPROVED →
//               archivist merge + verify→closed + emit `verified`; REJECTED →
//               rework verify→build + emit `rejected`) + write Decision Log.
//               The tool NEVER picks or invokes a reviewer — who reviews is
//               external (user via REST, or a reviewing agent via work that
//               supplies the verdict itself).
//
// ## Naming
// `Flow` covers the requirement→code-merge flow as one action tool. Capability
// lives in the tool; whether an action is exposed to an agent vs. only to a
// user is a toolPolicy concern, not a structural one.
//
// ## Inputs
// - callerCtx.flowActions (FlowActions — injected by agent-service; the shared
//   backend with the REST router). Falls back gracefully when absent.
// - callerCtx.contextBundle.workspaceDir OR callerCtx.workingDir (resolved
//   workspace for the docs/requirements/{id}.md write).
// - callerCtx.gitIntegration (runtime-only handle surfaced by agent-service;
//   plan worktree; verify's pmService merge is inside flowActions).
//
// ## Output
// - ToolResult{data:{text}};format(r) = r.data.text。

import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { CallerCtx, ToolResult } from "./types.js";
import type { RequirementRecord } from "../shared/types.js";

/**
 * FlowActions backend shape (project-flow F4). Imported as a TYPE-ONLY ref so
 * the runtime layer never imports the server-layer module at runtime — the
 * backend is injected via callerCtx.flowActions (agent-service wiring). Test
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
		source?: "agent" | "user";
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
		// F3 compound action: verify (verdict-driven). The caller supplies a
		// coverage verdict (covered/reason); on APPROVED the tool drives archivist
		// merge + verify→closed + emit `verified`; on REJECTED rework verify→build
		// + emit `rejected`. Who reviews is EXTERNAL to the tool (user via REST,
		// or a reviewing agent via work that supplies the verdict itself) — the
		// tool never delegates or picks a reviewer. See project-flow.md §2/§3.
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
	// finishBuild: Coverage section body.
	// Optional — empty body still creates the section header so the doc
	// structure is present.
	summary: z.string().optional(),
	plan: z.string().optional(),
	coverage: z.string().optional(),
	// verify: the caller (user or reviewing agent) supplies the coverage
	// verdict directly. covered omitted → degrade (status stays in 'verify').
	covered: z.boolean().optional(),
	reason: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the workspace dir for the docs/requirements write. */
function resolveWorkspaceDir(callerCtx: CallerCtx): string | undefined {
	const bundle = callerCtx.contextBundle;
	if (bundle && typeof bundle.workspaceDir === "string" && bundle.workspaceDir) {
		return bundle.workspaceDir;
	}
	const wd = callerCtx.workingDir;
	return typeof wd === "string" && wd ? wd : undefined;
}

/** Resolve the projectId from callerCtx bundle or input. */
function resolveProjectId(callerCtx: CallerCtx, input: any, fallback?: string): string | undefined {
	const fromBundle = callerCtx.contextBundle?.projectId ?? callerCtx.projectId;
	return fromBundle ?? input.projectId ?? fallback;
}

/**
 * Fetch the FlowActions backend for this callerCtx. The backend is injected by
 * agent-service via callerCtx.flowActions (single source — the REST router uses
 * the same object). Test harnesses that exercised the legacy direct-store path
 * must now wire callerCtx.flowActions themselves (see f1/f2/f3 tests).
 */
function getFlowActions(callerCtx: CallerCtx): FlowActionsLike | undefined {
	return (callerCtx.flowActions as FlowActionsLike | undefined) ?? undefined;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

interface FlowData {
	/** LLM-facing text (per-action: created/transition/verify/list/get/error). */
	text: string;
}

export const flowTool = buildTool({
	name: "Flow",
	description:
		"Requirement → code-merge unified flow tool. create/list/get + transition actions (pick/ready/plan/startBuild/finishBuild) + compound verify (verdict-driven close/rework + merge).",
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
		"Compound verify (project-flow §2/§3) — call when the requirement is in 'verify'. Verdict-driven: YOU supply the coverage verdict.\n" +
		"- { action:'verify', id, covered, reason? } — drives the compound close/rework. covered=true (APPROVED): archivist merge feature→main + verify→closed + writes Decision Log + emits `requirements.verified`. covered=false (REJECTED): records feedback + returns the requirement to 'build' for rework + writes Decision Log + emits `requirements.rejected`. Omit covered → degrade (status stays in 'verify'; you'll be asked to supply covered/reason).\n" +
		"Who issues the verdict is external to the tool — the user (via UI), or whichever agent work assigns to review (that agent reads the Orchestrate manifest/code, forms the verdict, then calls verify with covered/reason). The tool does NOT delegate or pick a reviewer.\n\n" +
		"Illegal transitions return a friendly `Error: ...` with the valid next statuses.",
	meta: {
		category: "project",
		isReadOnly: false,
		isConcurrencySafe: false,
		isDestructive: false,
		exposable: false,
	},

	inputSchema: flowActionSchema,

	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult<FlowData>> => {
		const actions = getFlowActions(callerCtx);
		if (!actions) {
			// Preserve the pre-sub-4 "Error: ..." soft failure (string return —
			// not a thrown failure). Migrated ok:false would route through
			// PostToolUseFailure, a behavior change; keep ok:true + error text.
			return {
				ok: true,
				data: {
					text: "Error: Flow tool requires ctx.flowActions (inject via agent-service; the shared backend with the REST router)",
				},
			};
		}

		switch (input.action) {
			case "create": {
				const projectId = resolveProjectId(callerCtx, input);
				if (!projectId) {
					return { ok: true, data: { text: "Error: projectId is required for action:create (provide it on the call or via the session context bundle)" } };
				}
				if (!input.title) {
					return { ok: true, data: { text: "Error: title is required for action:create" } };
				}
				try {
					const { requirement: req, docNote } = actions.create({
						projectId,
						title: input.title,
						description: input.description,
						priority: input.priority,
						impactScope: input.impactScope,
						// RequirementSource is typed "agent" | "user"; the agent
						// path uses "agent". REST/UI passes "user".
						source: "agent",
					});
					return { ok: true, data: { text: `Requirement created: ${req.id}\nTitle: ${req.title}\nStatus: ${req.status}${docNote}` } };
				} catch (err) {
					return { ok: true, data: { text: `Error: create failed — ${(err as Error).message}` } };
				}
			}

			case "list": {
				const result = actions.list({
					projectId: input.projectId,
					status: input.status,
					priority: input.priority,
				});
				return { ok: true, data: { text: JSON.stringify(result) } };
			}

			case "get": {
				if (!input.id) {
					return { ok: true, data: { text: "Error: id is required for action:get" } };
				}
				const result = actions.get(input.id);
				if (!result) {
					return { ok: true, data: { text: `Error: Requirement not found: ${input.id}` } };
				}
				return { ok: true, data: { text: JSON.stringify(result) } };
			}

			case "pick":
			case "ready":
			case "plan":
			case "startBuild":
			case "finishBuild": {
				if (!input.id) {
					return { ok: true, data: { text: `Error: id is required for action:${input.action}` } };
				}
				const projectId = resolveProjectId(callerCtx, input);
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
					// The created path is surfaced on callerCtx.featureWorkspace.
					let runtimeWorktreeNote = worktreeNote;
					if (input.action === "plan") {
						const gi = callerCtx.gitIntegration;
						const ws = resolveWorkspaceDir(callerCtx);
						if (gi && ws) {
							try {
								const wt = await gi.createFeatureWorktree(ws, input.id, projectId);
								if (wt?.ok && wt.worktreePath) {
									callerCtx.featureWorkspace = wt.worktreePath;
									runtimeWorktreeNote = ` (worktree: ${wt.worktreePath})`;
								} else if (wt?.branch) {
									runtimeWorktreeNote = ` (worktree fallback: main workspace)`;
								}
							} catch (err) {
								runtimeWorktreeNote = ` (worktree creation failed: ${(err as Error).message})`;
							}
						}
					}

					return { ok: true, data: { text: `Requirement ${input.action}: ${updated.id} → ${updated.status}${docNote}${runtimeWorktreeNote}` } };
				} catch (err) {
					const e = err as Error & { validTargets?: string[] };
					const targets = e.validTargets?.length ? ` Valid next: ${e.validTargets.join(", ")}` : "";
					return { ok: true, data: { text: `Error: ${input.action} transition failed — ${e.message}.${targets}` } };
				}
			}

			case "verify": {
				// F3 compound action (project-flow §2/§3), verdict-driven. The
				// CALLER (the reviewing agent, whose work assigned it the review)
				// supplies the coverage verdict; the tool drives the compound
				// close/rework. The tool does NOT delegate or pick a reviewer —
				// that's external (work config / user). The REST/UI path is the
				// same shape (user supplies the verdict directly).
				if (!input.id) {
					return { ok: true, data: { text: "Error: id is required for action:verify" } };
				}
				const req = actions.get(input.id);
				if (!req) return { ok: true, data: { text: `Error: requirement not found: ${input.id}` } };
				const projectId = resolveProjectId(callerCtx, input, req.projectId);
				const source =
					input.covered === undefined
						? { kind: "none" as const }
						: { kind: "verdict" as const, covered: input.covered, reason: input.reason };
				try {
					const result = await actions.verify({ id: input.id, projectId, source });
					return { ok: true, data: { text: result.text } };
				} catch (err) {
					return { ok: true, data: { text: `Error: verify failed — ${(err as Error).message}` } };
				}
			}

			default:
				return { ok: true, data: { text: `Error: unknown action: ${(input as any).action}` } };
		}
	},
	format: (result: ToolResult): string => {
		if (!result.ok) {
			return result.error ?? "Flow failed.";
		}
		return (result.data as FlowData)?.text ?? "";
	},
});
