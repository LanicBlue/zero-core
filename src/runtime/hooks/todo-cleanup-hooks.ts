// Todo cleanup hook: clear all-completed todos at the step boundary.
//
// # File spec
//
// ## Core
// registerTodoCleanupHooks registers a StepEnd handler that inspects the
// agent's todo list after each step: when **every** todo is completed it
// immediately clears the backend store and emits todos_update([]) so the
// frontend UI collapses the list right away.
//
// ## Why StepEnd (per step, not per turn)
// Originally this ran on PostTurnComplete (turn-end). Step 3B migrates it to
// StepEnd so the list collapses as soon as the last todo is finished within a
// step, rather than waiting for the whole turn to end. Behavior for the user
// is identical to the older PreLLMCall-then-PostTurnComplete progression but
// fires at the most granular honest boundary (each LLM step).
//
// ## Design
// Cleanup logic lives here + in todo-write.ts (module-local). The hook only
// needs sessionId/agentId/emit from the StepEnd context. It runs every step;
// when not all todos are done (or there are none) it is a fast no-op.
//
// ## Position
// src/runtime/hooks/ — step lifecycle hook, registered by hooks/index.ts.

import { HookRegistry } from "../../core/hook-registry.js";
import { getSessionTodos, clearSessionTodos } from "../../tools/todo-write.js";

export function registerTodoCleanupHooks(registry: HookRegistry = HookRegistry.getInstance()): void {
	// Step 3B: migrated from PostTurnComplete to StepEnd. Per-step check means
	// the list collapses immediately after the step that finishes the last
	// todo, instead of waiting for turn end. The check is cheap (in-memory
	// todo list) so running it every step is fine.
	registry.register("StepEnd", async (ctx: any) => {
		// Per-session isolation: each session clears its own todos so one
		// session finishing does not wipe another session's list.
		const sessionId = ctx?.sessionId as string | undefined;
		const agentId = ctx?.agentId as string | undefined;
		if (!sessionId) return;
		const todos = getSessionTodos(sessionId);
		if (todos.length === 0) return;
		const allDone = todos.every((t) => t.status === "completed");
		if (!allDone) return;
		// All completed → clear immediately at the end of this step.
		clearSessionTodos(sessionId);
		// Notify the frontend so the widget hides (reuses the existing
		// todos_update → setTodos(sessionId, []) → TodosList returns null path).
		if (typeof ctx.emit === "function") {
			ctx.emit({ type: "todos_update", agentId, sessionId, todos: [] });
		}
		return;
	});
}
