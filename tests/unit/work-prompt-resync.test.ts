// 单元测试:ManagementService.resyncDefaultWorkPrompts —— 默认工位 prompt 安全刷新
//
// # 文件说明书
//
// ## 核心功能
// 锁死存量项目的默认工位(文档充实/文档重建)actionPrompt 刷新到最新模板时的安全不变量:
//   1. 旧默认 prompt(含老签名 + 无新 marker)→ 更新到最新
//   2. 用户自定义 prompt(无老签名)→ 不动
//   3. 已是最新(含 marker)→ 不动(幂等)
//   4. 非默认工位名 → 不动
//
import { describe, test, expect } from "vitest";
import { ManagementService } from "../../src/server/management-service.js";
import { DEFAULT_PROJECT_WORKS } from "../../src/server/builtin-work-templates.js";

const PROJECT = { id: "proj-1", name: "Demo", workspaceDir: "/tmp/demo" } as any;

function latestPrompt(name: string): string {
	const seed = DEFAULT_PROJECT_WORKS(PROJECT.id, PROJECT.name).find((w) => w.name === name);
	return seed?.actionPrompt ?? "";
}

function makeSvc(works: any[]): { svc: ManagementService; updates: Array<{ id: string; patch: any }> } {
	const updates: Array<{ id: string; patch: any }> = [];
	const projectStore = {
		list: () => [PROJECT],
		get: (id: string) => (id === PROJECT.id ? PROJECT : undefined),
	} as any;
	const projectWorkStore = {
		listByProject: () => works,
		update: (id: string, patch: any) => { updates.push({ id, patch }); return works.find((w) => w.id === id); },
		get: (id: string) => works.find((w) => w.id === id),
	} as any;
	const svc = new ManagementService({ agentStore: {} as any, projectStore } as any);
	svc.setProjectWorkStore(projectWorkStore);
	return { svc, updates };
}

describe("resyncDefaultWorkPrompts — safe template refresh", () => {
	test("updates an old default prompt (signature present, marker absent) to the latest", () => {
		const latest = latestPrompt("文档充实");
		const works = [
			{ id: "w-old", name: "文档充实", actionPrompt: "骨架扫描已经建好了结构节点 …旧默认…", requiredTools: [], agentId: "a1", hooks: [], enabled: true, contextPolicy: {} },
		];
		const { svc, updates } = makeSvc(works);
		svc.resyncDefaultWorkPrompts();
		expect(updates).toHaveLength(1);
		expect(updates[0].id).toBe("w-old");
		expect(updates[0].patch.actionPrompt).toBe(latest);
	});

	test("does NOT clobber a user-customized prompt (no old signature)", () => {
		const works = [
			{ id: "w-custom", name: "文档充实", actionPrompt: "我自己的充实流程,完全重写", requiredTools: [], agentId: "a1", hooks: [], enabled: true, contextPolicy: {} },
		];
		const { svc, updates } = makeSvc(works);
		svc.resyncDefaultWorkPrompts();
		expect(updates).toHaveLength(0);
	});

	test("idempotent — already-up-to-date prompt (has marker) is not re-written", () => {
		const latest = latestPrompt("文档重建");
		const works = [
			{ id: "w-done", name: "文档重建", actionPrompt: latest, requiredTools: [], agentId: "a1", hooks: [], enabled: true, contextPolicy: {} },
		];
		const { svc, updates } = makeSvc(works);
		svc.resyncDefaultWorkPrompts();
		expect(updates).toHaveLength(0);
	});

	test("leaves non-default work names and other fields untouched", () => {
		const works = [
			{ id: "w-other", name: "我的自定义工位", actionPrompt: "anything", requiredTools: [], agentId: "a1", hooks: [], enabled: true, contextPolicy: {} },
		];
		const { svc, updates } = makeSvc(works);
		svc.resyncDefaultWorkPrompts();
		expect(updates).toHaveLength(0);
	});
});
