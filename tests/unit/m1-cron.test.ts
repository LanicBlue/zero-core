// M1 单元测试：cron 一等公民
//
// # 文件说明书
//
// ## 核心功能
// 验证 M1 核心交付 (acceptance-M1.md):
//   - CronStore CRUD + workingScope JSON 持久化 + listEnabled / listByAgent
//   - CronAnalysisManager 调度源从「扫 agentStore.cronSchedule」切到「扫 cron 表」
//   - cron 触发: project cron 走 resolveSessionByRoleProject(两条 cron → 两个 session);
//     observation cron 走 agentId-keyed main session
//   - enabled=false / schedule="off" 的 cron 不调度不触发
//   - 删 cron 不级联删 agent (解绑)
//   - ManagementService.createCron / updateCron / deleteCron / listCrons
//
// ## 输入
// 临时 SessionDB (mkdtempSync) + 真实 stores + stub AgentService (capture sendPrompt)。
//
// ## 输出
// Vitest 用例。
//

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { AgentToolStore } from "../../src/server/agent-tool-store.js";
import { CronStore } from "../../src/server/cron-store.js";
import { CronAnalysisManager } from "../../src/server/cron-analysis.js";
import { ManagementService } from "../../src/server/management-service.js";
import { resolveSessionByRoleProject } from "../../src/server/session-context-router.js";
import { runMigrations } from "../../src/server/db-migration.js";
import type { CronRecord, CronSchedule } from "../../src/shared/types.js";
// v0.8 P0: roleTag 不再走 store round-trip;schedule 改为结构化 JSON。
import { seedAgentWithRoleTag } from "./helpers/p0-test-helpers.js";

// v0.8 P0 (§3.4): schedule is now structured JSON. These helpers build the
// three-mode shapes so the test reads naturally.
const SCHED_INTERVAL_HOURLY: CronSchedule = { mode: "interval", everyMs: 3_600_000 };
const SCHED_INTERVAL_DAILY: CronSchedule = { mode: "interval", everyMs: 86_400_000 };
const SCHED_INTERVAL_WEEKLY: CronSchedule = { mode: "interval", everyMs: 7 * 86_400_000 };
const SCHED_OFF_INERT: CronSchedule = { mode: "interval", everyMs: 0 };

let tmpDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let agentToolStore: AgentToolStore;
let cronStore: CronStore;
let zeroAdmin: ManagementService;

// Stub AgentService that captures sendPrompt calls.
function makeStubAgentService() {
	const calls: Array<{ text: string; agentId?: string; sessionId?: string }> = [];
	const svc = {
		calls,
		sendPrompt: vi.fn(async (text: string, agent?: any, sessionId?: string) => {
			calls.push({ text, agentId: agent?.id, sessionId });
		}),
	};
	return svc;
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-m1-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	agentToolStore = new AgentToolStore(sessionDB);
	cronStore = new CronStore(sessionDB);
	zeroAdmin = new ManagementService({ agentStore, projectStore, agentToolStore, cronStore });
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function scope(projectId: string | undefined, workspaceDir: string, wiki = `wiki-root:${projectId ?? "global"}`) {
	return { projectId, workspaceDir, wikiRootNodeId: wiki };
}

// ─── CronStore ───────────────────────────────────────────────

describe("CronStore", () => {
	test("create + get round-trips workingScope as JSON", () => {
		const agent = agentStore.create({ name: "PM" } as any);
		seedAgentWithRoleTag(sessionDB, agent.id, "pm");
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "ws") });
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(proj.id, proj.workspaceDir),
			schedule: SCHED_INTERVAL_HOURLY,
			prompt: "check in",
			enabled: true,
		});
		const fetched = cronStore.get(cron.id)!;
		expect(fetched.agentId).toBe(agent.id);
		expect(fetched.schedule).toEqual(SCHED_INTERVAL_HOURLY);
		expect(fetched.triggerMode).toBe("interval"); // v0.8 P0: redundant mode mirror
		expect(fetched.workingScope.projectId).toBe(proj.id);
		expect(fetched.workingScope.workspaceDir).toBe(proj.workspaceDir);
		expect(fetched.workingScope.wikiRootNodeId).toBe(`wiki-root:${proj.id}`);
		expect(fetched.enabled).toBe(true);
	});

	test("create rejects workingScope missing workspaceDir/wikiRootNodeId", () => {
		const agent = agentStore.create({ name: "PM" } as any);
		seedAgentWithRoleTag(sessionDB, agent.id, "pm");
		expect(() => cronStore.create({
			agentId: agent.id,
			workingScope: { workspaceDir: "/x" } as any,
			schedule: SCHED_INTERVAL_DAILY,
			enabled: true,
		})).toThrow(/workspaceDir and wikiRootNodeId/);
	});

	test("listEnabled excludes disabled and off(inert) crons", () => {
		// v0.8 P0 (§3.4): "off" is now `enabled=false` (the real gate).
		// An inert schedule ({mode:"interval",everyMs:0}) with enabled=true is
		// still considered enabled at the store layer (cadence firing is P4).
		const agent = agentStore.create({ name: "PM" } as any);
		seedAgentWithRoleTag(sessionDB, agent.id, "pm");
		cronStore.create({ agentId: agent.id, workingScope: scope(undefined, "/a", "r-a"), schedule: SCHED_INTERVAL_HOURLY, enabled: true });
		cronStore.create({ agentId: agent.id, workingScope: scope(undefined, "/b", "r-b"), schedule: SCHED_INTERVAL_DAILY, enabled: false });
		cronStore.create({ agentId: agent.id, workingScope: scope(undefined, "/c", "r-c"), schedule: SCHED_OFF_INERT, enabled: false });
		expect(cronStore.listEnabled().length).toBe(1);
		expect(cronStore.listEnabled()[0].workingScope.workspaceDir).toBe("/a");
	});

	test("listByAgent filters by agent", () => {
		const a1 = agentStore.create({ name: "PM1" } as any);
		seedAgentWithRoleTag(sessionDB, a1.id, "pm");
		const a2 = agentStore.create({ name: "PM2" } as any);
		seedAgentWithRoleTag(sessionDB, a2.id, "pm");
		cronStore.create({ agentId: a1.id, workingScope: scope(undefined, "/a", "r-a"), schedule: SCHED_INTERVAL_HOURLY, enabled: true });
		cronStore.create({ agentId: a2.id, workingScope: scope(undefined, "/b", "r-b"), schedule: SCHED_INTERVAL_HOURLY, enabled: true });
		expect(cronStore.listByAgent(a1.id).length).toBe(1);
	});

	test("delete is unbind — referenced agent stays intact", () => {
		const agent = agentStore.create({ name: "PM" } as any);
		seedAgentWithRoleTag(sessionDB, agent.id, "pm");
		const cron = cronStore.create({ agentId: agent.id, workingScope: scope(undefined, "/a", "r-a"), schedule: SCHED_INTERVAL_HOURLY, enabled: true });
		cronStore.delete(cron.id);
		expect(cronStore.get(cron.id)).toBeUndefined();
		// Agent untouched.
		expect(agentStore.get(agent.id)).toBeDefined();
	});

	test("deleteByAgent removes all crons for an agent", () => {
		const agent = agentStore.create({ name: "PM" } as any);
		seedAgentWithRoleTag(sessionDB, agent.id, "pm");
		cronStore.create({ agentId: agent.id, workingScope: scope(undefined, "/a", "r-a"), schedule: SCHED_INTERVAL_HOURLY, enabled: true });
		cronStore.create({ agentId: agent.id, workingScope: scope(undefined, "/b", "r-b"), schedule: SCHED_INTERVAL_DAILY, enabled: true });
		expect(cronStore.listByAgent(agent.id).length).toBe(2);
		cronStore.deleteByAgent(agent.id);
		expect(cronStore.listByAgent(agent.id).length).toBe(0);
	});

	test("CRON_COLUMNS present on fresh DB (no migration script)", () => {
		// Fresh DB should have the crons table after runMigrations.
		const agent = agentStore.create({ name: "PM" } as any);
		seedAgentWithRoleTag(sessionDB, agent.id, "pm");
		const cron = cronStore.create({ agentId: agent.id, workingScope: scope(undefined, "/a", "r-a"), schedule: SCHED_INTERVAL_WEEKLY, prompt: "p", enabled: false });
		expect(cron.prompt).toBe("p");
		expect(cron.schedule).toEqual(SCHED_INTERVAL_WEEKLY);
		expect(cron.triggerMode).toBe("interval");
	});
});

// ─── CronAnalysisManager ─────────────────────────────────────

describe("CronAnalysisManager", () => {
	let stubAgentService: ReturnType<typeof makeStubAgentService>;
	let manager: CronAnalysisManager;
	let pmAgent: any;
	let projA: any, projB: any;

	beforeEach(() => {
		stubAgentService = makeStubAgentService();
		manager = new CronAnalysisManager({
			agentService: stubAgentService as any,
			agentStore,
			projectStore,
			sessionDB,
			cronStore,
		});
		pmAgent = (() => { const _a = agentStore.create({ name: "GlobalPM" } as any); seedAgentWithRoleTag(sessionDB, _a.id, "pm"); return _a; })();
		projA = projectStore.create({ name: "ProjA", workspaceDir: join(tmpDir, "wsA") });
		projB = projectStore.create({ name: "ProjB", workspaceDir: join(tmpDir, "wsB") });
	});

	test("project cron trigger routes via resolveSessionByRoleProject → two crons → two sessions", async () => {
		const cronA = cronStore.create({
			agentId: pmAgent.id, workingScope: scope(projA.id, projA.workspaceDir), schedule: SCHED_INTERVAL_HOURLY, enabled: true,
		});
		const cronB = cronStore.create({
			agentId: pmAgent.id, workingScope: scope(projB.id, projB.workspaceDir), schedule: SCHED_INTERVAL_DAILY, enabled: true,
		});

		await manager.triggerCron(cronA.id);
		await manager.triggerCron(cronB.id);

		expect(stubAgentService.calls.length).toBe(2);
		const sessionA = stubAgentService.calls[0].sessionId!;
		const sessionB = stubAgentService.calls[1].sessionId!;
		expect(sessionA).not.toBe(sessionB);
		// Sessions should be findable by (agentId, projectId).
		expect(sessionDB.findSessionByAgentAndProject(pmAgent.id, projA.id)?.id).toBe(sessionA);
		expect(sessionDB.findSessionByAgentAndProject(pmAgent.id, projB.id)?.id).toBe(sessionB);
	});

	test("re-triggering same cron reuses the same session (续接)", async () => {
		const cron = cronStore.create({
			agentId: pmAgent.id, workingScope: scope(projA.id, projA.workspaceDir), schedule: SCHED_INTERVAL_HOURLY, enabled: true,
		});
		await manager.triggerCron(cron.id);
		await manager.triggerCron(cron.id);
		expect(stubAgentService.calls.length).toBe(2);
		expect(stubAgentService.calls[0].sessionId).toBe(stubAgentService.calls[1].sessionId);
	});

	test("enabled=false cron is not triggered", async () => {
		const cron = cronStore.create({
			agentId: pmAgent.id, workingScope: scope(projA.id, projA.workspaceDir), schedule: SCHED_INTERVAL_HOURLY, enabled: false,
		});
		await manager.triggerCron(cron.id);
		expect(stubAgentService.calls.length).toBe(0);
	});

	test("disabled (off) cron is not triggered", async () => {
		// v0.8 P0 (§3.4): "off" is now encoded as enabled=false (the real gate).
		// An inert schedule with enabled=true is still considered enabled at the
		// store layer; cadence firing is P4. To assert the no-trigger path we
		// disable the cron, mirroring what the legacy schedule="off" meant.
		const cron = cronStore.create({
			agentId: pmAgent.id, workingScope: scope(projA.id, projA.workspaceDir), schedule: SCHED_OFF_INERT, enabled: false,
		});
		await manager.triggerCron(cron.id);
		expect(stubAgentService.calls.length).toBe(0);
	});

	test("observation cron (no projectId) routes to agent main session", async () => {
		const cron = cronStore.create({
			agentId: pmAgent.id,
			workingScope: scope(undefined, "/global/ws", "wiki-root:global"),
			schedule: SCHED_INTERVAL_HOURLY, enabled: true,
		});
		await manager.triggerCron(cron.id);
		expect(stubAgentService.calls.length).toBe(1);
		const session = sessionDB.getSession(stubAgentService.calls[0].sessionId!);
		expect(session).toBeDefined();
		// Created with the observation bundle.
		expect(session!.context?.workspaceDir).toBe("/global/ws");
	});

	test("refreshCron reconciles timer: enabled→scheduled, disabled→unscheduled", () => {
		const cron = cronStore.create({
			agentId: pmAgent.id, workingScope: scope(projA.id, projA.workspaceDir), schedule: SCHED_INTERVAL_HOURLY, enabled: true,
		});
		manager.refreshCron(cron.id);
		expect(manager.getScheduledCronIds()).toContain(cron.id);

		cronStore.update(cron.id, { enabled: false });
		manager.refreshCron(cron.id);
		expect(manager.getScheduledCronIds()).not.toContain(cron.id);
	});

	test("restoreSchedules scans cron table (not project table / agentStore.cronSchedule)", () => {
		// One enabled, two disabled (one via enabled=false, one via off+disabled).
		// v0.8 P0 (§3.4): off is enabled=false; an inert schedule + enabled=true
		// still counts as enabled at the store layer (firing is P4).
		const c1 = cronStore.create({ agentId: pmAgent.id, workingScope: scope(projA.id, projA.workspaceDir), schedule: SCHED_INTERVAL_HOURLY, enabled: true });
		cronStore.create({ agentId: pmAgent.id, workingScope: scope(projB.id, projB.workspaceDir), schedule: SCHED_INTERVAL_DAILY, enabled: false });
		cronStore.create({ agentId: pmAgent.id, workingScope: scope(projB.id, projB.workspaceDir), schedule: SCHED_OFF_INERT, enabled: false });

		manager.restoreSchedules();
		const scheduled = manager.getScheduledCronIds();
		expect(scheduled).toEqual([c1.id]);
	});

	test("deleting a cron does not delete the global agent", () => {
		const cron = cronStore.create({
			agentId: pmAgent.id, workingScope: scope(projA.id, projA.workspaceDir), schedule: SCHED_INTERVAL_HOURLY, enabled: true,
		});
		cronStore.delete(cron.id);
		expect(agentStore.get(pmAgent.id)).toBeDefined();
	});
});

// ─── ManagementService cron methods ───────────────────────────

describe("ManagementService cron methods", () => {
	test("createCron validates agent + project refs", () => {
		expect(() => zeroAdmin.createCron({
			agentId: "nonexistent",
			workingScope: scope(undefined, "/x", "r"),
			schedule: SCHED_INTERVAL_DAILY,
		})).toThrow(/Agent not found/);

		const agent = (() => { const _a = agentStore.create({ name: "PM" } as any); seedAgentWithRoleTag(sessionDB, _a.id, "pm"); return _a; })();
		expect(() => zeroAdmin.createCron({
			agentId: agent.id,
			workingScope: scope("nonexistent-project", "/x", "r"),
			schedule: SCHED_INTERVAL_DAILY,
		})).toThrow(/Project not found/);
	});

	test("createCron + listCrons + updateCron + deleteCron lifecycle", () => {
		const agent = (() => { const _a = agentStore.create({ name: "PM" } as any); seedAgentWithRoleTag(sessionDB, _a.id, "pm"); return _a; })();
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "ws") });

		const cron = zeroAdmin.createCron({
			agentId: agent.id,
			workingScope: scope(proj.id, proj.workspaceDir),
			schedule: SCHED_INTERVAL_DAILY,
		});
		expect(cron.enabled).toBe(true); // default
		expect(zeroAdmin.listCrons().length).toBe(1);
		expect(zeroAdmin.listCrons({ agentId: agent.id }).length).toBe(1);

		const updated = zeroAdmin.updateCron(cron.id, { schedule: SCHED_INTERVAL_WEEKLY, enabled: false });
		expect(updated.schedule).toEqual(SCHED_INTERVAL_WEEKLY);
		expect(updated.enabled).toBe(false);

		zeroAdmin.deleteCron(cron.id);
		expect(zeroAdmin.listCrons().length).toBe(0);
		// Agent still present.
		expect(agentStore.get(agent.id)).toBeDefined();
	});

	test("deleteAgent cascades its cron entries (reverse direction)", () => {
		const agent = (() => { const _a = agentStore.create({ name: "PM" } as any); seedAgentWithRoleTag(sessionDB, _a.id, "pm"); return _a; })();
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "ws") });
		zeroAdmin.createCron({ agentId: agent.id, workingScope: scope(proj.id, proj.workspaceDir), schedule: SCHED_INTERVAL_DAILY });
		zeroAdmin.createCron({ agentId: agent.id, workingScope: scope(proj.id, proj.workspaceDir, "r2"), schedule: SCHED_INTERVAL_HOURLY });
		expect(cronStore.listByAgent(agent.id).length).toBe(2);
		zeroAdmin.deleteAgent(agent.id);
		expect(cronStore.listByAgent(agent.id).length).toBe(0);
	});
});

// ─── cron tools ──────────────────────────────────────────────

describe("cron action tool (Cron)", () => {
	test("create/update/list/delete actions invoke ManagementService via ctx.management", async () => {
		// v0.8 P3 (§7.3): the four retired per-action cron tools
		// (CreateCron/UpdateCron/DeleteCron/ListCrons) are merged into one
		// action-switched `Cron` tool. Each action is one switch branch.
		const { cronTool } = await import("../../src/runtime/tools/cron-tool.js");
		const { getToolExecute } = await import("../../src/runtime/tools/tool-factory.js");
		const execute = getToolExecute(cronTool)!;
		const agent = (() => { const _a = agentStore.create({ name: "PM" } as any); seedAgentWithRoleTag(sessionDB, _a.id, "pm"); return _a; })();
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "ws") });
		// AI SDK tool() execute receives (input, opts); ctx lives at opts.experimental_context.
		// v0.8 P3: ctx.zeroAdmin renamed → ctx.management.
		// v0.8 P3: getToolExecute returns the inner options.execute, which
		// receives the ToolExecutionContext directly (no experimental_context
		// wrapper — that unwrapping is the AI SDK tool()'s job at call time).
		const ctx = { management: zeroAdmin } as any;

		const created = JSON.parse(await execute({
			action: "create",
			agentId: agent.id,
			workingScope: scope(proj.id, proj.workspaceDir),
			schedule: SCHED_INTERVAL_DAILY,
		}, ctx));
		expect(created.agentId).toBe(agent.id);

		const updated = JSON.parse(await execute({
			action: "update",
			id: created.id, schedule: SCHED_INTERVAL_WEEKLY,
		}, ctx));
		expect(updated.schedule).toEqual(SCHED_INTERVAL_WEEKLY);

		const list = JSON.parse(await execute({ action: "list" }, ctx));
		expect(list.length).toBe(1);

		const del = JSON.parse(await execute({ action: "delete", id: created.id }, ctx));
		expect(del.success).toBe(true);
		expect(zeroAdmin.listCrons().length).toBe(0);
	});

	test("create action without ctx.management returns error string (fail-soft)", async () => {
		const { cronTool } = await import("../../src/runtime/tools/cron-tool.js");
		const { getToolExecute } = await import("../../src/runtime/tools/tool-factory.js");
		const execute = getToolExecute(cronTool)!;
		const result = await execute({
			action: "create",
			agentId: "x", workingScope: scope(undefined, "/x", "r"), schedule: SCHED_INTERVAL_DAILY,
		}, {} as any);
		expect(String(result)).toMatch(/Error:/);
	});
});
