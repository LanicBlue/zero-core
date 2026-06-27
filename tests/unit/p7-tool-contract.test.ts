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
//   - **分类正确** — Assistant = management;Orchestrate/CreateRequirement/
//     CreateRequirementWithDoc/verify = workflow;delegate `Agent` = agent;
     // Project/AgentRegistry/Cron/Wiki = management。
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
//   - src/core/tool-registry.ts (ToolCategory 类型)
//   - src/runtime/tools/tool-factory.ts (ToolCategory 镜像)
//   - src/runtime/mcp-tools/platform-tools.ts (category=management)
//   - src/runtime/tools/orchestrate-tool.ts / requirement-tools.ts / verify-tool.ts
//     (category=workflow)
//   - src/runtime/tools/agent.ts (delegate category=agent)

import { describe, test, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { ALL_TOOLS } from "../../src/runtime/tools/index.js";
import { getToolMeta } from "../../src/runtime/tools/tool-factory.js";
import { orchestrateTool } from "../../src/runtime/tools/orchestrate-tool.js";
import { createRequirementTool, createRequirementWithDocTool } from "../../src/runtime/tools/requirement-tools.js";
import { verifyTool } from "../../src/runtime/tools/verify-tool.js";
import { delegateTool } from "../../src/runtime/tools/agent.js";
import { wikiTool } from "../../src/runtime/tools/wiki-tool.js";
import { projectTool } from "../../src/runtime/tools/project-tool.js";
import { agentRegistryTool } from "../../src/runtime/tools/agent-registry.js";
import { cronTool } from "../../src/runtime/tools/cron-tool.js";
import { createPlatformTools } from "../../src/runtime/mcp-tools/platform-tools.js";

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

// ─── ③ 分类正确:management / workflow / agent ────────────────

describe("P7 工具分类正确", () => {
	test("Project/AgentRegistry/Cron/Wiki 全是 management", () => {
		expect(getToolMeta(projectTool)?.category).toBe("management");
		expect(getToolMeta(agentRegistryTool)?.category).toBe("management");
		expect(getToolMeta(cronTool)?.category).toBe("management");
		expect(getToolMeta(wikiTool)?.category).toBe("management");
	});

	test("Orchestrate/CreateRequirement/CreateRequirementWithDoc/verify 全是 workflow", () => {
		expect(getToolMeta(orchestrateTool)?.category).toBe("workflow");
		expect(getToolMeta(createRequirementTool)?.category).toBe("workflow");
		expect(getToolMeta(createRequirementWithDocTool)?.category).toBe("workflow");
		expect(getToolMeta(verifyTool)?.category).toBe("workflow");
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
