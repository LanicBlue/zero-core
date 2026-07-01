// Step 3B acceptance test: todo cleanup runs per-step on StepEnd.
//
// # File spec
//
// ## Core
// Verifies the Step 3B migration of todo-cleanup from PostTurnComplete to
// StepEnd. The hook (registerTodoCleanupHooks) inspects the session's todo
// list at every StepEnd: when every todo is completed it clears the backend
// store immediately AND emits todos_update([]) routed by sessionId, so the
// UI collapses the list the moment the finishing step ends — not at turn end.
// A step that leaves any todo not-completed is a fast no-op (no clear, no emit).
//
// ## Acceptance mapping
// docs/design/hook-redesign/steps/3B-todo-metrics-turnend-postturncomplete-removal/accept.md A3:
//   - agent completes the last todo in some step → that step's StepEnd →
//     clearSessionTodos + emit todos_update[] (sessionId routed).
//   - step that leaves todos not all done → no clear.
//
// ## Design
// Seeds the per-session todo store by driving the real TodoWrite tool's
// execute() (the only public write path into the in-memory map), then fires
// StepEnd through a fresh HookRegistry and asserts on getSessionTodos() +
// the captured emit payload. No DB / no live AgentLoop.

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { HookRegistry } from "../../src/core/hook-registry.js";
import { registerTodoCleanupHooks } from "../../src/runtime/hooks/todo-cleanup-hooks.js";
import { getSessionTodos, clearSessionTodos } from "../../src/runtime/tools/todo-write.js";

const SESSION_ID = "sess-todo-3b";
const AGENT_ID = "dev";

/**
 * Seed the per-session todo list by exercising the real TodoWrite tool's raw
 * execute (the __execute property bypasses buildTool's AI-SDK wrapper, which
 * would otherwise read opts.experimental_context and fall back to a default
 * key — losing our sessionId routing). __execute takes (input, ctx) directly.
 */
async function seedTodos(
	sessionId: string,
	todos: Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm: string }>,
): Promise<void> {
	const { todoWriteTool } = await import("../../src/runtime/tools/todo-write.js");
	const rawExecute = (todoWriteTool as any).__execute;
	await rawExecute(
		{ todos },
		{ sessionId, agentId: AGENT_ID, emit: () => {} },
	);
}

describe("Step 3B — todo cleanup on StepEnd (per-step, sessionId routed)", () => {
	let registry: HookRegistry;
	let emitted: any[];

	beforeEach(() => {
		registry = new HookRegistry();
		clearSessionTodos(SESSION_ID);
		emitted = [];
		registerTodoCleanupHooks(registry);
	});

	afterEach(() => {
		clearSessionTodos(SESSION_ID);
	});

	/** Fire a StepEnd the way agent-loop's finalizeOneStep does. */
	async function fireStepEnd(): Promise<void> {
		await registry.trigger("StepEnd", {
			agentId: AGENT_ID,
			sessionId: SESSION_ID,
			emit: (event: any) => emitted.push(event),
		});
	}

	test("all todos completed at this step → StepEnd clears the store and emits todos_update[] (sessionId routed)", async () => {
		// Two todos, both completed — the last one was finished inside this step.
		await seedTodos(SESSION_ID, [
			{ content: "step 1 done", status: "completed", activeForm: "doing step 1" },
			{ content: "step 2 done", status: "completed", activeForm: "doing step 2" },
		]);
		// Sanity: seeding populated the store.
		expect(getSessionTodos(SESSION_ID)).toHaveLength(2);

		await fireStepEnd();

		// Store cleared immediately at this step's StepEnd (not deferred to turn end).
		expect(getSessionTodos(SESSION_ID), "store must be cleared when all todos are completed").toEqual([]);
		// Frontend was notified so the widget collapses.
		expect(emitted, "exactly one todos_update event must be emitted").toHaveLength(1);
		expect(emitted[0].type).toBe("todos_update");
		expect(emitted[0].todos, "emitted list must be empty").toEqual([]);
		// SessionId routing: the event carries the sessionId so the UI maps it to
		// the right session (not broadcast).
		expect(emitted[0].sessionId, "event must be routed by sessionId").toBe(SESSION_ID);
		expect(emitted[0].agentId).toBe(AGENT_ID);
	});

	test("step that leaves a todo not-completed → StepEnd is a no-op (no clear, no emit)", async () => {
		// One completed, one still in_progress: this step did NOT finish the list.
		await seedTodos(SESSION_ID, [
			{ content: "finished bit", status: "completed", activeForm: "finishing bit" },
			{ content: "ongoing bit", status: "in_progress", activeForm: "doing ongoing bit" },
		]);

		await fireStepEnd();

		// Store untouched — the list must survive until the step that actually
		// finishes the last todo.
		const after = getSessionTodos(SESSION_ID);
		expect(after, "store must NOT be cleared when a todo is still open").toHaveLength(2);
		expect(after[0].status).toBe("completed");
		expect(after[1].status).toBe("in_progress");
		// No UI event — the widget stays put.
		expect(emitted, "no todos_update when not all completed").toHaveLength(0);
	});

	test("all-completed at one step clears; a later step with new pending todos does not auto-clear", async () => {
		// Step A: finish everything → cleared.
		await seedTodos(SESSION_ID, [
			{ content: "only item", status: "completed", activeForm: "doing only item" },
		]);
		await fireStepEnd();
		expect(getSessionTodos(SESSION_ID)).toEqual([]);
		expect(emitted).toHaveLength(1);

		// Step B: agent starts a new list mid-turn with fresh pending work.
		await seedTodos(SESSION_ID, [
			{ content: "new task", status: "in_progress", activeForm: "starting new task" },
		]);
		emitted.length = 0;
		await fireStepEnd();

		// The new list survives — cleanup is per-step on the CURRENT list, not a
		// sticky "once cleared, always cleared" state.
		expect(getSessionTodos(SESSION_ID), "new pending list must survive StepEnd").toHaveLength(1);
		expect(emitted).toHaveLength(0);
	});

	test("empty todo store → StepEnd is a no-op (no spurious emit)", async () => {
		// No seed — store is empty for this session.
		await fireStepEnd();
		expect(getSessionTodos(SESSION_ID)).toEqual([]);
		expect(emitted, "no emit when there was nothing to clear").toHaveLength(0);
	});

	test("per-session isolation: session A finishing does not wipe session B's list", async () => {
		const SESSION_B = "sess-todo-3b-other";
		try {
			// Both sessions fully completed.
			await seedTodos(SESSION_ID, [
				{ content: "A done", status: "completed", activeForm: "doing A" },
			]);
			await seedTodos(SESSION_B, [
				{ content: "B done", status: "completed", activeForm: "doing B" },
			]);

			// Fire StepEnd ONLY for session A.
			await registry.trigger("StepEnd", {
				agentId: AGENT_ID,
				sessionId: SESSION_ID,
				emit: (event: any) => emitted.push(event),
			});

			// A cleared, B untouched.
			expect(getSessionTodos(SESSION_ID)).toEqual([]);
			expect(getSessionTodos(SESSION_B), "session B's list must be isolated from session A's StepEnd").toHaveLength(1);
			// The emitted event is routed to A, never B.
			expect(emitted).toHaveLength(1);
			expect(emitted[0].sessionId).toBe(SESSION_ID);
		} finally {
			clearSessionTodos(SESSION_B);
		}
	});
});
