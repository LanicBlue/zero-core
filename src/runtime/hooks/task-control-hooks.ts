// Task-control injection hook (Phase C2; Step 2E deferred consume).
//
// # File spec
//
// ## Core
// Two handlers, both keyed on the 1-based step number:
//
//   StepStart → find a delegated task backing THIS session that is "finishing"
//     with an unread control message. Inject it into the step. DO NOT clear the
//     persisted controlMessage yet — instead remember (in a per-session map)
//     which taskId was injected for this stepNumber.
//
//   StepEnd   → look up the taskId injected for this stepNumber and clear the
//     persisted controlMessage for it. StepEnd only fires on a SUCCESSFUL step
//     (runOneStepWithRetry does not call finalizeOneStep on a failed/retried
//     attempt), so a step that fails and retries re-injects on the next
//     StepStart (controlMessage is still set). This is the deferred-consume
//     invariant: "deliver on inject, clear only after the step succeeds."
//
// This is the delivery half of request_finish. The force-stop half (maxTurns
// budget) lives in subagent-delegator.buildSubEventHandler.
//
// ## Why deferred
// The previous hook cleared controlMessage on inject, so a failed attempt ate
// the wrap-up instruction and the sub-agent never saw it again. Now it survives
// until the step it was injected into succeeds.
//
// ## Why a hook
// request_finish is task management, not AgentLoop. AgentLoop only exposes the
// per-step injection point (StepStart); this hook reads delegated_tasks by
// sessionId, fully under hooks/.
//
// ## Position
// src/runtime/hooks/ — delegated-loop only (registered in registerHooksForLoop).
//
// ## Dependencies
// - ISessionStore (listDelegatedTasks / updateDelegatedTask)
//
import { HookRegistry } from "../../core/hook-registry.js";
import type { ISessionStore } from "../session-store-interface.js";
import { log } from "../../core/logger.js";

/**
 * Per-session mapping: stepNumber → taskId whose control message was injected
 * into that step but not yet committed. Filled on StepStart, drained on StepEnd.
 * Cleared defensively at TurnStart so a stale entry from a prior turn can't
 * survive.
 */
const injectedByStep = new Map<string, Map<number, string>>();

function forgetStep(sessionId: string, stepNumber: number): void {
	const m = injectedByStep.get(sessionId);
	if (!m) return;
	m.delete(stepNumber);
	if (m.size === 0) injectedByStep.delete(sessionId);
}

function clearSession(sessionId: string): void {
	injectedByStep.delete(sessionId);
}

/**
 * Register the delegated-task control-message injection hook with deferred
 * consume. Idempotent — safe to call once at startup. No-op when no db is
 * provided.
 */
export function registerTaskControlHooks(db: ISessionStore | undefined, registry: HookRegistry = HookRegistry.getInstance()): void {
	if (!db?.listDelegatedTasks) return;

	registry.register("TurnStart", async (ctx) => {
		// Defensive cleanup: a control-message injection that never reached
		// StepEnd (e.g. abort before any step succeeded) shouldn't leak into
		// the next turn. The row's controlMessage is still set, so a fresh
		// StepStart will re-inject cleanly.
		const sessionId = ctx.sessionId as string | undefined;
		if (sessionId) clearSession(sessionId);
	});

	registry.register("StepStart", async (ctx) => {
		const sessionId = ctx.sessionId as string | undefined;
		if (!sessionId) return;
		const stepNumber = ctx.stepNumber as number | undefined;
		if (stepNumber === undefined) return;

		// Find a delegated task backing THIS session (the sub-agent's hidden
		// delegated session) that is "finishing" with an unread control message.
		const finishing = db.listDelegatedTasks!({ status: "finishing" });
		const task = finishing.find((t) => t.sessionId === sessionId && t.controlMessage);
		if (!task) return;

		log.debug("hooks", `StepStart: injecting control message for task ${task.id} (step ${stepNumber}, deferred)`);
		// Remember which taskId was injected for THIS step. Do NOT clear the
		// persisted controlMessage — StepEnd does that once the step succeeds.
		let m = injectedByStep.get(sessionId);
		if (!m) { m = new Map(); injectedByStep.set(sessionId, m); }
		m.set(stepNumber, task.id);
		return {
			appendMessages: [{ role: "user", content: `[control] ${task.controlMessage}` }],
		};
	});

	registry.register("StepEnd", async (ctx) => {
		const sessionId = ctx.sessionId as string | undefined;
		if (!sessionId) return;
		const stepNumber = ctx.stepNumber as number | undefined;
		if (stepNumber === undefined) return;

		const taskId = injectedByStep.get(sessionId)?.get(stepNumber);
		if (!taskId) return;

		// The step that carried this control message succeeded — now it is safe
		// to clear the persisted message so it doesn't repeat.
		db.updateDelegatedTask?.(taskId, { controlMessage: undefined });
		forgetStep(sessionId, stepNumber);
		log.debug("hooks", `StepEnd: cleared controlMessage for task ${taskId} (step ${stepNumber} succeeded)`);
	});

	registry.register("TurnEnd", async (ctx) => {
		const sessionId = ctx.sessionId as string | undefined;
		if (sessionId) clearSession(sessionId);
	});
	registry.register("TurnError", async (ctx) => {
		const sessionId = ctx.sessionId as string | undefined;
		if (sessionId) clearSession(sessionId);
	});

	log.debug("hooks", "Task-control injection hook registered (deferred consume)");
}
