// 单测:action 化 Agent 委派工具(list / delegate by name / 临时委派)
//
// 验证 v0.8 委派重构:单 Agent 工具,list 现查 caller subagents,delegate
// 按 name 解析(现查身份),白名单语义(不在列表报错),目标被删报错不回落。
import { describe, test, expect } from "vitest";
import { delegateTool } from "../../src/runtime/tools/agent.js";
import { getToolExecute } from "../../src/runtime/tools/tool-factory.js";

const exec = getToolExecute(delegateTool)!;

/** Build a ctx with a caller + its subagents + a live resolveAgent. */
function makeCtx(opts: {
	callerId?: string;
	callerSubagents?: Array<{ agentId: string; name?: string; description?: string }>;
	agents?: Record<string, any>;
	delegateTask?: (task: string, o: any) => Promise<string>;
	delegateTaskBackground?: (task: string, o: any) => string;
} = {}) {
	const callerId = opts.callerId ?? "caller-1";
	const agents = opts.agents ?? {};
	// Default: caller exists with the given subagents.
	agents[callerId] = agents[callerId] ?? {
		id: callerId, name: "Caller",
		subagents: opts.callerSubagents ?? [],
	};
	return {
		agentId: callerId,
		workingDir: ".",
		resolveAgent: (id: string) => agents[id] ? { ...agents[id] } : undefined,
		delegateTask: opts.delegateTask ?? (async () => "(default)"),
		delegateTaskBackground: opts.delegateTaskBackground,
		toolConfig: {},
	} as any;
}

describe("Agent tool — list", () => {
	test("list 返回 caller 现查的 subagent 摘要(含 name/model,无 systemPrompt)", async () => {
		const ctx = makeCtx({
			callerSubagents: [{ agentId: "dev-1", name: "Developer", description: "代码实现" }],
			agents: {
				"dev-1": { id: "dev-1", name: "Developer", model: "glm-5.2", systemPrompt: "BIG" },
			},
		});
		const r = JSON.parse(await exec({ action: "list" }, ctx));
		expect(r).toHaveLength(1);
		expect(r[0].name).toBe("Developer");
		expect(r[0].model).toBe("glm-5.2");
		expect(r[0].description).toBe("代码实现");
		expect(r[0]).not.toHaveProperty("systemPrompt");
	});

	test("list 无 subagents → 提示空", async () => {
		const r = await exec({ action: "list" }, makeCtx());
		expect(r).toMatch(/no subagents/i);
	});

	test("list 标记目标已被删(stale reference)", async () => {
		const ctx = makeCtx({
			callerSubagents: [{ agentId: "gone-1", name: "Ghost" }],
			agents: {}, // target missing
		});
		const r = JSON.parse(await exec({ action: "list" }, ctx));
		expect(r[0].name).toBe("Ghost");
		expect(r[0].note).toMatch(/not found/i);
	});
});

describe("Agent tool — delegate by name", () => {
	test("命中 name → 用 target 身份调 delegateTask(传 targetAgentId)", async () => {
		let captured: any;
		const ctx = makeCtx({
			callerSubagents: [{ agentId: "dev-1", name: "Developer" }],
			agents: {
				"dev-1": { id: "dev-1", name: "Developer", model: "glm-5.2", systemPrompt: "P", toolPolicy: { tools: {} } },
			},
			delegateTask: async (task, o) => { captured = { task, o }; return "done"; },
		});
		const r = await exec({ action: "delegate", task: "write hello", subagent: "Developer" }, ctx);
		expect(r).toBe("done");
		expect(captured.task).toBe("write hello");
		expect(captured.o.targetAgentId).toBe("dev-1");
		expect(captured.o.systemPrompt).toBe("P");
		expect(captured.o.toolPolicy).toEqual({ tools: {} });
	});

	test("name 匹配 entry.name 覆盖优先于 target.name", async () => {
		const ctx = makeCtx({
			callerSubagents: [{ agentId: "dev-1", name: "Coder" }],
			agents: { "dev-1": { id: "dev-1", name: "Developer" } },
		});
		// entry.name = "Coder" → 必须用 "Coder" 才匹配,"Developer" 不匹配
		const ok = await exec({ action: "delegate", task: "t", subagent: "Coder" }, ctx);
		expect(ok).not.toMatch(/no subagent named/);
		const miss = await exec({ action: "delegate", task: "t", subagent: "Developer" }, ctx);
		expect(miss).toMatch(/no subagent named "Developer"/);
	});

	test("name 未命中 → 报错并列出可用名", async () => {
		const ctx = makeCtx({
			callerSubagents: [{ agentId: "dev-1", name: "Developer" }],
			agents: { "dev-1": { id: "dev-1", name: "Developer" } },
		});
		const r = await exec({ action: "delegate", task: "t", subagent: "Nope" }, ctx);
		expect(r).toMatch(/no subagent named "Nope"/);
		expect(r).toMatch(/Available.*Developer/);
	});

	test("target agentId 查不到 → 报错(不静默回落 caller)", async () => {
		const ctx = makeCtx({
			callerSubagents: [{ agentId: "gone-1", name: "Ghost" }],
			agents: {}, // target missing
		});
		const r = await exec({ action: "delegate", task: "t", subagent: "Ghost" }, ctx);
		expect(r).toMatch(/no longer exists|stale/i);
	});
});

describe("Agent tool — ephemeral delegate (no subagent)", () => {
	test("不传 subagent → 临时委派,传 inline model/systemPrompt", async () => {
		let captured: any;
		const ctx = makeCtx({
			delegateTask: async (task, o) => { captured = { task, o }; return "ok"; },
		});
		await exec({ action: "delegate", task: "explore", model: "m1", systemPrompt: "custom" }, ctx);
		expect(captured.o.targetAgentId).toBeUndefined();
		expect(captured.o.model).toBe("m1");
		expect(captured.o.systemPrompt).toBe("custom");
	});
});

describe("Agent tool — non-blocking + validation", () => {
	test("mode=non_blocking → 走 delegateTaskBackground,返回 task_id", async () => {
		const ctx = makeCtx({
			delegateTaskBackground: (_t, _o) => "task-xyz",
		});
		const r = await exec({ action: "delegate", task: "long", mode: "non_blocking" }, ctx);
		expect(r).toMatch(/task_id: task-xyz/);
	});

	test("delegate 缺 task → 报错", async () => {
		const r = await exec({ action: "delegate" } as any, makeCtx());
		expect(r).toMatch(/task.*required/i);
	});
});
