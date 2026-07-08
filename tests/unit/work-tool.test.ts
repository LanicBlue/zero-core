// Work 工具单元测试(project-flow — project 类三工具之一)
//
// 验证 Work action 工具的 create/update/delete/list/fire 经 ManagementService
// work 方法正确路由,字段映射 + required 字段校验 + 门控。
//
// tool-decoupling sub-3:工具迁新签名(execute(input, callerCtx) → ToolResult
// + format)。测试改用 runTool helper 同时拿 JSON + 文本断言两边;management
// 经 setManagementService 单例注册(决策 1:工具直读单例,不经 ctx)。

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { workTool } from "../../src/tools/work-tool.js";
import { getToolMeta } from "../../src/tools/tool-factory.js";
import { setManagementService } from "../../src/server/management-service.js";
import { runTool } from "./helpers/tool-decoupling-helpers.js";

function makeMgmt() {
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
	return { mgmt, calls };
}

let activeMgmt: ReturnType<typeof makeMgmt> | null = null;

beforeEach(() => {
	activeMgmt = makeMgmt();
	// 决策 1:工具直读 getManagementService() 单例。测试注册 mock。
	setManagementService(activeMgmt.mgmt as any);
});

afterEach(() => {
	setManagementService(undefined);
	activeMgmt = null;
});

async function exec(input: any): Promise<string> {
	// 返 format 后的文本(同 sub-3 前 agent 视角的 string 返值)。
	const { text } = await runTool(workTool, input, { caller: "internal" });
	return text;
}

describe("Work tool", () => {
	test("create routes to createProjectWork with workName→name mapping", async () => {
		const r = await exec({ action: "create", projectId: "p1", workName: "需求管理", actionPrompt: "do X", requiredTools: ["Flow"] });
		expect(r).toContain("work-1");
		// 也验 JSON 边:execute 返 ToolResult,result 携带 store 返值。
		const { json } = await runTool(workTool, { action: "create", projectId: "p1", workName: "需求管理" }, { caller: "internal" });
		expect(json.ok).toBe(true);
		expect((json.data as any).result.id).toBe("work-1");
		expect(activeMgmt!.calls[0].m).toBe("createProjectWork");
		expect(activeMgmt!.calls[0].body.name).toBe("需求管理");
	});

	test("create requires projectId + workName", async () => {
		expect(await exec({ action: "create", workName: "x" })).toMatch(/projectId/);
		expect(await exec({ action: "create", projectId: "p1" })).toMatch(/workName/);
	});

	test("update builds a sparse patch (only supplied fields)", async () => {
		await runTool(workTool, { action: "update", workId: "w1", enabled: false }, { caller: "internal" });
		expect(activeMgmt!.calls[0].m).toBe("updateProjectWork");
		expect(activeMgmt!.calls[0].patch).toEqual({ enabled: false });
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

	test("gating: no ManagementService singleton → friendly error", async () => {
		// 撤销单例 → 工具优雅报错(不崩)。
		setManagementService(undefined);
		const r = await exec({ action: "list", projectId: "p1" });
		expect(r).toMatch(/ManagementService/);
	});

	test("category is project (project class)", () => {
		expect(getToolMeta(workTool)?.category).toBe("project");
	});
});
