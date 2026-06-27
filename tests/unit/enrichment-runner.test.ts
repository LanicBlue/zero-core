// EnrichmentRunner 单元测试
//
// # 文件说明书
//
// ## 核心功能
// 验证 v0.8 推动弃用工作流角色后的 enrichment:
//   - resolveAgent(via): **无 fallback** —— via.agentId 必填,必须存在 + 配了
//     Wiki 工具;不再自动建角色 agent(role 路径已删)。
//   - runProjectEnrichment: resolveSessionByRoleProject 路由出项目 session(复用),
//     project_jobs 记一行 running,fire-and-forget **sendProjectPrompt**(去-role
//     触发,注入 wikiStore/projectContext),run 完成 → markCompleted / 失败 → markFailed。
//
// ## 输入
// 临时 SessionDB + 真实 stores + stub AgentService(capture sendProjectPrompt,
// 可控 resolve/reject)+ 一个带 Wiki 工具的 agent。
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

/** Stub AgentService whose sendProjectPrompt we can control (resolve/reject). */
function makeStubAgentService() {
	const calls: Array<{ agentId: string; sessionId: string; prompt: string; ctx: any }> = [];
	let nextBehavior: "resolve" | "reject" = "resolve";
	const svc: any = {
		calls,
		sendProjectPrompt: vi.fn(async (agentId: string, sessionId: string, prompt: string, ctx: any) => {
			calls.push({ agentId, sessionId, prompt, ctx });
			if (nextBehavior === "reject") throw new Error("simulated enrichment failure");
		}),
		_setBehavior(b: "resolve" | "reject") { nextBehavior = b; },
	};
	return svc;
}

/** 创建一个配了 Wiki 工具(autoApprove)的 agent —— enrichment 的合法目标。 */
function makeWikiAgent(name = "Wiki-Agent") {
	return agentStore.create({
		name,
		systemPrompt: "x",
		toolPolicy: { autoApprove: ["Read", "Grep", "Glob", "Wiki"], blockedTools: [] },
	} as any);
}

function getProjectId() {
	return projectStore.list()[0].id;
}

describe("EnrichmentRunner.resolveAgent — 无 fallback + Wiki 工具校验", () => {
	test("agentId path: uses the given wiki-capable agent directly", () => {
		const existing = makeWikiAgent();
		const runner = new EnrichmentRunner({
			agentService: makeStubAgentService(), agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		const resolved = runner.resolveAgent({ agentId: existing.id });
		expect(resolved.agentId).toBe(existing.id);
	});

	test("throws if via.agentId missing (no fallback — must select existing agent)", () => {
		const runner = new EnrichmentRunner({
			agentService: makeStubAgentService(), agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		// via.role 不再触发自动建 agent —— 无 agentId 即拒绝
		expect(() => runner.resolveAgent({ role: "archivist" } as any)).toThrow(/via\.agentId is required/);
	});

	test("throws if agent not found", () => {
		const runner = new EnrichmentRunner({
			agentService: makeStubAgentService(), agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		expect(() => runner.resolveAgent({ agentId: "nope" })).toThrow(/Agent not found/);
	});

	test("throws if agent has Wiki tool blocked (cannot maintain wiki)", () => {
		const blocked = agentStore.create({
			name: "No-Wiki",
			systemPrompt: "x",
			toolPolicy: { autoApprove: ["Read"], blockedTools: ["Wiki"] },
		} as any);
		const runner = new EnrichmentRunner({
			agentService: makeStubAgentService(), agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		expect(() => runner.resolveAgent({ agentId: blocked.id })).toThrow(/Wiki tool blocked/);
	});
});

describe("EnrichmentRunner.runProjectEnrichment — sendProjectPrompt(去-role)", () => {
	test("routes project session, writes a running job, fires sendProjectPrompt with project context", async () => {
		const stub = makeStubAgentService();
		const runner = new EnrichmentRunner({
			agentService: stub, agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		const agent = makeWikiAgent();
		const projectId = getProjectId();

		const result = await runner.runProjectEnrichment(projectId, { via: { agentId: agent.id } });

		// returns job + session ids immediately
		expect(result.jobId).toBeTruthy();
		expect(result.sessionId).toBeTruthy();

		// job recorded as running
		const job = projectJobStore.get(result.jobId)!;
		expect(job.status).toBe("running");
		expect(job.projectId).toBe(projectId);
		expect(job.jobType).toBe("wiki-enrich");

		// sendProjectPrompt called once with the agent + project session + context
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0].agentId).toBe(agent.id);
		expect(stub.calls[0].sessionId).toBe(result.sessionId);
		expect(stub.calls[0].ctx.projectId).toBe(projectId);
		expect(stub.calls[0].ctx.wikiStore).toBe(wikiStore); // 注入 wikiStore(去-role 关键)
	});

	test("on run completion → job marked completed", async () => {
		const stub = makeStubAgentService();
		stub._setBehavior("resolve");
		const runner = new EnrichmentRunner({
			agentService: stub, agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		const agent = makeWikiAgent();
		const projectId = getProjectId();
		const { jobId } = await runner.runProjectEnrichment(projectId, { via: { agentId: agent.id } });

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
		const agent = makeWikiAgent();
		const projectId = getProjectId();
		const { jobId } = await runner.runProjectEnrichment(projectId, { via: { agentId: agent.id } });

		await new Promise((r) => setTimeout(r, 10));

		const job = projectJobStore.get(jobId)!;
		expect(job.status).toBe("failed");
		expect(job.error).toMatch(/simulated enrichment failure/);
	});

	test("second enrichment on same project+agent reuses the same session (find-or-create)", async () => {
		const stub = makeStubAgentService();
		const runner = new EnrichmentRunner({
			agentService: stub, agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		const agent = makeWikiAgent();
		const projectId = getProjectId();
		const a = await runner.runProjectEnrichment(projectId, { via: { agentId: agent.id } });
		const b = await runner.runProjectEnrichment(projectId, { via: { agentId: agent.id } });
		expect(a.sessionId).toBe(b.sessionId);
	});

	test("custom prompt overrides the default enrich prompt", async () => {
		const stub = makeStubAgentService();
		const runner = new EnrichmentRunner({
			agentService: stub, agentStore, templateStore,
			sessionDB, projectStore, wikiStore, projectJobStore,
		});
		const agent = makeWikiAgent();
		const projectId = getProjectId();
		await runner.runProjectEnrichment(projectId, { via: { agentId: agent.id }, prompt: "CUSTOM-PROMPT-MARKER" });
		expect(stub.calls[0].prompt).toBe("CUSTOM-PROMPT-MARKER");
	});
});
