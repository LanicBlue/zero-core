// EnrichmentRunner 单元测试
//
// # 文件说明书
//
// ## 核心功能
// 验证 M2 核心交付:
//   - resolveAgent(via): role 路径 ensure 全局角色 agent + interactive 派生;
//     agentId 路径直接用现有 agent。
//   - runProjectEnrichment: resolveSessionByRoleProject 路由出项目 session(复用),
//     project_jobs 记一行 running,fire-and-forget sendRolePrompt(立即返回),
//     run 完成 → markCompleted / 失败 → markFailed。
//   - 配置驱动:默认 via={role:"archivist"},代码不硬绑(换 role 可换 agent)。
//
// ## 输入
// 临时 SessionDB + 真实 stores + stub AgentService(capture sendRolePrompt,
// 可控 resolve/reject)。
//

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { TemplateStore } from "../../src/server/template-store.js";
import { WikiStore } from "../../src/server/wiki-node-store.js";
import { ProjectJobStore } from "../../src/server/project-job-store.js";
import { EnrichmentRunner } from "../../src/server/enrichment-runner.js";
import { runMigrations } from "../../src/server/db-migration.js";

let tmpDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let templateStore: TemplateStore;
let wikiStore: WikiStore;
let projectJobStore: ProjectJobStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-enrich-"));
	const workspaceDir = join(tmpDir, "ws");
	mkdirSync(workspaceDir, { recursive: true });

	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	templateStore = new TemplateStore(sessionDB);
	wikiStore = new WikiStore(sessionDB);
	projectJobStore = new ProjectJobStore(sessionDB);

	projectStore.create({ name: "Test", workspaceDir } as any);
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Stub AgentService whose sendRolePrompt we can control (resolve/reject). */
function makeStubAgentService() {
	const calls: Array<{ agentId: string; sessionId: string; role: string; prompt: string }> = [];
	let nextBehavior: "resolve" | "reject" = "resolve";
	const svc: any = {
		calls,
		sendRolePrompt: vi.fn(async (agentId: string, sessionId: string, role: string, prompt: string) => {
			calls.push({ agentId, sessionId, role, prompt });
			if (nextBehavior === "reject") throw new Error("simulated enrichment failure");
		}),
		_setBehavior(b: "resolve" | "reject") { nextBehavior = b; },
	};
	return svc;
}

function getProjectId() {
	return projectStore.list()[0].id;
}

describe("EnrichmentRunner.resolveAgent", () => {
	test("role path: ensures a global role agent + interactive=false for archivist", () => {
		const runner = new EnrichmentRunner({
			agentService: makeStubAgentService(), agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		const resolved = runner.resolveAgent({ role: "archivist" });
		expect(resolved.role).toBe("archivist");
		expect(resolved.interactive).toBe(false); // worker role → 永久只读
		// global role agent actually created
		expect(agentStore.get(resolved.agentId)).toBeDefined();
		expect(agentStore.get(resolved.agentId)!.name).toBe("Archivist");
	});

	test("role path: conversational role → interactive=true", () => {
		const runner = new EnrichmentRunner({
			agentService: makeStubAgentService(), agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		const resolved = runner.resolveAgent({ role: "analyst" });
		expect(resolved.interactive).toBe(true);
	});

	test("agentId path: uses the given agent directly", () => {
		const existing = agentStore.create({ name: "Custom-Enricher", systemPrompt: "x" } as any);
		const runner = new EnrichmentRunner({
			agentService: makeStubAgentService(), agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		const resolved = runner.resolveAgent({ agentId: existing.id, role: "archivist" });
		expect(resolved.agentId).toBe(existing.id);
		expect(resolved.interactive).toBe(false);
	});

	test("agentId path: throws if agent not found", () => {
		const runner = new EnrichmentRunner({
			agentService: makeStubAgentService(), agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		expect(() => runner.resolveAgent({ agentId: "nope" })).toThrow(/Agent not found/);
	});
});

describe("EnrichmentRunner.runProjectEnrichment", () => {
	test("routes project session, writes a running job, fires sendRolePrompt, returns immediately", async () => {
		const stub = makeStubAgentService();
		const runner = new EnrichmentRunner({
			agentService: stub, agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		const projectId = getProjectId();

		const result = await runner.runProjectEnrichment(projectId, { via: { role: "archivist" } });

		// returns job + session ids immediately
		expect(result.jobId).toBeTruthy();
		expect(result.sessionId).toBeTruthy();

		// job recorded as running
		const job = projectJobStore.get(result.jobId)!;
		expect(job.status).toBe("running");
		expect(job.projectId).toBe(projectId);
		expect(job.jobType).toBe("wiki-enrich");

		// sendRolePrompt called once with the resolved agent + project session
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0].role).toBe("archivist");
		expect(stub.calls[0].sessionId).toBe(result.sessionId);
	});

	test("on run completion → job marked completed", async () => {
		const stub = makeStubAgentService();
		stub._setBehavior("resolve");
		const runner = new EnrichmentRunner({
			agentService: stub, agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		const projectId = getProjectId();
		const { jobId } = await runner.runProjectEnrichment(projectId, { via: { role: "archivist" } });

		// fire-and-forget; allow the microtask chain to flush
		await new Promise((r) => setTimeout(r, 10));

		const job = projectJobStore.get(jobId)!;
		expect(job.status).toBe("completed");
		expect(job.finishedAt).toBeTruthy();
	});

	test("on run failure → job marked failed with error", async () => {
		const stub = makeStubAgentService();
		stub._setBehavior("reject");
		const runner = new EnrichmentRunner({
			agentService: stub, agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		const projectId = getProjectId();
		const { jobId } = await runner.runProjectEnrichment(projectId, { via: { role: "archivist" } });

		await new Promise((r) => setTimeout(r, 10));

		const job = projectJobStore.get(jobId)!;
		expect(job.status).toBe("failed");
		expect(job.error).toMatch(/simulated enrichment failure/);
	});

	test("second enrichment on same project reuses the same session (find-or-create)", async () => {
		const stub = makeStubAgentService();
		const runner = new EnrichmentRunner({
			agentService: stub, agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		const projectId = getProjectId();
		const a = await runner.runProjectEnrichment(projectId, { via: { role: "archivist" } });
		const b = await runner.runProjectEnrichment(projectId, { via: { role: "archivist" } });
		expect(a.sessionId).toBe(b.sessionId);
	});
});
