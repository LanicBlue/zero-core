// 单测:action 工具的 inputSchema 必须是顶层 type:object
//
// # 文件说明书
//
// ## 核心功能
// 断言五个 action 工具(Project/AgentRegistry/Cron/Wiki/Task)+ Cron 的 schedule
// schema,经 zod v4 `~standard.jsonSchema` 转换后(AI SDK 走的就是这条路径),
// 顶层是 `type: "object"`,且**无顶层 oneOf/anyOf**。
//
// ## 为什么需要这个测试
// LLM 函数调用协议(OpenAI/GLM/Anthropic)要求工具 parameters 顶层是
// `type: object`;顶层 oneOf(discriminatedUnion 产生的)会被大多数 provider
// 丢弃或误解析,导致模型空手调 `{}`,zod 随即报 "Invalid discriminator value"。
// 这正是 zero 在生产中踩过的坑。E2E tool-wiring 测的是「工具能被执行」,
// 但 mock 直接吐 tool-call、绕过了「LLM 读 schema 决定传什么」,所以抓不住
// 这类回归。本单测直接验 schema 形状,补上这道缺口。
//
// ## 维护规则
// 新增 action 工具:把它的 schema 加进 ACTION_SCHEMAS,自动覆盖。
//

import { describe, it, expect } from "vitest";
import { projectActionSchema } from "../../src/tools/project-tool.js";
import { agentRegistryActionSchema } from "../../src/tools/agent-registry.js";
import { cronActionSchema } from "../../src/tools/cron-tool.js";
import { wikiActionSchema } from "../../src/tools/wiki-tool.js";
import { taskActionSchema } from "../../src/tools/task-tool.js";
import { z } from "zod";

// Mirror the four flat schemas. If any regresses to z.discriminatedUnion at the
// top level, its JSON schema becomes { oneOf: [...] } with no top-level type.
const ACTION_SCHEMAS: Record<string, z.ZodTypeAny> = {
	Project: projectActionSchema,
	AgentRegistry: agentRegistryActionSchema,
	Cron: cronActionSchema,
	Wiki: wikiActionSchema,
	Task: taskActionSchema,
};

async function toJsonSchema(schema: z.ZodTypeAny): Promise<any> {
	// AI SDK (provider-utils asSchema) routes zod v4 through the standard schema
	// interface; this is the exact JSON schema the LLM receives.
	const std = (schema as any)["~standard"];
	return std.jsonSchema.input({ target: "draft-07" });
}

describe("action tool schemas are provider-compatible (top-level type:object)", () => {
	for (const [name, schema] of Object.entries(ACTION_SCHEMAS)) {
		it(`${name} inputSchema → top-level type:object, no top-level oneOf/anyOf`, async () => {
			const js = await toJsonSchema(schema);
			expect(js.type, `${name} must be top-level type:object`).toBe("object");
			expect(js.oneOf, `${name} must NOT have top-level oneOf (discriminatedUnion regression)`).toBeUndefined();
			expect(js.anyOf, `${name} must NOT have top-level anyOf`).toBeUndefined();
			// action discriminator must be a required enum property.
			expect(js.properties?.action, `${name} must have an 'action' property`).toBeDefined();
		});

		it(`${name} rejects empty {} (action required)`, async () => {
			const std = (schema as any)["~standard"];
			const res = await std.validate({});
			// empty input must NOT pass — action is the discriminator.
			expect(res).toHaveProperty("issues");
		});
	}
});
