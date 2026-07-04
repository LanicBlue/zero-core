// Flow action tool (project-flow F1) — requirement → code-merge unified flow
//
// # File spec
//
// ## Core
// F2 stage of the project-flow redesign (see
// docs/design/project-flow/project-flow.md §2/§4). One action-switched tool
// `Flow`. F1 added create/list/get; F2 adds the simple transition actions
// (pick/ready/plan/startBuild/finishBuild), each = transitionStatus + write a
// doc section (Summary/Plan/Coverage) + emit a named hook signal
// (`requirements.<signal>`). F3 will add the compound `verify` action +
// worktree creation + default work reconfiguration + old-tool replacement.
//
// Stage scope:
//   - create  → write RequirementRecord at status="found" AND write the
//               requirement document's Intent section to
//               `{workspace}/docs/requirements/{id}.md` (server-side fs; the
//               doc is a FILE, never enters the DB). The natural
//               `requirements.create` op (emitted by SqliteStore → hub on every
//               store.create) doubles as the `created` signal — no extra emit.
//   - list    → filter by projectId / status / priority.
//   - get     → return a single record (record only; messages excluded).
//   - pick    → found→discuss + write Summary section + emit `requirements.picked`.
//   - ready   → discuss→ready + emit `requirements.ready`.
//   - plan    → ready→plan + write Plan section + emit `requirements.planned`.
//   - startBuild → plan→build + emit `requirements.buildStarted`.
//   - finishBuild → build→verify + write Coverage section + emit `requirements.buildFinished`.
//
// Old CreateRequirement / CreateRequirementWithDoc / verify stay registered in
// parallel — F2 does NOT replace them.
//
// ## Naming
// `Flow` covers the requirement→code-merge flow as one action tool. Capability
// lives in the tool; whether an action is exposed to an agent vs. only to a
// user is a toolPolicy concern, not a structural one.
//
// ## Inputs
// - ctx.requirementStore (RequirementStore — required; tool stays gated off
//   otherwise via CONDITIONAL_TOOLS).
// - ctx.contextBundle.workspaceDir OR ctx.workingDir (resolved workspace for
//   the docs/requirements/{id}.md write).
//
// ## Output
// - export const flowTool (buildTool result).
//

import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildTool } from "./tool-factory.js";
import type { RequirementRecord, RequirementStatus } from "../../shared/types.js";

/**
 * Injected named-signal emitter (project-flow F2). The runtime layer must NOT
 * import the server-layer data-change-hub (conventions.md), so the server
 * injects this handle via ctx (mirroring ctx.requirementStore). Signature
 * matches data-change-hub.emitTransition(collection, signal, id, record?).
 * When absent, transitions still succeed but no hook signal fires (degraded).
 */
type EmitTransitionFn = (collection: string, signal: string, id: string, record?: unknown) => void;

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
		// emit a named hook signal). verify is a compound action deferred to F3.
		"pick", "ready", "plan", "startBuild", "finishBuild",
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
	// finishBuild: Coverage section body. Optional — empty body still creates the
	// section header so the doc structure is present.
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

/** Build the absolute path of a requirement doc (file, lives under docs/). */
function requirementDocPath(workspaceDir: string, id: string): string {
	return join(workspaceDir, "docs", "requirements", `${id}.md`);
}

/** Write the Intent section to the requirement doc (create action side effect). */
function writeIntentDoc(workspaceDir: string, req: RequirementRecord): void {
	const absPath = requirementDocPath(workspaceDir, req.id);
	mkdirSync(dirname(absPath), { recursive: true });
	const title = req.title ?? "(untitled)";
	const intent = req.description?.trim() ?? "";
	const body =
		`# ${title}\n\n` +
		`> Requirement: ${req.id} · status: ${req.status}${req.priority ? ` · priority: ${req.priority}` : ""}\n\n` +
		`## Intent\n\n${intent || "(no description provided)"}\n`;
	writeFileSync(absPath, body, "utf-8");
}

// ---------------------------------------------------------------------------
// Doc section writer (F2) — replace or append a `## <Section>` block
// ---------------------------------------------------------------------------

/**
 * Replace the `## <Section>` block in the requirement doc, or append it if
 * absent. Section boundary = from `## <Section>` to the next `## ` line or EOF.
 * The doc is a FILE (project-flow §4); never enters the DB. If the file does
 * not exist yet (edge case — pick before create wrote Intent), it is created
 * with a minimal header. Best-effort: caller surfaces errors.
 */
function writeDocSection(
	workspaceDir: string,
	id: string,
	section: "Summary" | "Plan" | "Coverage",
	body: string,
): void {
	const absPath = requirementDocPath(workspaceDir, id);
	mkdirSync(dirname(absPath), { recursive: true });

	let text = "";
	if (existsSync(absPath)) {
		text = readFileSync(absPath, "utf-8");
	} else {
		// Minimal header so the file is well-formed even if create's Intent
		// write was skipped (e.g. degraded workspace at create time).
		text = `# Requirement ${id}\n\n`;
	}

	const header = `## ${section}`;
	const lines = text.split(/\r?\n/);
	const startIdx = lines.findIndex((l) => l.trim() === header);

	let next: string[];
	if (startIdx === -1) {
		// Append a new section. Ensure exactly one blank line before the header.
		next = [...lines];
		// Drop trailing empties, then re-add one blank line before the header.
		while (next.length > 0 && next[next.length - 1].trim() === "") next.pop();
		next.push("", header, "", (body.trim() || "(empty)"), "");
	} else {
		// Replace existing: find the next `## ` line or EOF.
		let endIdx = lines.length;
		for (let i = startIdx + 1; i < lines.length; i++) {
			if (/^## /.test(lines[i])) { endIdx = i; break; }
		}
		next = [
			...lines.slice(0, startIdx),
			header,
			"",
			(body.trim() || "(empty)"),
			"", // blank separator before next section / EOF
			...lines.slice(endIdx),
		];
	}

	writeFileSync(absPath, next.join("\n"), "utf-8");
}

// ---------------------------------------------------------------------------
// Transition action table (F2) — maps each action to its (targetStatus,
// triggeredBy, signal, optional section). See requirement-state-machine for
// the legal from→to edges and the required triggeredBy role per edge.
// ---------------------------------------------------------------------------

interface TransitionSpec {
	target: RequirementStatus;
	triggeredBy: "analyst" | "user" | "lead" | "system";
	signal: string;
	/** Section to write when set; body comes from input[<lowercase section>]. */
	section?: "Summary" | "Plan" | "Coverage";
}

const TRANSITIONS: Record<"pick" | "ready" | "plan" | "startBuild" | "finishBuild", TransitionSpec> = {
	// found → discuss (analyst|user allowed; Flow uses analyst so an agent can self-drive).
	pick:        { target: "discuss", triggeredBy: "analyst", signal: "picked",         section: "Summary" },
	// discuss → ready (user only per state machine).
	ready:       { target: "ready",   triggeredBy: "user",    signal: "ready" },
	// ready → plan (lead only).
	plan:        { target: "plan",    triggeredBy: "lead",    signal: "planned",        section: "Plan" },
	// plan → build (lead only).
	startBuild:  { target: "build",   triggeredBy: "lead",    signal: "buildStarted" },
	// build → verify (system only).
	finishBuild: { target: "verify",  triggeredBy: "system",  signal: "buildFinished",  section: "Coverage" },
};

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const flowTool = buildTool({
	name: "Flow",
	description:
		"Requirement → code-merge unified flow tool. create/list/get + F2 transition actions (pick/ready/plan/startBuild/finishBuild).",
	prompt:
		"Manage the project requirement flow via a single action-switched tool (project-flow).\n\n" +
		"Read/create:\n" +
		"- { action:'create', projectId, title, description?, priority?, impactScope? } — new requirement at status='found' + write its Intent section to `{workspace}/docs/requirements/{id}.md` (a FILE, never the DB). Emits `requirements.create`.\n" +
		"- { action:'list', projectId?, status?, priority? } — list requirements (filterable).\n" +
		"- { action:'get', id } — one requirement record (messages excluded).\n\n" +
		"F2 transitions (each = transitionStatus + write doc section + emit a named hook signal `requirements.<signal>`):\n" +
		"- { action:'pick', id, summary? }        — found→discuss, writes Summary section. Emits `requirements.picked`.\n" +
		"- { action:'ready', id }                  — discuss→ready. Emits `requirements.ready` (default delivery-work trigger).\n" +
		"- { action:'plan', id, plan? }            — ready→plan, writes Plan section. Emits `requirements.planned`. (worktree creation is F3.)\n" +
		"- { action:'startBuild', id }             — plan→build. Emits `requirements.buildStarted`.\n" +
		"- { action:'finishBuild', id, coverage? } — build→verify, writes Coverage section. Emits `requirements.buildFinished`.\n\n" +
		"Illegal transitions return a friendly `Error: ...` with the valid next statuses. verify (compound) is F3.",
	meta: {
		category: "management",
		isReadOnly: false,
		isConcurrencySafe: false,
		isDestructive: false,
	},

	inputSchema: flowActionSchema,

	execute: async (input, ctx) => {
		const store = (ctx as any)?.requirementStore;
		if (!store) {
			return "Error: Flow tool requires ctx.requirementStore";
		}

		switch (input.action) {
			case "create": {
				const projectId =
					(ctx as any)?.contextBundle?.projectId ?? (ctx as any)?.projectId ?? input.projectId;
				if (!projectId) {
					return "Error: projectId is required for action:create (provide it on the call or via the session context bundle)";
				}
				if (!input.title) {
					return "Error: title is required for action:create";
				}
				const priority = input.priority ?? "normal";
				// RequirementSource is typed "analyst" | "user"; the project-flow
				// plan suggests source:"agent" but that fails type gates and the
				// status-machine history derivation rule in RequirementStore
				// (input.source === "user" ? "user" : "analyst"). Use "analyst"
				// for now; the agent-vs-analyst collapse is deferred to F3.
				const source = "analyst" as const;
				const reviewer = "analyst" as const;

				const req = store.create({
					projectId,
					title: input.title,
					description: input.description,
					status: "found",
					source,
					priority,
					impactScope: input.impactScope,
					reviewer,
				}) as RequirementRecord;

				// Write the Intent section of the requirement doc to the workspace
				// (server-side fs; the doc is a FILE and never enters the DB).
				const ws = resolveWorkspaceDir(ctx);
				if (ws) {
					try {
						writeIntentDoc(ws, req);
					} catch (err) {
						// Best-effort: record creation must succeed even if the doc
						// write fails (workspace unresolvable / disk error).
						return `Requirement created: ${req.id} (doc write failed: ${(err as Error).message})\nTitle: ${req.title}\nStatus: ${req.status}`;
					}
				}

				return `Requirement created: ${req.id}\nTitle: ${req.title}\nStatus: ${req.status}`;
			}

			case "list": {
				const result = store.list({
					projectId: input.projectId,
					status: input.status,
					priority: input.priority,
				}) as RequirementRecord[];
				return JSON.stringify(result);
			}

			case "get": {
				if (!input.id) {
					return "Error: id is required for action:get";
				}
				const result = store.get(input.id) as RequirementRecord | undefined;
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
				const spec = TRANSITIONS[input.action as keyof typeof TRANSITIONS];

				// transitionStatus enforces the state machine; on an illegal
				// from→to it throws with the validTargets attached.
				let updated: RequirementRecord;
				try {
					const res = store.transitionStatus(
						input.id,
						spec.target,
						spec.triggeredBy,
						`Flow.${input.action}`,
					);
					updated = res.requirement;
				} catch (err) {
					const e = err as Error & { validTargets?: RequirementStatus[] };
					const targets = e.validTargets?.length ? ` Valid next: ${e.validTargets.join(", ")}` : "";
					return `Error: ${input.action} transition failed — ${e.message}.${targets}`;
				}

				// Side effect: write the doc section (file, not DB) when the
				// action carries one. Best-effort; transition must succeed even
				// if the doc write fails.
				let docNote = "";
				if (spec.section) {
					const body = (input as any)[spec.section.toLowerCase()] as string | undefined;
					const ws = resolveWorkspaceDir(ctx);
					if (ws) {
						try {
							writeDocSection(ws, input.id, spec.section, body ?? "");
						} catch (err) {
							docNote = ` (doc section write failed: ${(err as Error).message})`;
						}
					} else {
						docNote = " (workspace unresolved — doc section not written)";
					}
				}

				// Emit the named hook signal (requirements.<signal>) so
				// ProjectWorkHookManager can fire works subscribed to it (e.g.
				// delivery work on requirements.ready). The emitter is injected
				// via ctx.emitTransition (runtime must not import the hub).
				const emit = (ctx as any)?.emitTransition as EmitTransitionFn | undefined;
				if (emit) {
					try {
						emit("requirements", spec.signal, input.id, updated);
					} catch {
						// Best-effort: a hub emit failure must not undo the
						// transition. The state change is the source of truth.
					}
				}

				return `Requirement ${input.action}: ${updated.id} → ${updated.status}${docNote}`;
			}

			default:
				return `Error: unknown action: ${(input as any).action}`;
		}
	},
});
