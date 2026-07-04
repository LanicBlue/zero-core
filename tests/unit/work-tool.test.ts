// Work 工具单元测试(project-flow — project 类三工具之一)
//
// 验证 Work action 工具的 create/update/delete/list/fire 经 ctx.management
// (ManagementService work 方法)正确路由,字段映射 + required 字段校验 + 门控。

import { describe, test, expect } from "vitest";
import { workTool } from "../../src/runtime/tools/work-tool.js";
import { getToolExecute, getToolMeta } from "../../src/runtime/tools/tool-factory.js";

function makeCtx(overrides: Record<string, any> = {}) {
	const calls: any[] = [];
	const mgmt = {
		createProjectWork: (pid: string, body: any) => {
			calls.push({ m: "createProjectWork", pid, body });
			return { id: "work-1", projectId: pid, name: body.name, agentId: body.agentId ?? null, enabled: body.enabled ?? true };
		},
		updateProjectWork: (id: string, patch: any) => {
			calls.push({ m: "updateProjectWork", id, patch });
			return { id, ...patch };
		},
		deleteProjectWork: (id: string) => {
			calls.push({ m: "deleteProjectWork", id });
		},
		getProjectWorks: (pid: string) => {
			calls.push({ m: "getProjectWorks", pid });
			return [{ id: "work-1", projectId: pid, name: "需求管理" }];
		},
		triggerProjectWork: async (id: string) => {
			calls.push({ m: "triggerProjectWork", id });
			return { status: "ok", sessionId: "sess-1" };
		},
	};
	return { ctx: { management: mgmt, ...overrides }, calls };
}

async function exec(input: any, ctxOverride: Record<string, any> = {}) {
	const { ctx } = makeCtx(ctxOverride);
	const execute = getToolExecute(workTool)!;
	return execute(input, ctx as any);
}

describe("Work tool", () => {
	test("create routes to createProjectWork with workName→name mapping", async () => {
		const r = await exec({ action: "create", projectId: "p1", workName: "需求管理", actionPrompt: "do X", requiredTools: ["Flow"] });
		expect(r).toContain("work-1");
		const { ctx, calls } = makeCtx();
		await getToolExecute(workTool)!({ action: "create", projectId: "p1", workName: "需求管理" }, ctx as any);
		expect(calls[0].m).toBe("createProjectWork");
		expect(calls[0].body.name).toBe("需求管理");
	});

	test("create requires projectId + workName", async () => {
		expect(await exec({ action: "create", workName: "x" })).toMatch(/projectId/);
		expect(await exec({ action: "create", projectId: "p1" })).toMatch(/workName/);
	});

	test("update builds a sparse patch (only supplied fields)", async () => {
		const { ctx, calls } = makeCtx();
		await getToolExecute(workTool)!({ action: "update", workId: "w1", enabled: false }, ctx as any);
		expect(calls[0].m).toBe("updateProjectWork");
		expect(calls[0].patch).toEqual({ enabled: false });
	});

	test("update requires workId", async () => {
		expect(await exec({ action: "update", enabled: false })).toMatch(/workId/);
	});

	test("delete routes + requires workId", async () => {
		const r = await exec({ action: "delete", workId: "w1" });
		expect(r).toContain("success");
		expect(await exec({ action: "delete" })).toMatch(/workId/);
	});

	test("list routes to getProjectWorks + requires projectId", async () => {
		const r = await exec({ action: "list", projectId: "p1" });
		expect(r).toContain("需求管理");
		expect(await exec({ action: "list" })).toMatch(/projectId/);
	});

	test("fire routes to triggerProjectWork + requires workId", async () => {
		const r = await exec({ action: "fire", workId: "w1" });
		expect(r).toMatch(/ok|sess-1/);
		expect(await exec({ action: "fire" })).toMatch(/workId/);
	});

	test("gating: no ctx.management → friendly error", async () => {
		const r = await exec({ action: "list", projectId: "p1" }, { management: undefined });
		expect(r).toMatch(/ctx.management/);
	});

	test("category is project (project class)", () => {
		expect(getToolMeta(workTool)?.category).toBe("project");
	});
});
