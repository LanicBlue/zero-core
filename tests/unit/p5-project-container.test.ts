// P5 单元测试:project 容器视图 + 级联删 crons + 资源消耗 SUM
//
// # 文件说明书
//
// ## 核心功能
// 验证 v0.8 P5 核心交付 (acceptance-P5.md「容器视图 / 资源消耗 / 死代码+级联」):
//   - getProjectContainerView 聚合:
//       * project + requirementsByStatus(按 status 分组)
//       * crons 按 workingScope.projectId 过滤
//       * wikiSummary(nodeCount + lastUpdated + scan 信号)
//       * activeSessions 按 context.projectId 过滤
//       * **不含 agent 列表**(§8.4 硬约束 — agent 全局)
//   - createProject 同步建空 wiki subtree 根(ensureProjectSubtree);
//     archivist 异步 kick(可选,缺失时 create 仍成功)
//   - deleteProject 级联:requirements + task_steps + wiki 子树 +
//     **crons whose workingScope.projectId matches(P5 补)**
//   - getProjectResourceUsage:SUM(sessions tokens/cost) WHERE context.projectId
//     无 projectId 的 session(全局/zero)不计入任何 project
//   - REST 镜像:GET /:id?includeContext=1 + GET /:id/resource-usage +
//     DELETE 级联 crons
//
// ## 输入
// 临时 SessionDB (mkdtempSync) + 真实 stores + ManagementService +
// 真实 Express Router(supertest 风格,通过 node:http 启 listen)。
//
// ## 输出
// Vitest 用例。
//
// ## 边界
// - activity 时间线细粒度(status_history+messages+cron usage 派生)→ 当前
//   DashboardTab 只渲染 requirements-by-status 粗信号;sub1 标注留后续,本测试
//   不验细粒度时间线,只验容器视图 requirementsByStatus 字段聚合正确。
// - archivist 渐进扫描两阶段完整逻辑 → P1/P7(本测试只验 kick 触发,不验扫描
//   两阶段)。
// - 项目页三 tab 渲染 + 新建项目 → e2e(specs)。
//
// ## 关键文件
//   - src/server/management-service.ts (getProjectContainerView /
//     getProjectResourceUsage / createProject 副作用)
//   - src/server/project-router.ts (REST 镜像)
//   - src/main/ipc/project-handlers.ts (IPC handler)
//   - src/runtime/tools/project-tool.ts (action=get includeContext)
//
// ## 维护规则
//   - 容器视图聚合字段变更 → 同步本测试 + management-service + project-router
//   - crons 级联遗漏 = bug,本测试一定会失败兜底
//
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Express } from "express";
import { createServer, type Server } from "http";

import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { CronStore } from "../../src/server/cron-store.js";
import { WikiStore } from "../../src/server/wiki-node-store.js";
import { RequirementStore } from "../../src/server/requirement-store.js";
import { TaskStepStore } from "../../src/server/task-step-store.js";
import { ProjectWikiStore } from "../../src/server/project-wiki-store.js";
import { ManagementService, setManagementService } from "../../src/server/management-service.js";
import { createProjectRouter } from "../../src/server/project-router.js";
import type { CronSchedule, ProjectContainerView, RequirementStatus } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let cronStore: CronStore;
let wikiStoreGlobal: WikiStore;
let wikiStore: ProjectWikiStore;
let requirementStore: RequirementStore;
let taskStepStore: TaskStepStore;
let management: ManagementService;

const SCHED_DAILY: CronSchedule = { mode: "interval", everyMs: 86_400_000 };

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-p5-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	cronStore = new CronStore(sessionDB);
	wikiStoreGlobal = new WikiStore(sessionDB);
	wikiStore = new ProjectWikiStore(wikiStoreGlobal);
	requirementStore = new RequirementStore(sessionDB);
	taskStepStore = new TaskStepStore(sessionDB);
	management = new ManagementService({
		agentStore,
		projectStore,
		cronStore,
		requirementStore,
		sessionDB,
		wikiStore: wikiStoreGlobal,
		taskStepStore,
	});
	// tool-decoupling sub-3:Project 工具迁新签名,直读 getManagementService()
	// 单例(决策 1,不经 ctx.management)。测试注册本用例实例。
	setManagementService(management);
});

afterEach(() => {
	setManagementService(undefined);
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Container view aggregation (§8.4)
// ---------------------------------------------------------------------------

describe("P5 §8.4 — getProjectContainerView aggregation", () => {
	test("returns project metadata + empty aggregates for a freshly-created project", () => {
		const p = management.createProject({ name: "Fresh", workspaceDir: join(tmpDir, "ws") });
		const v = management.getProjectContainerView(p.id);
		expect(v.project.id).toBe(p.id);
		expect(v.project.name).toBe("Fresh");
		// requirementsByStatus: every status key present, all empty.
		for (const s of ["found", "discuss", "ready", "plan", "build", "verify", "closed", "cancelled"] as RequirementStatus[]) {
			expect(Array.isArray(v.requirementsByStatus[s])).toBe(true);
			expect(v.requirementsByStatus[s].length).toBe(0);
		}
		// crons filtered by workingScope.projectId → empty
		expect(v.crons).toEqual([]);
		// wikiSummary: just the project subtree root from ensureProjectSubtree.
		expect(v.wikiSummary.nodeCount).toBeGreaterThanOrEqual(1);
		expect(v.wikiSummary.lastUpdated).toBeTruthy();
		// activeSessions: none yet
		expect(v.activeSessions).toEqual([]);
	});

	test("groups requirements by status across mixed statuses", () => {
		const p = management.createProject({ name: "P", workspaceDir: join(tmpDir, "ws") });
		// Seed 3 requirements across different statuses.
		requirementStore.create({ projectId: p.id, title: "r1", status: "found",   source: "agent", priority: "normal", reviewer: "agent" });
		requirementStore.create({ projectId: p.id, title: "r2", status: "found",   source: "agent", priority: "normal", reviewer: "agent" });
		requirementStore.create({ projectId: p.id, title: "r3", status: "discuss", source: "agent", priority: "high",   reviewer: "agent" });
		requirementStore.create({ projectId: p.id, title: "r4", status: "build",   source: "agent", priority: "normal", reviewer: "agent" });
		// Seed a requirement for ANOTHER project — must NOT bleed into this view.
		const other = management.createProject({ name: "Other", workspaceDir: join(tmpDir, "ws2") });
		requirementStore.create({ projectId: other.id, title: "rOther", status: "found", source: "agent", priority: "normal", reviewer: "agent" });

		const v = management.getProjectContainerView(p.id);
		expect(v.requirementsByStatus.found.map((r) => r.title).sort()).toEqual(["r1", "r2"]);
		expect(v.requirementsByStatus.discuss.map((r) => r.title)).toEqual(["r3"]);
		expect(v.requirementsByStatus.build.map((r) => r.title)).toEqual(["r4"]);
		// Untouched statuses stay empty.
		expect(v.requirementsByStatus.ready).toEqual([]);
		expect(v.requirementsByStatus.verify).toEqual([]);
		// Total = 4 (NOT 5 — rOther belongs to the other project).
		const total = Object.values(v.requirementsByStatus).reduce((n, l) => n + l.length, 0);
		expect(total).toBe(4);
	});

	test("crons are filtered by workingScope.projectId", () => {
		const p1 = management.createProject({ name: "P1", workspaceDir: join(tmpDir, "ws1") });
		const p2 = management.createProject({ name: "P2", workspaceDir: join(tmpDir, "ws2") });
		const agent = agentStore.create({ name: "CronRunner" });

		// Two crons scoped to p1, one to p2, one global (no projectId).
		cronStore.create({ agentId: agent.id, workingScope: { projectId: p1.id, workspaceDir: p1.workspaceDir, wikiRootNodeId: `wiki-root:${p1.id}` }, schedule: SCHED_DAILY, enabled: true });
		cronStore.create({ agentId: agent.id, workingScope: { projectId: p1.id, workspaceDir: p1.workspaceDir, wikiRootNodeId: `wiki-root:${p1.id}` }, schedule: SCHED_DAILY, enabled: false });
		cronStore.create({ agentId: agent.id, workingScope: { projectId: p2.id, workspaceDir: p2.workspaceDir, wikiRootNodeId: `wiki-root:${p2.id}` }, schedule: SCHED_DAILY, enabled: true });
		cronStore.create({ agentId: agent.id, workingScope: { workspaceDir: "/global", wikiRootNodeId: "wiki-root:global" }, schedule: SCHED_DAILY, enabled: true });

		const v1 = management.getProjectContainerView(p1.id);
		expect(v1.crons.length).toBe(2);
		expect(v1.crons.every((c) => c.workingScope.projectId === p1.id)).toBe(true);

		const v2 = management.getProjectContainerView(p2.id);
		expect(v2.crons.length).toBe(1);
		expect(v2.crons[0].workingScope.projectId).toBe(p2.id);
	});

	test("activeSessions filter by context.projectId and resolve agent name", () => {
		const p = management.createProject({ name: "P", workspaceDir: join(tmpDir, "ws") });
		const agent = agentStore.create({ name: "WorkerA" });
		const otherAgent = agentStore.create({ name: "WorkerB" });

		// Session bound to this project.
		sessionDB.createSession(agent.id, "p1-main", { projectId: p.id, workspaceDir: p.workspaceDir, wikiRootNodeId: `wiki-root:${p.id}` });
		// Session bound to a different project.
		const other = management.createProject({ name: "Other", workspaceDir: join(tmpDir, "ws2") });
		sessionDB.createSession(otherAgent.id, "p2-main", { projectId: other.id, workspaceDir: other.workspaceDir, wikiRootNodeId: `wiki-root:${other.id}` });
		// Global session with no projectId — must NOT appear in any project.
		sessionDB.createSession(agent.id, "global", { workspaceDir: p.workspaceDir, wikiRootNodeId: "wiki-root:global" });

		const v = management.getProjectContainerView(p.id);
		expect(v.activeSessions.length).toBe(1);
		expect(v.activeSessions[0].agentId).toBe(agent.id);
		expect(v.activeSessions[0].name).toBe("WorkerA");
		expect(v.activeSessions[0].sessionId).toBeTruthy();
	});

	test("container view does NOT include an agent list (§8.4 hard constraint)", () => {
		const p = management.createProject({ name: "P", workspaceDir: join(tmpDir, "ws") });
		// Seed some global agents — they must not surface as a project field.
		agentStore.create({ name: "GlobalA" });
		agentStore.create({ name: "GlobalB" });

		const v = management.getProjectContainerView(p.id) as ProjectContainerView & { agents?: unknown };
		expect(v.agents).toBeUndefined();
		// Sanity: the contract fields ARE present.
		expect(v.project).toBeDefined();
		expect(v.requirementsByStatus).toBeDefined();
		expect(v.crons).toBeDefined();
		expect(v.wikiSummary).toBeDefined();
		expect(v.activeSessions).toBeDefined();
	});

	test("throws when the project does not exist", () => {
		expect(() => management.getProjectContainerView("does-not-exist")).toThrow(/not found/i);
	});
});

// ---------------------------------------------------------------------------
// create side-effects (§8.3)
// ---------------------------------------------------------------------------

describe("P5 §8.3 — createProject side-effects", () => {
	test("synchronously creates an empty wiki subtree root (project immediately usable)", () => {
		const p = management.createProject({ name: "Subtree", workspaceDir: join(tmpDir, "ws") });
		// Without archivist kicking, the wiki subtree root already exists.
		const nodes = wikiStoreGlobal.listByProject(p.id);
		expect(nodes.length).toBeGreaterThanOrEqual(1);
		// The root node type is "project".
		expect(nodes.some((n) => n.type === "project")).toBe(true);
		// Container view's wikiSummary reflects the just-created root.
		const v = management.getProjectContainerView(p.id);
		expect(v.wikiSummary.nodeCount).toBeGreaterThanOrEqual(1);
	});

	test("kicks the archivist background scan asynchronously (best-effort)", async () => {
		const scanCalls: string[] = [];
		const archivistStub = {
			buildSkeleton: vi.fn(async (projectId: string) => {
				scanCalls.push(projectId);
				return { notes: [] };
			}),
		};
		management.setArchivistService(archivistStub as any);

		const p = management.createProject({ name: "Scanned", workspaceDir: join(tmpDir, "ws") });
		// createProject returns before the scan completes; flush microtasks.
		await new Promise((r) => setTimeout(r, 10));
		expect(archivistStub.buildSkeleton).toHaveBeenCalledTimes(1);
		expect(archivistStub.buildSkeleton).toHaveBeenCalledWith(p.id);
		expect(scanCalls).toEqual([p.id]);
	});

	test("create succeeds even when archivist is not wired (best-effort, no throw)", () => {
		// No archivistService attached — management.archivistService is null.
		expect(() => management.createProject({ name: "NoArchivist", workspaceDir: join(tmpDir, "ws") })).not.toThrow();
	});

	test("archivist scan failure does not block project creation", async () => {
		const archivistStub = {
			buildSkeleton: vi.fn(async () => { throw new Error("scan failed"); }),
		};
		management.setArchivistService(archivistStub as any);
		// createProject returns synchronously regardless of scan outcome.
		const p = management.createProject({ name: "ScanFails", workspaceDir: join(tmpDir, "ws") });
		expect(p.id).toBeTruthy();
		// Let the rejected promise settle (no uncaught throw escaping to test).
		await new Promise((r) => setTimeout(r, 10));
		expect(archivistStub.buildSkeleton).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Cascade delete incl. crons patch (§8.6)
// ---------------------------------------------------------------------------

describe("P5 §8.6 — delete cascade incl. project-scoped crons", () => {
	test("cascade-deletes requirements + wiki subtree + project-scoped crons + project row", () => {
		const p = management.createProject({ name: "P", workspaceDir: join(tmpDir, "ws") });
		const agent = agentStore.create({ name: "Agent" });
		const other = management.createProject({ name: "Other", workspaceDir: join(tmpDir, "ws2") });

		// Seed: 2 reqs (one with task_steps) + wiki subtree + 2 crons (one project-
		// scoped, one global).
		const r1 = requirementStore.create({ projectId: p.id, title: "r1", status: "found", source: "agent", priority: "normal", reviewer: "agent" });
		taskStepStore.create({ requirementId: r1.id, stepOrder: 0, role: "developer", title: "s1", status: "pending", retryCount: 0, maxRetries: 3 });
		requirementStore.create({ projectId: p.id, title: "r2", status: "ready", source: "agent", priority: "normal", reviewer: "agent" });
		// Wiki subtree root exists via create side-effect; verify it's there.
		expect(wikiStoreGlobal.listByProject(p.id).length).toBeGreaterThanOrEqual(1);

		cronStore.create({ agentId: agent.id, workingScope: { projectId: p.id, workspaceDir: p.workspaceDir, wikiRootNodeId: `wiki-root:${p.id}` }, schedule: SCHED_DAILY, enabled: true });
		cronStore.create({ agentId: agent.id, workingScope: { projectId: p.id, workspaceDir: p.workspaceDir, wikiRootNodeId: `wiki-root:${p.id}` }, schedule: SCHED_DAILY, enabled: false });
		// Cron for the OTHER project — must survive.
		cronStore.create({ agentId: agent.id, workingScope: { projectId: other.id, workspaceDir: other.workspaceDir, wikiRootNodeId: `wiki-root:${other.id}` }, schedule: SCHED_DAILY, enabled: true });
		// Global cron (no projectId) — must survive.
		cronStore.create({ agentId: agent.id, workingScope: { workspaceDir: "/global", wikiRootNodeId: "wiki-root:global" }, schedule: SCHED_DAILY, enabled: true });

		// Sanity: 4 crons total before delete.
		expect(cronStore.list().length).toBe(4);

		// Drive delete through ManagementService — the single source of truth
		// for the cascade (REST router + Project tool both go through here).
		management.deleteProject(p.id);

		// Project gone.
		expect(projectStore.get(p.id)).toBeUndefined();
		// Requirements gone (cascade into task_steps + history + messages).
		expect(requirementStore.listByProject(p.id)).toEqual([]);
		expect(taskStepStore.listByRequirement(r1.id)).toEqual([]);
		// Wiki subtree gone.
		expect(wikiStoreGlobal.listByProject(p.id)).toEqual([]);
		// Project-scoped crons gone; OTHER project cron + global cron survive.
		const remaining = cronStore.list();
		expect(remaining.length).toBe(2);
		expect(remaining.every((c) => c.workingScope.projectId !== p.id)).toBe(true);
	});

	test("REST DELETE /:id cascades crons too (project-router parity)", async () => {
		const p = management.createProject({ name: "P", workspaceDir: join(tmpDir, "ws") });
		const agent = agentStore.create({ name: "A" });
		cronStore.create({ agentId: agent.id, workingScope: { projectId: p.id, workspaceDir: p.workspaceDir, wikiRootNodeId: `wiki-root:${p.id}` }, schedule: SCHED_DAILY, enabled: true });
		cronStore.create({ agentId: agent.id, workingScope: { workspaceDir: "/global", wikiRootNodeId: "wiki-root:global" }, schedule: SCHED_DAILY, enabled: true });

		const app: Express = express();
		app.use(express.json());
		app.use("/api/projects", createProjectRouter({
			projectStore, requirementStore, wikiStore, taskStepStore,
			cronStore, management,
		}));
		const { server, port } = await listen(app);
		try {
			const resp = await fetchJson(port, "DELETE", `/api/projects/${p.id}`);
			expect(resp.status).toBe(204);
			// Project-scoped cron gone; global cron survived.
			const remaining = cronStore.list();
			expect(remaining.length).toBe(1);
			expect(remaining[0].workingScope.projectId).toBeUndefined();
		} finally {
			await close(server);
		}
	});
});

// ---------------------------------------------------------------------------
// Resource usage SUM (§8.5)
// ---------------------------------------------------------------------------

describe("P5 §8.5 — getProjectResourceUsage (sessions token/cost SUM by projectId)", () => {
	test("SUMs tokens + cost across all sessions scoped to the project", () => {
		const p = management.createProject({ name: "P", workspaceDir: join(tmpDir, "ws") });
		const agent = agentStore.create({ name: "A" });

		// 3 sessions on this project with mixed usage.
		const s1 = sessionDB.createSession(agent.id, "s1", { projectId: p.id, workspaceDir: p.workspaceDir, wikiRootNodeId: `wiki-root:${p.id}` });
		const s2 = sessionDB.createSession(agent.id, "s2", { projectId: p.id, workspaceDir: p.workspaceDir, wikiRootNodeId: `wiki-root:${p.id}` });
		const s3 = sessionDB.createSession(agent.id, "s3", { projectId: p.id, workspaceDir: p.workspaceDir, wikiRootNodeId: `wiki-root:${p.id}` });
		sessionDB.updateSessionUsage(s1.id, { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadTokens: 10, cacheWriteTokens: 5, reasoningTokens: 0, estimatedCostUsd: 0.01 });
		sessionDB.updateSessionUsage(s2.id, { inputTokens: 200, outputTokens: 100, totalTokens: 300, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 0, estimatedCostUsd: 0.02 });
		sessionDB.updateSessionUsage(s3.id, { inputTokens: 300, outputTokens: 150, totalTokens: 450, cacheReadTokens: 30, cacheWriteTokens: 15, reasoningTokens: 0, estimatedCostUsd: 0.03 });

		const u = management.getProjectResourceUsage(p.id);
		expect(u.projectId).toBe(p.id);
		expect(u.sessionCount).toBe(3);
		expect(u.inputTokens).toBe(600);
		expect(u.outputTokens).toBe(300);
		expect(u.totalTokens).toBe(900);
		expect(u.cacheReadTokens).toBe(60);
		expect(u.cacheWriteTokens).toBe(30);
		expect(u.reasoningTokens).toBe(0);
		expect(u.estimatedCostUsd).toBeCloseTo(0.06, 5);
	});

	test("sessions WITHOUT a projectId never contribute to any project (boundary)", () => {
		const p = management.createProject({ name: "P", workspaceDir: join(tmpDir, "ws") });
		const agent = agentStore.create({ name: "A" });

		// A project-scoped session with some usage.
		const sIn = sessionDB.createSession(agent.id, "in", { projectId: p.id, workspaceDir: p.workspaceDir, wikiRootNodeId: `wiki-root:${p.id}` });
		sessionDB.updateSessionUsage(sIn.id, { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0.5 });

		// A global session with massive usage — must NOT bleed into the project.
		const sGlobal = sessionDB.createSession(agent.id, "global", { workspaceDir: p.workspaceDir, wikiRootNodeId: "wiki-root:global" });
		sessionDB.updateSessionUsage(sGlobal.id, { inputTokens: 999_999, outputTokens: 999_999, totalTokens: 1_999_998, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: 99.99 });

		// A session bound to ANOTHER project — must NOT contribute here either.
		const other = management.createProject({ name: "Other", workspaceDir: join(tmpDir, "ws2") });
		const sOther = sessionDB.createSession(agent.id, "other", { projectId: other.id, workspaceDir: other.workspaceDir, wikiRootNodeId: `wiki-root:${other.id}` });
		sessionDB.updateSessionUsage(sOther.id, { inputTokens: 7, outputTokens: 7, totalTokens: 14, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0.007 });

		const u = management.getProjectResourceUsage(p.id);
		expect(u.sessionCount).toBe(1);
		expect(u.inputTokens).toBe(1000);
		expect(u.totalTokens).toBe(1500);
		expect(u.estimatedCostUsd).toBeCloseTo(0.5, 5);

		// The OTHER project only sees its own session.
		const uOther = management.getProjectResourceUsage(other.id);
		expect(uOther.sessionCount).toBe(1);
		expect(uOther.totalTokens).toBe(14);
	});

	test("returns zero-shaped result when there are no matching sessions", () => {
		const p = management.createProject({ name: "P", workspaceDir: join(tmpDir, "ws") });
		const u = management.getProjectResourceUsage(p.id);
		expect(u.sessionCount).toBe(0);
		expect(u.totalTokens).toBe(0);
		expect(u.estimatedCostUsd).toBe(0);
	});

	test("REST GET /:id/resource-usage returns the same SUM (router parity)", async () => {
		const p = management.createProject({ name: "P", workspaceDir: join(tmpDir, "ws") });
		const agent = agentStore.create({ name: "A" });
		const s = sessionDB.createSession(agent.id, "s", { projectId: p.id, workspaceDir: p.workspaceDir, wikiRootNodeId: `wiki-root:${p.id}` });
		sessionDB.updateSessionUsage(s.id, { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 1, cacheWriteTokens: 1, reasoningTokens: 1, estimatedCostUsd: 0.001 });

		const app: Express = express();
		app.use(express.json());
		app.use("/api/projects", createProjectRouter({
			projectStore, requirementStore, wikiStore, taskStepStore,
			cronStore, management,
		}));
		const { server, port } = await listen(app);
		try {
			const r1 = await fetchJson(port, "GET", `/api/projects/${p.id}/resource-usage`);
			expect(r1.status).toBe(200);
			expect(r1.data.totalTokens).toBe(15);
			expect(r1.data.sessionCount).toBe(1);

			// Container view via ?includeContext=1
			const r2 = await fetchJson(port, "GET", `/api/projects/${p.id}?includeContext=1`);
			expect(r2.status).toBe(200);
			expect(r2.data.project.id).toBe(p.id);
			expect(Array.isArray(r2.data.requirementsByStatus.found)).toBe(true);
			expect(r2.data.wikiSummary.nodeCount).toBeGreaterThanOrEqual(1);

			// Plain GET without includeContext returns just metadata.
			const r3 = await fetchJson(port, "GET", `/api/projects/${p.id}`);
			expect(r3.status).toBe(200);
			expect(r3.data.id).toBe(p.id);
			expect(r3.data.requirementsByStatus).toBeUndefined();
		} finally {
			await close(server);
		}
	});
});

// ---------------------------------------------------------------------------
// Project tool — get(includeContext) action (§8.2 / §8.4)
// ---------------------------------------------------------------------------

describe("P5 §8.2 — Project tool get(includeContext) returns container view", () => {
	test("includeContext=true goes through getProjectContainerView", async () => {
		// tool-decoupling sub-3:Project 工具迁新签名(execute 返 ToolResult +
		// format),直读 getManagementService() 单例(beforeEach 已注册)。execute
		// 返 ToolResult,text 经 format 取(仍是 JSON.dump 形态,同 sub-3 前)。
		const { projectTool } = await import("../../src/tools/project-tool.js");
		const { getToolExecute, getToolFormat } = await import("../../src/tools/tool-factory.js");
		const exec = getToolExecute(projectTool)!;
		const format = getToolFormat(projectTool)!;
		// 助手:execute → ToolResult;format → 文本(同 sub-3 前);断言两边。
		const run = async (input: any) => {
			const json: any = await exec(input, { caller: "internal" });
			return { json, text: format(json) };
		};

		const p = management.createProject({ name: "Tool", workspaceDir: join(tmpDir, "ws") });

		const r1 = await run({ action: "get", id: p.id, includeContext: true });
		expect(r1.json.ok).toBe(true);
		const parsed = JSON.parse(r1.text);
		expect(parsed.project.id).toBe(p.id);
		// All container fields present.
		expect(parsed.requirementsByStatus).toBeDefined();
		expect(parsed.crons).toEqual([]);
		expect(parsed.wikiSummary).toBeDefined();
		expect(parsed.activeSessions).toEqual([]);

		// Without includeContext, plain metadata.
		const r2 = await run({ action: "get", id: p.id });
		const meta = JSON.parse(r2.text);
		expect(meta.id).toBe(p.id);
		expect(meta.requirementsByStatus).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------

function listen(app: Express): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const server = createServer(app);
		server.listen(0, () => {
			const addr = server.address() as { port: number };
			resolve({ server, port: addr.port });
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(resolve));
}

async function fetchJson(port: number, method: string, path: string): Promise<{ status: number; data: any }> {
	const resp = await fetch(`http://localhost:${port}${path}`, { method });
	const text = await resp.text();
	try {
		return { status: resp.status, data: JSON.parse(text) };
	} catch {
		return { status: resp.status, data: text };
	}
}
