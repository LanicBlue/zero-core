// sub-6 (execution-entry-redesign) acceptance tests — Cron/Wait category fix.
//
// Independent verifier-authored tests encoding acceptance-6.md criteria 1–4.
// Each describe block maps to a written acceptance criterion so PASS/FAIL is
// auditable from the test name. Mirrors the style of sub4-task-action-tool.test.
//
// # Authoritative spec
// docs/plan/execution-entry-redesign/acceptance-6.md
//
// # Scope
//   - Cron meta.category === "management" (criterion 1).
//   - Wait meta.category === "task" (criterion 2).
//   - ToolCategory union contains "management" + "task"; getToolCategories()
//     groups both keys (criterion 3).
//   - UI grouping: Cron in management, Wait + Task in task; Cron NOT in agent,
//     Wait NOT in runtime (criterion 4).
//
// # Not covered here (other criteria)
//   - criterion 5 (Cron/Wait functionality unchanged) — verified by full-suite
//     run: existing m1-cron / p4-cron-scheduler / po-sub6-crons-today /
//     sub5-wait / sub6-force-wait / sub9-wait-edges must stay green.
//   - criterion 6 (typecheck) — verified by `npm run build:lib`.

import { describe, test, expect } from "vitest";
import { cronTool } from "../../src/tools/cron-tool.js";
import { waitTool } from "../../src/tools/wait.js";
import { taskTool } from "../../src/tools/task-tool.js";
import { getToolMeta } from "../../src/tools/tool-factory.js";
import { getToolCategories } from "../../src/tools/index.js";

// Criterion 1 — Cron category = management
describe("acceptance-6 criterion 1: Cron category === 'management'", () => {
	test("getToolMeta(cronTool).category is 'management'", () => {
		const meta = getToolMeta(cronTool);
		expect(meta).toBeDefined();
		expect(meta?.category).toBe("management");
	});
});

// Criterion 2 — Wait category = task
describe("acceptance-6 criterion 2: Wait category === 'task'", () => {
	test("getToolMeta(waitTool).category is 'task'", () => {
		const meta = getToolMeta(waitTool);
		expect(meta).toBeDefined();
		expect(meta?.category).toBe("task");
	});
});

// Criterion 3 — ToolCategory contains management + task (functional: getToolCategories
// returns a record keyed by category and both keys exist)
describe("acceptance-6 criterion 3: getToolCategories() has management + task groups", () => {
	test("management group is an array containing 'Cron'", () => {
		const categories = getToolCategories();
		expect(categories).toHaveProperty("management");
		expect(Array.isArray(categories.management)).toBe(true);
		expect(categories.management).toContain("Cron");
	});

	test("task group is an array containing 'Wait' and 'Task'", () => {
		const categories = getToolCategories();
		expect(categories).toHaveProperty("task");
		expect(Array.isArray(categories.task)).toBe(true);
		expect(categories.task).toContain("Wait");
		expect(categories.task).toContain("Task");
	});
});

// Criterion 4 — UI grouping correct: Cron in management, Wait+Task in task; Cron
// NOT in agent, Wait NOT in runtime
describe("acceptance-6 criterion 4: UI grouping — Cron in management, Wait+Task in task, neither misfiled", () => {
	test("Cron is NOT in 'agent' group anymore", () => {
		const categories = getToolCategories();
		const agentGroup = categories.agent ?? [];
		expect(agentGroup).not.toContain("Cron");
	});

	test("Wait is NOT in 'runtime' group", () => {
		const categories = getToolCategories();
		const runtimeGroup = categories.runtime ?? [];
		expect(runtimeGroup).not.toContain("Wait");
	});

	test("Task is in 'task' group (sub-4 set category task)", () => {
		const meta = getToolMeta(taskTool);
		expect(meta?.category).toBe("task");
		const categories = getToolCategories();
		expect(categories.task).toContain("Task");
	});

	test("all three (Cron/Wait/Task) resolve to expected groups in a single grouping snapshot", () => {
		const categories = getToolCategories();
		expect(categories.management).toContain("Cron");
		expect(categories.task).toContain("Wait");
		expect(categories.task).toContain("Task");
	});
});
