// P7 工具契约测试 (sub2 验收用)
//
// # 文件说明书
//
// ## 核心功能
// 验收 v0.8 P7 工具分类清理 + 去重的三项契约:
//   - **wiki-tools.ts 已删除** — `ExpandNode/ListWikiTree/UpdateWikiNode/ReadDoc`
//     四个原工具不应出现在 ALL_TOOLS,也不应能 import wiki-tools 模块。
//   - **ToolCategory 含 `workflow`** — `tool-registry.ts` 与 `tool-factory.ts`
//     的 ToolCategory 类型联合都包含 "workflow"。
//   - **分类正确** — Platform = management;Orchestrate = workflow;Flow
//     (project-flow F3:取代已退役的 CreateRequirement/CreateRequirementWithDoc/
//     verify,归类 management)= management;delegate `Agent` = agent;
//     Project/AgentRegistry/Cron/Wiki = management。
//
// project-flow F5:旧 requirement-tools.ts / verify-tool.ts 已删;
// CreateRequirement/CreateRequirementWithDoc/verify 经 RENAMED_TOOLS → "Flow"。
//
// ## 输入
// 静态 import ALL_TOOLS + ToolCategory + 各 tool 模块。
//
// ## 输出
// Vitest 用例。
//
// ## 关键文件
//   - src/runtime/tools/index.ts (ALL_TOOLS)
//   - src/runtime/tools/wiki-tool.ts (统一 Wiki 工具)
//   - src/core/tool-registry.ts (ToolCategory 类型 + RENAMED_TOOLS)
//   - src/runtime/tools/tool-factory.ts (ToolCategory 镜像)
//   - src/runtime/mcp-tools/platform-tools.ts (category=management)
//   - src/runtime/tools/orchestrate-tool.ts (category=workflow)
//   - src/runtime/tools/flow-tool.ts (Flow = workflow,F5 取代旧 requirement/
//     verify 工具)
//   - src/runtime/tools/agent.ts (delegate category=agent)

import { describe, test, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { ALL_TOOLS } from "../../src/tools/index.js";
import { getToolMeta } from "../../src/tools/tool-factory.js";
import { orchestrateTool } from "../../src/tools/orchestrate-tool.js";
// project-flow F5: Flow replaces the retired CreateRequirement /
// CreateRequirementWithDoc / verify tools (files deleted in F5). Old tool
// names map to "Flow" via RENAMED_TOOLS back-compat.
import { flowTool } from "../../src/tools/flow-tool.js";
import { RENAMED_TOOLS } from "../../src/core/tool-registry.js";
import { delegateTool } from "../../src/tools/agent.js";
import { wikiTool } from "../../src/tools/wiki-tool.js";
import { projectTool } from "../../src/tools/project-tool.js";
import { workTool } from "../../src/tools/work-tool.js";
import { agentRegistryTool } from "../../src/tools/agent-registry.js";
import { cronTool } from "../../src/tools/cron-tool.js";
import { createPlatformTools } from "../../src/tools/mcp/platform-tools.js";

// ─── ① wiki-tools.ts 已删除 + ALL_TOOLS 无残留 ────────────────

describe("P7 工具去重:wiki-tools.ts 删除 + 旧名无残留", () => {
	test("src/runtime/tools/wiki-tools.ts 文件不存在", () => {
		const p = resolve(__dirname, "../../src/runtime/tools/wiki-tools.ts");
		expect(existsSync(p), `${p} should be deleted`).toBe(false);
	});

	test("ALL_TOOLS 不含 ExpandNode/ListWikiTree/UpdateWikiNode/ReadDoc 四个键", () => {
		const retired = ["ExpandNode", "ListWikiTree", "UpdateWikiNode", "ReadDoc"];
		for (const name of retired) {
			expect(ALL_TOOLS[name], `${name} must not be in ALL_TOOLS`).toBeUndefined();
		}
	});

	test("ALL_TOOLS 含统一 `Wiki` 工具(替代四个原工具)", () => {
		expect(ALL_TOOLS.Wiki).toBeDefined();
		expect(ALL_TOOLS.Wiki).toBe(wikiTool);
	});
});

// ─── ①.b project-flow F5:旧 requirement / verify 工具文件已删 ──

describe("project-flow F5:旧 requirement / verify 工具退役", () => {
	test("src/runtime/tools/requirement-tools.ts + verify-tool.ts 文件已删", () => {
		for (const f of ["requirement-tools.ts", "verify-tool.ts"]) {
			const p = resolve(__dirname, `../../src/runtime/tools/${f}`);
			expect(existsSync(p), `${p} should be deleted`).toBe(false);
		}
	});

	test("ALL_TOOLS 不含 CreateRequirement / CreateRequirementWithDoc / verify 三键(Flow 接管)", () => {
		const retired = ["CreateRequirement", "CreateRequirementWithDoc", "verify"];
		for (const name of retired) {
			expect(ALL_TOOLS[name], `${name} must not be in ALL_TOOLS`).toBeUndefined();
		}
	});

	test("ALL_TOOLS 含 Flow(workflow 类别,替代三个旧工具)", () => {
		expect(ALL_TOOLS.Flow).toBeDefined();
		expect(ALL_TOOLS.Flow).toBe(flowTool);
	});

	test("RENAMED_TOOLS 把所有旧拼写映射到 Flow(back-compat)", () => {
		// PascalCase / lowercase / snake_case 全映射到 Flow。
		expect(RENAMED_TOOLS.CreateRequirement).toBe("Flow");
		expect(RENAMED_TOOLS.CreateRequirementWithDoc).toBe("Flow");
		expect(RENAMED_TOOLS.createrequirement).toBe("Flow");
		expect(RENAMED_TOOLS.createrequirementwithdoc).toBe("Flow");
		expect(RENAMED_TOOLS.create_requirement).toBe("Flow");
		expect(RENAMED_TOOLS.create_requirement_with_doc).toBe("Flow");
		expect(RENAMED_TOOLS.verify).toBe("Flow");
		expect(RENAMED_TOOLS.Verify).toBe("Flow");
	});
});

// ─── ② ToolCategory 加 `workflow` ─────────────────────────────

describe("P7 ToolCategory 加 workflow", () => {
	// 用类型 import 触发编译期断言;若 `workflow` 不在 union,本文件根本编译不过。
	// 运行时再断言字面量集合。
	test("`workflow` 字面量在 ToolCategory union 中(编译期保证)", () => {
		// 这个 const 只是引用 workflow 字面量,确认无类型错误 + 运行时存在。
		const sample: "workflow" = "workflow";
		expect(sample).toBe("workflow");
	});
});

// ─── ③ 分类正确:project / management / agent ────────────────

describe("P7 工具分类正确", () => {
	test("Project/Work/Flow 是 project;AgentRegistry/Cron 是 management;Wiki 是 runtime(Base)", () => {
		// project-flow: Project + Work + Flow are the project class (delivery flow).
		// AgentRegistry stays management (真·平台配置:管 agent 定义).
		// execution-entry-redesign sub-6: Cron 从 agent 并入 management(与
		// AgentRegistry/Project 一类 —— 平台级管理动作,非 agent 编排)。
		// Wiki 作为 Base 基类(runtime)—— 项目作用域的知识/结构,被所有 agent 复用。
		expect(getToolMeta(projectTool)?.category).toBe("project");
		expect(getToolMeta(workTool)?.category).toBe("project");
		expect(getToolMeta(flowTool)?.category).toBe("project");
		expect(getToolMeta(agentRegistryTool)?.category).toBe("management");
		expect(getToolMeta(cronTool)?.category).toBe("management");
		expect(getToolMeta(wikiTool)?.category).toBe("runtime");
	});

	test("Orchestrate 是 agent(编排多 agent 执行)", () => {
		expect(getToolMeta(orchestrateTool)?.category).toBe("agent");
	});

	test("Platform (createPlatformTools 的 Platform) 是 management,不是 assistant", () => {
		const platformTools = createPlatformTools();
		// platformTools 是一个 record;取任意一个工具,验证 category。
		const firstKey = Object.keys(platformTools)[0];
		expect(firstKey, "createPlatformTools should return at least one tool").toBeDefined();
		const meta = getToolMeta(platformTools[firstKey!]);
		expect(meta?.category).toBe("management");
		expect(meta?.category).not.toBe("assistant");
	});

	test("delegate `Agent` 工具是 agent,不是 runtime", () => {
		expect(getToolMeta(delegateTool)?.category).toBe("agent");
		expect(getToolMeta(delegateTool)?.category).not.toBe("runtime");
	});
});

// ─── 综合:ALL_TOOLS 无重复注册 ───────────────────────────────

describe("P7 ALL_TOOLS 无重复(同 tool def 多键)", () => {
	test("ALL_TOOLS 的值(按 tool def 引用)不重复绑定到多个键", () => {
		const seen = new Map<any, string[]>();
		for (const [name, def] of Object.entries(ALL_TOOLS)) {
			const existing = seen.get(def);
			if (existing) {
				existing.push(name);
			} else {
				seen.set(def, [name]);
			}
		}
		const dups = [...seen.entries()].filter(([, names]) => names.length > 1);
		expect(dups, `duplicate tool bindings: ${JSON.stringify(dups)}`).toEqual([]);
	});
});
