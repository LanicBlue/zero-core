// 单测:sub-5 (execution-entry-redesign) RENAMED_TOOLS 迁移 + buildToolsSet 路由
//
// # 文件说明书
//
// ## 核心功能
// 断言 sub-4 把 6 个 Task* 工具 + 历史的 TaskStatus/TaskStop 合并成单一 `Task`
// action 工具后,所有旧拼写(PascalCase / lowercase / snake_case / 历史名)在
// `RENAMED_TOOLS` 中都指向 "Task" —— 而不是被 sub-4 删除的 TaskGet/TaskKill 等。
// 再覆盖 `buildToolsSet` 的 policy.tools 旧 key 迁移路径,确保旧配置 / preset /
// agent prompt 里残留的 `task_get` / `TaskStart` 等不会让 Task 能力静默消失。
//
// ## 为什么需要这个测试
// sub-4 删工具是结构性的:ALL_TOOLS 里再没有 TaskGet / TaskKill / TaskStart ...
// 如果 RENAMED_TOOLS 还把它们指向旧目标,buildToolsSet 的迁移循环会把旧 config
// key 路由到一个不存在的工具名,导致 isEnabled() 永远 false → Task 被静默禁用。
// 这层回归抓不到 action-tool-schema.test.ts(schema 形状)里,需要单测兜底。
//
// ## 维护规则
// sub-6+ 若再合并/重命名 action 工具,补同款 PascalCase + lowercase + snake_case
// 三联映射 + 历史名 → 新名,并在此同步加断言。
//

import { describe, it, expect } from "vitest";
import { RENAMED_TOOLS } from "../../src/core/tool-registry.js";
import { buildToolsSet } from "../../src/tools/index.js";

// ---------------------------------------------------------------------------
// Criterion 1: PascalCase legacy names → "Task"
// ---------------------------------------------------------------------------

describe("acceptance-5 criterion 1: PascalCase Task* names map to Task", () => {
	const PASCAL = ["TaskStart", "TaskGet", "TaskList", "TaskKill", "TaskFinish", "TaskResume"] as const;

	for (const name of PASCAL) {
		it(`RENAMED_TOOLS[${JSON.stringify(name)}] === "Task"`, () => {
			expect(RENAMED_TOOLS[name]).toBe("Task");
		});
	}
});

// ---------------------------------------------------------------------------
// Criterion 2: lowercase + snake_case legacy names → "Task"
// ---------------------------------------------------------------------------

describe("acceptance-5 criterion 2: lowercase + snake_case Task* names map to Task", () => {
	const LOWER = ["taskstart", "taskget", "tasklist", "taskkill", "taskfinish", "taskresume"] as const;
	const SNAKE = ["task_start", "task_get", "task_list", "task_kill", "task_finish", "task_resume"] as const;

	for (const name of LOWER) {
		it(`RENAMED_TOOLS[${JSON.stringify(name)}] === "Task" (lowercase)`, () => {
			expect(RENAMED_TOOLS[name]).toBe("Task");
		});
	}

	for (const name of SNAKE) {
		it(`RENAMED_TOOLS[${JSON.stringify(name)}] === "Task" (snake_case)`, () => {
			expect(RENAMED_TOOLS[name]).toBe("Task");
		});
	}
});

// ---------------------------------------------------------------------------
// Criterion 3: historical TaskStatus / TaskStop map to "Task"
// (NOT TaskGet / TaskKill — those targets were deleted by sub-4)
// ---------------------------------------------------------------------------

describe("acceptance-5 criterion 3: historical task_status / TaskStop map to Task (not deleted TaskGet/TaskKill)", () => {
	const HISTORICAL = ["task_status", "TaskStatus", "task_stop", "TaskStop"] as const;

	for (const name of HISTORICAL) {
		it(`RENAMED_TOOLS[${JSON.stringify(name)}] === "Task"`, () => {
			expect(RENAMED_TOOLS[name]).toBe("Task");
		});
	}

	it("historical names do NOT route to the deleted TaskGet/TaskKill targets", () => {
		expect(RENAMED_TOOLS["task_status"]).not.toBe("TaskGet");
		expect(RENAMED_TOOLS["TaskStatus"]).not.toBe("TaskGet");
		expect(RENAMED_TOOLS["task_stop"]).not.toBe("TaskKill");
		expect(RENAMED_TOOLS["TaskStop"]).not.toBe("TaskKill");
	});
});

// ---------------------------------------------------------------------------
// Criterion 4: buildToolsSet migrates old config keys via RENAMED_TOOLS
// ---------------------------------------------------------------------------

describe("acceptance-5 criterion 4: buildToolsSet migrates legacy Task keys → Task", () => {
	// buildToolsSet only reads `policy.tools` for the migration + gating path; it
	// does not dereference `context` (ToolExecutionContext) until tool execution.
	// So a minimal `{} as any` context is sufficient to exercise the migration.
	function taskInOutput(tools: Record<string, { enabled: boolean }>): boolean {
		const result = buildToolsSet({ tools } as any, {} as any);
		return "Task" in result;
	}

	it("snake_case task_get:{enabled:true} → Task in output", () => {
		expect(taskInOutput({ task_get: { enabled: true } })).toBe(true);
	});

	it("PascalCase TaskStart:{enabled:true} → Task in output", () => {
		expect(taskInOutput({ TaskStart: { enabled: true } })).toBe(true);
	});

	it("lowercase taskstart:{enabled:true} → Task in output", () => {
		expect(taskInOutput({ taskstart: { enabled: true } })).toBe(true);
	});

	it("historical task_status:{enabled:true} → Task in output (not TaskGet)", () => {
		expect(taskInOutput({ task_status: { enabled: true } })).toBe(true);
	});

	it("historical TaskStop:{enabled:true} → Task in output (not TaskKill)", () => {
		expect(taskInOutput({ TaskStop: { enabled: true } })).toBe(true);
	});

	it("disabled legacy key → Task NOT in output (gating respected)", () => {
		expect(taskInOutput({ task_get: { enabled: false } })).toBe(false);
	});

	it("combined enabled legacy keys all collapse onto Task", () => {
		// All three keys route through RENAMED_TOOLS[key] ?? key → "Task". With
		// enabled:true across the board, last-write-wins still yields Task enabled.
		// Proves multiple legacy spellings in one config don't disable Task.
		const result = buildToolsSet({
			tools: {
				task_get: { enabled: true },
				TaskStart: { enabled: true },
				task_status: { enabled: true },
			},
		} as any, {} as any);
		expect("Task" in result).toBe(true);
	});

	it("baseline: with no policy.tools, Task is not auto-enabled (not in DEFAULT_ENABLED)", () => {
		// DEFAULT_ENABLED = Shell/Read/Write/Edit/Grep/Glob only. Task is opt-in.
		const result = buildToolsSet({} as any, {} as any);
		expect("Task" in result).toBe(false);
	});
});
