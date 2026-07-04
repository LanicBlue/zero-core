// Flow actions — shared backend (project-flow F4)
//
// # File spec
//
// ## Core
// The SINGLE SOURCE for project-flow action effects (project-flow.md §2/§4).
// Each transition action = transitionStatus + write a doc section (file, not
// DB) + emit a named hook signal (`requirements.<signal>`). `verify` is the
// compound action (verdict-driven close or rework + Decision Log + signal).
//
// Two entry points share this code so their behaviour can NEVER drift:
//   - the runtime Flow tool (src/runtime/tools/flow-tool.ts) — driven by a
//     reviewing agent that supplies the coverage verdict itself (its ctx
//     carries flowActions + gitIntegration);
//   - the REST requirement-router (src/server/requirement-router.ts) — driven
//     by the UI (user-confirmation actions; the verdict is supplied directly
//     by the user).
// Both paths are verdict-driven — neither delegates or picks a reviewer.
//
// ## Why a module, not a class method
// ManagementService is the project/agent/cron capability backend; flow actions
// need RequirementStore + a workspace resolver + (optionally) gitIntegration
// and pmService (verdict application + archivist merge). A standalone factory
// keeps the surface small and lets both the REST router and the runtime ctx
// carry the same object without dragging ManagementService into the runtime
// layer.
//
// ## docPath model (project-flow §4)
// The requirement doc is a FILE under `{workspace}/docs/requirements/{id}.md`
// (the F1–F3 path). Legacy docs at `.zero/requirements/{projectId}/{id}.md`
// (pre-F4) are honoured on READ via `requirementDocAbsPath` fallback — the
// `docPath` field on the record is updated opportunistically so new writes
// land in the canonical location.
//
// ## Naming
// `flowActions` — the capability handle surfaced on the runtime ctx (mirrors
// `requirementStore` / `pmService`).
//
// ## Inputs
// - requirementStore (RequirementStore — required).
// - resolveWorkspaceDir(projectId?) — returns the absolute workspace dir for
//   the action's project. The router resolves from the ProjectStore; the
//   runtime resolves from the session context bundle.
// - emitTransition — the data-change-hub emitter (server-layer; the runtime
//   receives it via ctx already, REST calls the hub directly).
// - gitIntegration? — for the `plan` action's feature-worktree side effect.
//   Absent on the REST path (UI confirm doesn't create worktrees; the agent
//   plan action does — the REST path is for transition-only confirms).
// - pmService? — for the `verify` compound close (archivist merge). Absent on
//   the runtime path that supplies a verdict directly (UI).
//
// ## Output
// - createFlowActions(deps) → FlowActions instance.
//

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	RequirementRecord,
	RequirementStatus,
} from "../shared/types.js";
import type { RequirementStore } from "./requirement-store.js";
import type { GitIntegration } from "./git-integration.js";
import type { PmService } from "./pm-service.js";

/** Named-signal emitter — mirrors data-change-hub.emitTransition. */
export type EmitTransitionFn = (
	collection: string,
	signal: string,
	id: string,
	record?: unknown,
) => void;

/** Resolve the absolute workspace dir for a project (or undefined). */
export type WorkspaceResolver = (projectId?: string) => string | undefined;

/**
 * Verdict source for `verify`. The compound body is verdict-driven — the tool
 * NEVER picks or invokes a reviewer (that is external: the user via REST, or
 * whichever agent work assigns to review, supplying a verdict itself).
 *   - { kind: "verdict", covered, reason } — caller (user UI or a reviewing
 *     agent) supplies the coverage verdict directly.
 *   - { kind: "none" } — caller supplied no verdict: degrade (status stays in
 *     verify; returns guidance so the caller knows to supply covered/reason).
 */
export type VerifyVerdictSource =
	| { kind: "verdict"; covered: boolean; reason?: string }
	| { kind: "none" };

export interface FlowActionsDeps {
	requirementStore: RequirementStore;
	resolveWorkspaceDir: WorkspaceResolver;
	emitTransition: EmitTransitionFn;
	/** Optional — only the runtime path supplies it (plan action). */
	gitIntegration?: GitIntegration;
	/** Optional — verify compound close (archivist merge). */
	pmService?: PmService;
}

// ---------------------------------------------------------------------------
// Doc section helpers — the file is the source of truth (project-flow §4)
// ---------------------------------------------------------------------------

/**
 * Canonical doc path: `{workspace}/docs/requirements/{id}.md` (project-flow §4
 * — the doc is a non-hidden file under docs/, agent reads it via file tools,
 * never enters the DB).
 */
export function flowDocPath(workspaceDir: string, id: string): string {
	return join(workspaceDir, "docs", "requirements", `${id}.md`);
}

/**
 * Resolve the on-disk path for an EXISTING doc, honouring the legacy
 * `.zero/requirements/{projectId}/{id}.md` location (pre-F4). Returns the
 * canonical path if neither exists (caller decides whether to create).
 *
 * Migration (F4): old docs were written under `.zero/requirements/{projectId}/`;
 * new docs go to `docs/requirements/`. We do NOT move files automatically
 * (legacy agents may still reference the old path); we just read whichever
 * exists so a requirement seeded before F4 keeps rendering.
 */
export function resolveExistingDocPath(
	workspaceDir: string,
	projectId: string | undefined,
	id: string,
): string {
	const canonical = flowDocPath(workspaceDir, id);
	if (existsSync(canonical)) return canonical;
	if (projectId) {
		const legacy = join(workspaceDir, ".zero", "requirements", projectId, `${id}.md`);
		if (existsSync(legacy)) return legacy;
	}
	return canonical;
}

/** Write the Intent section to the requirement doc (create action side effect). */
function writeIntentDoc(workspaceDir: string, projectId: string | undefined, req: RequirementRecord): void {
	const absPath = flowDocPath(workspaceDir, req.id);
	mkdirSync(dirname(absPath), { recursive: true });
	const title = req.title ?? "(untitled)";
	const intent = req.description?.trim() ?? "";
	const body =
		`# ${title}\n\n` +
		`> Requirement: ${req.id} · status: ${req.status}${req.priority ? ` · priority: ${req.priority}` : ""}\n\n` +
		`## Intent\n\n${intent || "(no description provided)"}\n`;
	writeFileSync(absPath, body, "utf-8");
}

/**
 * Replace the `## <Section>` block in the requirement doc, or append it if
 * absent. Section boundary = from `## <Section>` to the next `## ` line or EOF.
 * The doc is a FILE (project-flow §4); never enters the DB. If the file does
 * not exist yet (edge case — pick before create wrote Intent), it is created
 * with a minimal header. Best-effort: caller surfaces errors.
 *
 * Honours legacy `.zero/requirements/{projectId}/` placement: writes to the
 * existing legacy file if that's where the doc currently lives, so we don't
 * fork the doc into two locations.
 */
export function writeDocSection(
	workspaceDir: string,
	projectId: string | undefined,
	id: string,
	section: "Summary" | "Plan" | "Coverage" | "Decision Log",
	body: string,
): void {
	const absPath = resolveExistingDocPath(workspaceDir, projectId, id);
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
// Transition action table (project-flow §2) — maps each action to its
// (targetStatus, triggeredBy, signal, optional section). See
// requirement-state-machine for the legal from→to edges.
// ---------------------------------------------------------------------------

interface TransitionSpec {
	target: RequirementStatus;
	triggeredBy: "agent" | "user" | "system";
	signal: string;
	/** Section to write when set; body comes from the action input. */
	section?: "Summary" | "Plan" | "Coverage";
}

export const FLOW_TRANSITIONS: Record<"pick" | "ready" | "plan" | "startBuild" | "finishBuild", TransitionSpec> = {
	// found → discuss (agent|user allowed; Flow uses agent so an agent can self-drive).
	pick:        { target: "discuss", triggeredBy: "agent",   signal: "picked",         section: "Summary" },
	// discuss → ready (user only per state machine).
	ready:       { target: "ready",   triggeredBy: "user",    signal: "ready" },
	// ready → plan (agent).
	plan:        { target: "plan",    triggeredBy: "agent",   signal: "planned",        section: "Plan" },
	// plan → build (agent).
	startBuild:  { target: "build",   triggeredBy: "agent",   signal: "buildStarted" },
	// build → verify (system only).
	finishBuild: { target: "verify",  triggeredBy: "system",  signal: "buildFinished",  section: "Coverage" },
};

export type FlowTransitionAction = keyof typeof FLOW_TRANSITIONS;

// ---------------------------------------------------------------------------
// verify compound action — Decision Log composition (verdict-driven)
// ---------------------------------------------------------------------------

export interface ParsedVerdict {
	approved: boolean;
	reason: string;
}

/** Compose the Decision Log body from the verdict + outcome. */
export function decisionLogBody(verdict: ParsedVerdict, mergeRef?: string, finalStatus?: string): string {
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

// ---------------------------------------------------------------------------
// FlowActions — the shared backend object
// ---------------------------------------------------------------------------

export interface CreateActionResult {
	requirement: RequirementRecord;
	/** Best-effort doc-write note (empty when the write succeeded). */
	docNote: string;
}

export interface TransitionActionResult {
	requirement: RequirementRecord;
	docNote: string;
	worktreeNote: string;
}

export interface VerifyActionResult {
	requirement: RequirementRecord;
	text: string;
	/** Whether the close/rework actually advanced the status. */
	applied: boolean;
}

export interface FlowActions {
	create(input: {
		projectId: string;
		title: string;
		description?: string;
		priority?: "low" | "normal" | "high" | "critical";
		impactScope?: string;
		/** RequirementSource-derived author; default "agent" (an agent caller). */
		source?: "agent" | "user";
	}): CreateActionResult;

	list(filter?: { projectId?: string; status?: string; priority?: string }): RequirementRecord[];

	get(id: string): RequirementRecord | undefined;

	transition(input: {
		id: string;
		action: FlowTransitionAction;
		/** Section body when the action carries one (Summary / Plan / Coverage). */
		body?: string;
		/** Optional caller context for the worktree side effect (plan). */
		projectId?: string;
	}): TransitionActionResult;

	verify(input: {
		id: string;
		projectId?: string;
		/** Where the verdict comes from. */
		source: VerifyVerdictSource;
	}): Promise<VerifyActionResult>;
}

/**
 * Build the FlowActions backend. Both the runtime Flow tool (via
 * ctx.flowActions) and the REST requirement-router call the returned object —
 * the transition + write-doc-section + emit-signal logic lives HERE ONLY.
 */
export function createFlowActions(deps: FlowActionsDeps): FlowActions {
	const { requirementStore, resolveWorkspaceDir, emitTransition, gitIntegration, pmService } = deps;

	return {
		create({ projectId, title, description, priority, impactScope, source }) {
			const created = requirementStore.create({
				projectId,
				title,
				description,
				status: "found",
				source: source ?? "agent",
				priority: priority ?? "normal",
				impactScope,
				reviewer: source === "user" ? "user" : "agent",
			} as any) as RequirementRecord;

			// Write the Intent section of the requirement doc to the workspace
			// (server-side fs; the doc is a FILE and never enters the DB).
			let docNote = "";
			const ws = resolveWorkspaceDir(projectId);
			if (ws) {
				try {
					writeIntentDoc(ws, projectId, created);
				} catch (err) {
					docNote = ` (doc write failed: ${(err as Error).message})`;
				}
			} else {
				docNote = " (workspace unresolved — doc not written)";
			}

			// docPath is intentionally NOT stamped on the record here. The hub
			// coalesces by id last-write-wins within a tick; a second
			// store.update would mask the natural `requirements.create` op that
			// F1 relies on as the `created` signal. Consumers resolve the doc
			// path via resolveExistingDocPath (canonical then legacy fallback)
			// — works for both F4-created and pre-F4 requirements.

			// F1 invariant: the natural `requirements.create` op (emitted by
			// SqliteStore → hub on every store.create) doubles as the `created`
			// signal — no extra emit here.
			return { requirement: created, docNote };
		},

		list(filter) {
			return requirementStore.list(filter) as RequirementRecord[];
		},

		get(id) {
			return requirementStore.get(id) as RequirementRecord | undefined;
		},

		transition({ id, action, body, projectId }) {
			const spec = FLOW_TRANSITIONS[action];

			// transitionStatus enforces the state machine; on an illegal from→to
			// it throws with the validTargets attached.
			const res = requirementStore.transitionStatus(
				id,
				spec.target,
				spec.triggeredBy,
				`Flow.${action}`,
			);
			const updated = res.requirement;

			// Side effect: write the doc section (file, not DB) when the action
			// carries one. Best-effort; transition must succeed even if the doc
			// write fails.
			let docNote = "";
			if (spec.section) {
				const ws = resolveWorkspaceDir(projectId ?? updated.projectId);
				if (ws) {
					try {
						writeDocSection(ws, projectId ?? updated.projectId, id, spec.section, body ?? "");
					} catch (err) {
						docNote = ` (doc section write failed: ${(err as Error).message})`;
					}
				} else {
					docNote = " (workspace unresolved — doc section not written)";
				}
			}

			// F3: plan also creates the feature worktree (project-flow §4.2).
			// Reuses GitIntegration.createFeatureWorktree (central path under
			// ~/.zero-core/projects/{project}/{req-shortId}/). Non-blocking: on
			// failure we fall back to the main workspace; the transition + doc +
			// signal still succeed. Only the runtime supplies gitIntegration; the
			// REST/UI path doesn't create worktrees (user confirm has no worktree
			// side effect — the agent plan action does).
			let worktreeNote = "";
			if (action === "plan" && gitIntegration) {
				const ws = resolveWorkspaceDir(projectId ?? updated.projectId);
				if (ws) {
					try {
						// NOTE: deliberately not awaited here — the shared backend
						// is sync for the transition+doc+signal path. The runtime
						// plan action wraps this and awaits the worktree creation
						// via gitIntegration directly (see flow-tool.ts), surfacing
						// the worktreePath on ctx.featureWorkspace. We keep the
						// backend sync so the REST path is trivial.
						void gitIntegration
							.createFeatureWorktree(ws, id, projectId ?? updated.projectId)
							.then((wt) => {
								if (wt?.ok && wt.worktreePath) {
									// Surface via the emitTransition record (best-effort);
									// the runtime caller also reads the worktree directly.
									logWorktree(id, wt.worktreePath);
								}
							})
							.catch(() => { /* best-effort */ });
					} catch (err) {
						worktreeNote = ` (worktree creation failed: ${(err as Error).message})`;
					}
				}
			}

			// Emit the named hook signal (requirements.<signal>) so
			// ProjectWorkHookManager can fire works subscribed to it (e.g.
			// delivery work on requirements.ready).
			try {
				emitTransition("requirements", spec.signal, id, updated);
			} catch {
				// Best-effort: a hub emit failure must not undo the transition.
			}

			return { requirement: updated, docNote, worktreeNote };
		},

		async verify({ id, projectId, source }) {
			const req = requirementStore.get(id);
			if (!req) {
				throw new Error(`requirement not found: ${id}`);
			}
			if (req.status !== "verify") {
				throw new Error(
					`verify requires status='verify' (got '${req.status}'). Use finishBuild first.`,
				);
			}

			// 1. Resolve the verdict. Verdict-driven: the caller (user via REST,
			//    or a reviewing agent via the Flow tool) supplies the coverage
			//    verdict directly. The tool never picks or invokes a reviewer.
			let verdict: ParsedVerdict;
			if (source.kind === "verdict") {
				verdict = { approved: !!source.covered, reason: source.reason ?? "(caller-supplied verdict)" };
			} else {
				// "none" — caller supplied no verdict. Degrade: do NOT advance
				// status; tell the caller to supply covered/reason.
				return {
					requirement: req,
					applied: false,
					text: "verify verdict not supplied — pass covered (true/false) + reason. Requirement stays in 'verify'.",
				};
			}

			// 2. Drive PmService.submitCoverageVerdict (records the verdict as a
			//    status_change audit message; on APPROVED triggers archivist
			//    mergeFeatureToMain + verify→closed). reviewerAgentId is resolved
			//    by pmService from the req record (defaults to reviewerAgentId /
			//    createdByAgentId) — the tool does not pick one.
			let mergeRef: string | undefined;
			let finalStatus: string = req.status;
			let reworked = false;

			if (pmService?.submitCoverageVerdict) {
				try {
					const outcome = await pmService.submitCoverageVerdict(
						id,
						{ covered: verdict.approved, reason: verdict.reason },
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
							writeDecisionLog(resolveWorkspaceDir(projectId ?? req.projectId), projectId ?? req.projectId, id, body);
							emit("verified", id, requirementStore.get(id));
							return {
								requirement: requirementStore.get(id) ?? req,
								applied: false,
								text: `APPROVED — ${verdict.reason}\n\nArchivist merge ${why} (${detail}). Requirement stays in 'verify'; archivist cron will retry the merge. You can re-submit verify if needed.`,
							};
						}
					}
				} catch (err: any) {
					const body = decisionLogBody(verdict, undefined, finalStatus) +
						`\nsubmitCoverageVerdict failed: ${err.message ?? String(err)}. Requirement stays in 'verify'.`;
					writeDecisionLog(resolveWorkspaceDir(projectId ?? req.projectId), projectId ?? req.projectId, id, body);
					emit(verdict.approved ? "verified" : "rejected", id, requirementStore.get(id));
					return {
						requirement: requirementStore.get(id) ?? req,
						applied: false,
						text: `Verdict: ${verdict.approved ? "APPROVED" : "REJECTED"} — ${verdict.reason}\n\nsubmitCoverageVerdict failed: ${err.message ?? String(err)}. Requirement stays in 'verify'; re-submit or wait for cron fallback.`,
					};
				}
			}
			// else: pmService not wired. Verdict text returned below; no
			// merge/close. Status stays in "verify".

			// 3. Rework transition + signal emit + Decision Log.
			if (!verdict.approved) {
				// project-flow §2/§8: rejected → rework verify→build (triggeredBy
				// agent, the only legal verify→ non-closed edge). The delivery
				// work's next fire reads the Decision Log feedback and re-runs
				// plan→finishBuild→verify. Best-effort: a transition failure must
				// not lose the verdict.
				try {
					requirementStore.transitionStatus(id, "build", "agent", "Flow.verify rework (verdict rejected)");
					finalStatus = "build";
					reworked = true;
				} catch {
					// Stays in verify; the signal + Decision Log still carry the verdict.
				}
			}

			writeDecisionLog(
				resolveWorkspaceDir(projectId ?? req.projectId),
				projectId ?? req.projectId,
				id,
				decisionLogBody(verdict, mergeRef, finalStatus),
			);
			const updatedRec = requirementStore.get(id) ?? req;
			emit(verdict.approved ? "verified" : "rejected", id, updatedRec);

			// 4. Compose the return text (reviewer-agnostic — who issued the
			//    verdict is external to the tool).
			let text: string;
			if (verdict.approved) {
				if (mergeRef) {
					text = `APPROVED — ${verdict.reason}\n\nArchivist merged feature→main (ref ${mergeRef}); requirement status → ${finalStatus}. Delivery complete.`;
				} else {
					text = `APPROVED — ${verdict.reason}\n\n(pmService not wired on this ctx — end-to-end close skipped. Requirement is in 'verify'; archivist cron will pick it up.)`;
				}
			} else {
				text = `REJECTED — ${verdict.reason}\n\nFeedback recorded on the requirement.${reworked ? " Status returned to 'build' for revision." : " Status stays in 'verify'."} Revise your plan and re-submit finishBuild → verify when ready.`;
			}

			return { requirement: updatedRec, text, applied: true };
		},
	};

	/** Write the Decision Log section (file, not DB). Best-effort. */
	function writeDecisionLog(
		workspaceDir: string | undefined,
		projectId: string | undefined,
		id: string,
		body: string,
	): void {
		if (!workspaceDir) return;
		try {
			writeDocSection(workspaceDir, projectId, id, "Decision Log", body);
		} catch {
			// Best-effort: verdict still returned to caller + signal still emitted.
		}
	}

	/** Emit the named verify signal (requirements.verified | requirements.rejected). */
	function emit(signal: "verified" | "rejected", id: string, record: unknown): void {
		try {
			emitTransition("requirements", signal, id, record);
		} catch {
			// Best-effort.
		}
	}
}

/** Internal: keep a no-op logger so the backend stays self-contained. */
function logWorktree(_id: string, _path: string): void {
	// Intentionally minimal — runtime path also surfaces the worktree on
	// ctx.featureWorkspace (see flow-tool.ts plan action).
}
