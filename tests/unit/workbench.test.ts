// sub-1 acceptance: workbench channel (per-step live-state block).
//
// # File spec
//
// ## Core
// renderWorkbench builds the `<workbench>` block from the live todo list.
// Returns null when empty (caller skips injection). sub-1 covers todos only;
// task status / wait state are added in later subs.
//
// ## Acceptance mapping
// docs/plan/subagent-recovery/acceptance-1.md:
//   - todos migrated out of the turn-scoped context block into workbench.
//   - workbench empty → null (no empty block injected).
//   - workbench with todos → `<workbench>` block containing the rendered list.

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { clearSessionTodos } from "../../src/runtime/tools/todo-write.js";
import { renderWorkbench } from "../../src/runtime/workbench.js";

const SESSION_ID = "sess-workbench";
const AGENT_ID = "dev";

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

describe("sub-1 workbench channel — renderWorkbench", () => {
	beforeEach(() => {
		clearSessionTodos(SESSION_ID);
	});

	afterEach(() => {
		clearSessionTodos(SESSION_ID);
	});

	test("no todos → null (no empty block injected)", () => {
		expect(renderWorkbench(SESSION_ID, AGENT_ID)).toBeNull();
	});

	test("with todos → <workbench> block containing the rendered list", async () => {
		await seedTodos(SESSION_ID, [
			{ content: "Fix auth bug", status: "completed", activeForm: "Fixing auth bug" },
			{ content: "Add tests", status: "in_progress", activeForm: "Adding tests" },
			{ content: "Update docs", status: "pending", activeForm: "Updating docs" },
		]);

		const wb = renderWorkbench(SESSION_ID, AGENT_ID);
		expect(wb).not.toBeNull();
		expect(wb).toContain("<workbench>");
		expect(wb).toContain("</workbench>");
		// Task List section present with the todo contents.
		expect(wb).toContain("## Task List (your todos)");
		expect(wb).toContain("Fix auth bug");
		expect(wb).toContain("Add tests");
		expect(wb).toContain("1/3 done"); // renderTodosContext "X/Y done" header
	});

	test("reflects latest state (mid-turn freshness)", async () => {
		// Seed an initial list, then overwrite via a second TodoWrite call.
		await seedTodos(SESSION_ID, [
			{ content: "first", status: "in_progress", activeForm: "doing first" },
		]);
		expect(renderWorkbench(SESSION_ID, AGENT_ID)).toContain("first");

		await seedTodos(SESSION_ID, [
			{ content: "second", status: "in_progress", activeForm: "doing second" },
		]);
		const wb = renderWorkbench(SESSION_ID, AGENT_ID);
		expect(wb).toContain("second");
		expect(wb).not.toContain("first");
	});
});
