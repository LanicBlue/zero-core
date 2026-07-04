// Flow action tool (project-flow F1) — requirement → code-merge unified flow
//
// # File spec
//
// ## Core
// F2 stage of the project-flow redesign (see
// docs/design/project-flow/project-flow.md §2/§4). One action-switched tool
// `Flow`. F1 added create/list/get; F2 added the simple transition actions
// (pick/ready/plan/startBuild/finishBuild), each = transitionStatus + write a
// doc section (Summary/Plan/Coverage) + emit a named hook signal
// (`requirements.<signal>`). F3 adds the compound `verify` action (delegate PM
// coverage judgement + merge + Decision Log + verified/rejected signal) +
// worktree creation on plan + the central worktree path. Old
// CreateRequirement / CreateRequirementWithDoc / verify are retired (F3) —
// Flow is the single entry point.
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
//   - plan    → ready→plan + write Plan section + create feature worktree +
//               emit `requirements.planned`.
//   - startBuild → plan→build + emit `requirements.buildStarted`.
//   - finishBuild → build→verify + write Coverage section + emit `requirements.buildFinished`.
//   - verify  → COMPOUND: delegate PM coverage judgement + submitCoverageVerdict
//               (APPROVED → archivist merge + verify→closed + emit `verified`;
//                REJECTED → rework verify→build + emit `rejected`) + write
//               Decision Log. Blocking (execute awaits delegateTask).
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
	section: "Summary" | "Plan" | "Coverage" | "Decision Log",
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

				// F3: plan also creates the feature worktree (project-flow §4.2).
				// Reuses GitIntegration.createFeatureWorktree (central path under
				// ~/.zero-core/projects/{project}/{req-shortId}/ — see git-
				// integration.ts). Non-blocking: on failure we fall back to the
				// main workspace; the transition + doc + signal still succeed.
				// The created worktree path is surfaced on ctx.featureWorkspace
				// so a follow-up startBuild / Orchestrate picks it up as cwd.
				let worktreeNote = "";
				if (input.action === "plan") {
					const gi = (ctx as any)?.gitIntegration;
					const ws = resolveWorkspaceDir(ctx);
					const projectId =
						(ctx as any)?.contextBundle?.projectId ?? (ctx as any)?.projectId ?? input.projectId;
					if (gi && ws) {
						try {
							const wt = await gi.createFeatureWorktree(ws, input.id, projectId);
							if (wt?.ok && wt.worktreePath) {
								(ctx as any).featureWorkspace = wt.worktreePath;
								worktreeNote = ` (worktree: ${wt.worktreePath})`;
							} else if (wt?.branch) {
								worktreeNote = ` (worktree fallback: main workspace)`;
							}
						} catch (err) {
							worktreeNote = ` (worktree creation failed: ${(err as Error).message})`;
						}
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

				return `Requirement ${input.action}: ${updated.id} → ${updated.status}${docNote}${worktreeNote}`;
			}

			case "verify": {
				// F3 compound action (project-flow §2/§3). Mirrors the legacy
				// verify-tool semantics, hoisted into Flow as the single
				// requirement-flow entry point. Blocking: execute awaits
				// delegateTask (the agent-loop already awaits the tool, so this
				// is a true hang, not busy-wait — same model as Orchestrate's
				// confirm gate).
				//
				// On entry the requirement is already in "verify" (finishBuild
				// transitioned build→verify). verify does NOT re-set status; it
				// delegates the PM coverage judgement, then drives the close or
				// rework transition + emits the named signal + writes the
				// Decision Log section.
				return await executeVerify(input as any, ctx);
			}

			default:
				return `Error: unknown action: ${(input as any).action}`;
		}
	},
});

// ---------------------------------------------------------------------------
// F3 compound action: verify (project-flow §2/§3)
// ---------------------------------------------------------------------------
//
// Hoisted from the legacy verify-tool. The requirement is already in "verify"
// on entry (finishBuild transitioned build→verify). verify does:
//   1. resolve PM agent by req.reviewerAgentId / createdByAgentId;
//   2. delegateTask the PM coverage judgement (BLOCKING await);
//   3. parseVerdict → APPROVED | REJECTED;
//   4. PmService.submitCoverageVerdict — APPROVED drives archivist
//      mergeFeatureToMain + verify→closed; REJECTED records feedback;
//   5. emit named signal: APPROVED → requirements.verified; REJECTED →
//      requirements.rejected (and transition verify→build so the delivery
//      work can re-run plan→finishBuild→verify with the feedback);
//   6. write Decision Log section to the requirement doc (file, not DB).
//
// Degrade paths preserved from verify-tool:
//   - PM dispatch failure  → status stays in verify; tell caller to retry.
//   - merge failure        → status stays in verify (archivist cron retries).
//   - pmService not wired  → verdict text returned; no merge/close.
// None of these silently advance status.

interface ParsedVerdict {
	approved: boolean;
	reason: string;
}

/**
 * Parse the PM verdict line. Liberal — defaults to REJECTED with the raw
 * output as the reason if the line is missing/malformed (fail-safe: a
 * confused PM output is treated as a gap, not silent approval).
 */
function parseVerdict(raw: string): ParsedVerdict {
	const text = (raw ?? "").trim();
	const m = text.match(/VERDICT:\s*(APPROVED|REJECTED)\s*[—\-:]\s*([^\n]*)/i);
	if (m) {
		const approved = /^APPROVED$/i.test(m[1]);
		return { approved, reason: m[2].trim() || "(no reason given)" };
	}
	// Fallback heuristics — PM didn't follow the format. Be conservative.
	if (/\bAPPROV(?:ED|ING)\b/i.test(text) && !/\bREJECT/i.test(text)) {
		return { approved: true, reason: "(PM output mentioned approval — format mismatch)" };
	}
	return {
		approved: false,
		reason: text.slice(0, 300) || "(PM output unparseable; treating as rejected)",
	};
}

/** Compose the Decision Log body from the verdict + outcome. */
function decisionLogBody(verdict: ParsedVerdict, mergeRef?: string, finalStatus?: string): string {
	const head = verdict.approved
		? `APPROVED — ${verdict.reason}`
		: `REJECTED — ${verdict.reason}`;
	const tail: string[] = [];
	if (mergeRef) tail.push(`Merged feature→main (ref ${mergeRef}).`);
	if (finalStatus) tail.push(`Final status: ${finalStatus}.`);
	if (!verdict.approved) {
		tail.push("Rework: requirement returned to 'build' for revision. Revise the plan and re-submit finishBuild → verify when ready.");
	}
	return [head, ...tail].join("\n");
}

async function executeVerify(
	input: { id: string; summary?: string },
	ctx: any,
): Promise<string> {
	const store = ctx?.requirementStore;
	if (!store) return "Error: Flow tool requires ctx.requirementStore";
	if (!ctx.delegateTask) return "Error: delegateTask not available — cannot invoke PM";

	const req = store.get(input.id);
	if (!req) return `Error: requirement not found: ${input.id}`;

	// Requirement must be in "verify" to be judged. finishBuild puts it there;
	// re-submits after a degraded PM dispatch also arrive in "verify".
	if (req.status !== "verify") {
		return `Error: verify requires status='verify' (got '${req.status}'). Use finishBuild first.`;
	}

	// 1. Resolve the PM agent by req-recorded agentId (project-flow §6 /
	//    verify-tool §4.5). Prefer reviewerAgentId, then createdByAgentId.
	const targetAgentId = req.reviewerAgentId ?? req.createdByAgentId;
	if (!targetAgentId) {
		return (
			"Error: requirement has no reviewerAgentId / createdByAgentId — cannot resolve PM " +
			"for coverage judgement (PM is addressed by req-recorded agentId, not by role scan)."
		);
	}

	// 2. Dispatch to PM via delegateTask. Blocking — agent-loop awaits the
	//    tool result. The PM session inherits this caller's bundle.
	const pmTask =
		`Product-coverage judgement for requirement ${input.id}.\n` +
		`Title: ${req.title}\n` +
		`Intent: ${req.description ?? "(see requirement doc)"}\n` +
		`Lead summary: ${input.summary ?? "(none)"}\n\n` +
		`Read the latest Orchestrate manifest for this requirement, then judge whether the ` +
		`changes + tests cover the original intent at PRODUCT granularity (NOT technical ` +
		`acceptance — that lived in the flow).\n\n` +
		`Respond with EXACTLY one line in the form:\n` +
		`VERDICT: APPROVED|REJECTED — <one-sentence reason>\n` +
		`(REJECTED must cite the specific gap; APPROVED must confirm what's covered.)`;

	let pmOutput: string;
	try {
		pmOutput = await ctx.delegateTask(pmTask, { targetAgentId });
	} catch (err: any) {
		// PM dispatch failure → degrade. Do NOT advance status; lead can retry.
		return `PM coverage dispatch failed: ${err.message ?? String(err)}\n\nThe requirement stays in 'verify'; re-submit verify to retry, or your cron fallback will wake you.`;
	}

	// 3. Parse verdict.
	const verdict = parseVerdict(pmOutput);

	// 4. Drive PmService.submitCoverageVerdict (stamps reviewerAgentId, records
	//    the verdict as a status_change audit message, on APPROVED triggers
	//    archivist mergeFeatureToMain + verify→closed).
	const pmSvc: any = ctx?.pmService;
	let mergeRef: string | undefined;
	let finalStatus: string = req.status;
	let reworked = false;

	if (pmSvc?.submitCoverageVerdict) {
		try {
			const outcome = await pmSvc.submitCoverageVerdict(
				input.id,
				{ covered: verdict.approved, reason: verdict.reason },
				{ reviewerAgentId: targetAgentId },
			);
			finalStatus = outcome?.finalStatus ?? finalStatus;
			if (verdict.approved) {
				if (outcome?.merge?.ok) {
					mergeRef = outcome.merge.ref;
				} else {
					// Merge failed or archivist not wired: status stays in verify.
					const why = outcome?.merge?.ok === false ? "FAILED" : "not wired";
					const detail = outcome?.merge?.error ?? "no archivist";
					const body = decisionLogBody(verdict, undefined, finalStatus) +
						`\nArchivist merge ${why} (${detail}). Requirement stays in 'verify'; archivist cron will retry.`;
					writeDecisionLog(ctx, input.id, body);
					emitVerifySignal(ctx, input.id, store.get(input.id), "verified");
					return (
						`PM APPROVED — ${verdict.reason}\n\n` +
						`Archivist merge ${why} (${detail}). Requirement stays in 'verify'; ` +
						`archivist cron will retry the merge. You can re-submit verify if needed.`
					);
				}
			}
		} catch (err: any) {
			// submitCoverageVerdict threw — degrade. Verdict text is still
			// returned so the loop isn't stuck.
			const body = decisionLogBody(verdict, undefined, finalStatus) +
				`\nsubmitCoverageVerdict failed: ${err.message ?? String(err)}. Requirement stays in 'verify'.`;
			writeDecisionLog(ctx, input.id, body);
			emitVerifySignal(ctx, input.id, store.get(input.id), verdict.approved ? "verified" : "rejected");
			return (
				`PM verdict: ${verdict.approved ? "APPROVED" : "REJECTED"} — ${verdict.reason}\n\n` +
				`submitCoverageVerdict failed: ${err.message ?? String(err)}. ` +
				`Requirement stays in 'verify'; re-submit or wait for cron fallback.\n\n` +
				`(Original PM output follows.)\n\n${pmOutput.slice(0, 1500)}`
			);
		}
	}
	// else: pmService not wired (e.g. legacy ctx). Verdict text returned below;
	// no merge/close. Status stays in "verify".

	// 5. Rework transition + signal emit + Decision Log.
	if (!verdict.approved) {
		// project-flow §2/§8: rejected → rework verify→build (triggeredBy lead,
		// the only legal verify→ non-closed edge). The delivery work's next
		// fire reads the Decision Log feedback and re-runs plan→finishBuild→
		// verify. Best-effort: a transition failure must not lose the verdict.
		try {
			store.transitionStatus(input.id, "build", "lead", "Flow.verify rework (PM rejected)");
			finalStatus = "build";
			reworked = true;
		} catch (err) {
			// Stays in verify; the signal + Decision Log still carry the verdict.
		}
	}

	writeDecisionLog(ctx, input.id, decisionLogBody(verdict, mergeRef, finalStatus));
	const updatedRec = store.get(input.id);
	emitVerifySignal(ctx, input.id, updatedRec, verdict.approved ? "verified" : "rejected");

	// 6. Compose the return text (mirrors verify-tool's wording so callers /
	//    tests that matched on it keep working).
	if (verdict.approved) {
		if (mergeRef) {
			return (
				`PM APPROVED — ${verdict.reason}\n\n` +
				`Archivist merged feature→main (ref ${mergeRef}); requirement status → ${finalStatus}. Delivery complete.`
			);
		}
		// pmService not wired.
		return (
			`PM APPROVED — ${verdict.reason}\n\n` +
			`(pmService not wired on this ctx — end-to-end close skipped. Requirement is in 'verify'; ` +
			`PM/archivist cron will pick it up.)`
		);
	}
	return (
		`PM REJECTED — ${verdict.reason}\n\n` +
		`Feedback recorded on the requirement.${reworked ? " Status returned to 'build' for revision." : " Status stays in 'verify'."} ` +
		`Revise your plan and re-submit finishBuild → verify when ready.\n\n` +
		`(Original PM output follows.)\n\n${pmOutput.slice(0, 1500)}`
	);
}

/** Write the Decision Log section (file, not DB). Best-effort. */
function writeDecisionLog(ctx: any, id: string, body: string): void {
	const ws = resolveWorkspaceDir(ctx);
	if (!ws) return;
	try {
		writeDocSection(ws, id, "Decision Log", body);
	} catch {
		// Best-effort: verdict still returned to caller + signal still emitted.
	}
}

/** Emit the named verify signal (requirements.verified | requirements.rejected). */
function emitVerifySignal(ctx: any, id: string, record: unknown, signal: "verified" | "rejected"): void {
	const emit = ctx?.emitTransition as EmitTransitionFn | undefined;
	if (!emit) return;
	try {
		emit("requirements", signal, id, record);
	} catch {
		// Best-effort.
	}
}
