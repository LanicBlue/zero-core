// Input-queue injection hook (Phase C2; Step 2E deferred consume).
//
// # File spec
//
// ## Core
// Two handlers, both keyed on the 1-based step number so the StepStart
// injection and the StepEnd commit line up:
//
//   StepStart → peekInsertNow(sessionId, stepNumber)
//     Marks insert_now items "delivered for this step" WITHOUT removing them
//     from the queue. Returns their contents as messages to append for this
//     step. Idempotent within a step (a second call returns []).
//
//   StepEnd   → commitDeliveredForStep(sessionId, stepNumber)
//     Actually removes from the queue every insert_now item marked for that
//     step. StepEnd only fires on a SUCCESSFUL step (runOneStepWithRetry does
//     not call finalizeOneStep on a failed/retried attempt), so a step that
//     fails and retries still has the items in the queue — the next attempt's
//     StepStart re-injects them. This is the deferred-consume invariant:
//     "deliver on inject, consume only after the step succeeds."
//
// Why deferred: the previous hook drained the queue on inject, so a failed
// attempt ate the user's insert_now message. Now it survives until success.
//
// ## Position
// src/runtime/hooks/ — main-loop only (registered in registerHooksForLoop).
//
// ## Dependencies
// - InputQueueStore (peekInsertNow / commitDeliveredForStep)
//
import { HookRegistry } from "../../core/hook-registry.js";
import type { InputQueueStore } from "../../server/input-queue-store.js";
import { log } from "../../core/logger.js";

/**
 * Register the input-queue insert_now injection hook with deferred consume.
 * Idempotent.
 */
export function registerInputQueueHooks(inputQueue: InputQueueStore, registry: HookRegistry = HookRegistry.getInstance()): void {
	registry.register("StepStart", async (ctx) => {
		const sessionId = ctx.sessionId as string | undefined;
		if (!sessionId) return;
		const stepNumber = ctx.stepNumber as number | undefined;
		if (stepNumber === undefined) return;
		const extra = inputQueue.peekInsertNow(sessionId, stepNumber);
		if (extra.length === 0) return;
		log.debug("hooks", `StepStart: injecting ${extra.length} insert_now input(s) for session ${sessionId} (step ${stepNumber}, deferred)`);
		return { appendMessages: extra };
	});

	registry.register("StepEnd", async (ctx) => {
		const sessionId = ctx.sessionId as string | undefined;
		if (!sessionId) return;
		const stepNumber = ctx.stepNumber as number | undefined;
		if (stepNumber === undefined) return;
		const removed = inputQueue.commitDeliveredForStep(sessionId, stepNumber);
		if (removed > 0) {
			log.debug("hooks", `StepEnd: committed ${removed} insert_now item(s) out of queue for session ${sessionId} (step ${stepNumber})`);
		}
	});

	log.debug("hooks", "Input-queue insert_now injection hook registered (deferred consume)");
}
