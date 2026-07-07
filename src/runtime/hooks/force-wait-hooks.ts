// force-Wait hook (sub-6 of subagent-recovery; design §2.1).
//
// # File spec
//
// ## Core
// A single TurnEndCheck handler. TurnEndCheck fires from AgentLoop right
// before a turn would naturally end (the just-completed step had no tool
// call). This handler decides whether the turn is ALLOWED to end:
//
//   - If the loop's TaskRegistry has any running/finishing task AND no nudge
//     has been issued for this turn yet → return { forceContinue: true,
//     message } so AgentLoop injects the message and runs one more step.
//     The nudge message tells the model to call Wait.
//   - Otherwise (no running task, OR already nudged this turn) → return void
//     and the turn ends normally.
//
// The per-turn "already nudged" marker is the anti-loop guard (acceptance-6
// case 3): within a single turn the hook nudges AT MOST once. If the model
// ignores the nudge and tries to end again, the turn ends — Wait's own
// timeout (sub-5) is the backstop for the background task; the nudge gave the
// model one clean chance to Wait. The marker is cleared at TurnStart so the
// next turn starts fresh.
//
// ## Why a hook (not inline AgentLoop)
// "功能走 hook" — AgentLoop only exposes the TurnEndCheck checkpoint; all
// force-Wait logic (task check, nudge text, dedup) lives here. AgentLoop has
// no knowledge of tasks or Wait.
//
// ## Why TurnEndCheck (not TurnEnd)
// TurnEnd fires in the run() finally block AFTER the turn is already over —
// injecting a message there goes nowhere. TurnEndCheck is the only honest
// "turn is about to end, can I keep it alive?" seam.
//
// ## Does NOT fire while waiting
// While a Wait tool call is suspended (sub-5), the loop is mid-run, not at a
// turn-end boundary — TurnEndCheck simply isn't reached. We also guard
// defensively via the task check: a suspended Wait means the model already
// Waited, so there's nothing extra to nudge about (the wait will wake on
// any-task-finish).
//
// ## Position
// src/runtime/hooks/ — registered for every loop kind that owns a task
// registry (main + delegated). Both can dispatch background tasks via
// TaskStart and must not strand them.
//
// ## Dependencies
// - core/hook-registry (HookRegistry)
// - core/hook-types (TurnEndCheck context)
// - runtime/task-registry (hasRunning) — read off the ctx, NOT imported here
//   (the registry is per-loop; the loop passes its own instance through ctx)

import { HookRegistry } from "../../core/hook-registry.js";
import type { TaskRegistry } from "../task-registry.js";
import { log } from "../../core/logger.js";

/**
 * Per-session "already nudged this turn" marker. Set on first nudge, cleared
 * at TurnStart. Keyed by sessionId so concurrent loops (different sessions)
 * don't interfere. A loop runs one turn at a time, so a single boolean per
 * session is sufficient — no per-turn key needed.
 */
const nudgedThisTurn = new Set<string>();

const NUDGE_MESSAGE =
	"[system] Background tasks are still running. Do not end your turn — call the Wait tool to suspend until they finish (or a wake event fires). Ending now would strand the running tasks.";

/**
 * Register the force-Wait TurnEndCheck hook. Idempotent.
 *
 * The hook reads `ctx.taskRegistry` (the loop's own registry) and decides
 * turn-end admissibility. No-op when no registry is provided in the context
 * (stubbed tests) — the turn ends normally.
 */
export function registerForceWaitHooks(registry: HookRegistry = HookRegistry.getInstance()): void {
	// Reset the nudge marker at the start of each turn so a fresh turn can
	// nudge again. (TurnStart fires once per run() — see agent-loop run().)
	registry.register("TurnStart", async (ctx) => {
		const sessionId = ctx.sessionId as string | undefined;
		if (sessionId) nudgedThisTurn.delete(sessionId);
	});

	// Defensive cleanup at turn boundaries too (TurnStart is the primary, but
	// TurnEnd/TurnError clear as a belt-and-suspenders in case TurnStart's
	// handler was skipped).
	registry.register("TurnEnd", async (ctx) => {
		const sessionId = ctx.sessionId as string | undefined;
		if (sessionId) nudgedThisTurn.delete(sessionId);
	});
	registry.register("TurnError", async (ctx) => {
		const sessionId = ctx.sessionId as string | undefined;
		if (sessionId) nudgedThisTurn.delete(sessionId);
	});

	registry.register("TurnEndCheck", async (ctx) => {
		const sessionId = ctx.sessionId as string | undefined;
		const taskRegistry = ctx.taskRegistry as TaskRegistry | undefined;
		if (!taskRegistry || !sessionId) return;

		// Gate 1: no running task → turn may end. (Also covers the "Wait is
		// suspended" case: a suspended Wait is mid-run, TurnEndCheck isn't
		// reached; but even if it were, the model already Waited, so the
		// running-task check below would typically be false once the wait
		// resolves on task finish.)
		if (!taskRegistry.hasRunning()) return;

		// Gate 2: already nudged this turn → don't nudge again (anti-loop).
		// The turn ends; Wait's timeout is the backstop.
		if (nudgedThisTurn.has(sessionId)) {
			log.debug("hooks", `force-Wait: running task(s) but already nudged this turn for ${sessionId}; allowing turn end`);
			return;
		}

		// Nudge once: keep the turn alive for one more step with the message.
		nudgedThisTurn.add(sessionId);
		log.debug("hooks", `force-Wait: nudging ${sessionId} to Wait (running task(s) present)`);
		return { forceContinue: true, message: NUDGE_MESSAGE };
	});

	log.debug("hooks", "force-Wait TurnEndCheck hook registered");
}

/** Test-only: reset the per-session nudge marker. */
export function _resetForceWaitNudgeState(): void {
	nudgedThisTurn.clear();
}
