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
//   - ZeroAdminService.createCron / updateCron / deleteCron / listCrons
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
import { ZeroAdminService } from "../../src/server/zero-admin-service.js";
import { resolveSessionByRoleProject } from "../../src/server/session-context-router.js";
import { runMigrations } from "../../src/server/db-migration.js";
import type { CronRecord } from "../../src/shared/types.js";

let tmpDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let agentToolStore: AgentToolStore;
let cronStore: CronStore;
let zeroAdmin: ZeroAdminService;

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
	zeroAdmin = new ZeroAdminService({ agentStore, projectStore, agentToolStore, cronStore });
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
		const agent = agentStore.create({ name: "PM", roleTag: "pm" } as any);
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "ws") });
		const cron = cronStore.create({
			agentId: agent.id,
			workingScope: scope(proj.id, proj.workspaceDir),
			schedule: "hourly",
			prompt: "check in",
			enabled: true,
		});
		const fetched = cronStore.get(cron.id)!;
		expect(fetched.agentId).toBe(agent.id);
		expect(fetched.schedule).toBe("hourly");
		expect(fetched.workingScope.projectId).toBe(proj.id);
		expect(fetched.workingScope.workspaceDir).toBe(proj.workspaceDir);
		expect(fetched.workingScope.wikiRootNodeId).toBe(`wiki-root:${proj.id}`);
		expect(fetched.enabled).toBe(true);
	});

	test("create rejects workingScope missing workspaceDir/wikiRootNodeId", () => {
		const agent = agentStore.create({ name: "PM", roleTag: "pm" } as any);
		expect(() => cronStore.create({
			agentId: agent.id,
			workingScope: { workspaceDir: "/x" } as any,
			schedule: "daily",
			enabled: true,
		})).toThrow(/workspaceDir and wikiRootNodeId/);
	});

	test("listEnabled excludes disabled and off crons", () => {
		const agent = agentStore.create({ name: "PM", roleTag: "pm" } as any);
		cronStore.create({ agentId: agent.id, workingScope: scope(undefined, "/a", "r-a"), schedule: "hourly", enabled: true });
		cronStore.create({ agentId: agent.id, workingScope: scope(undefined, "/b", "r-b"), schedule: "daily", enabled: false });
		cronStore.create({ agentId: agent.id, workingScope: scope(undefined, "/c", "r-c"), schedule: "off", enabled: true });
		expect(cronStore.listEnabled().length).toBe(1);
		expect(cronStore.listEnabled()[0].workingScope.workspaceDir).toBe("/a");
	});

	test("listByAgent filters by agent", () => {
		const a1 = agentStore.create({ name: "PM1", roleTag: "pm" } as any);
		const a2 = agentStore.create({ name: "PM2", roleTag: "pm" } as any);
		cronStore.create({ agentId: a1.id, workingScope: scope(undefined, "/a", "r-a"), schedule: "hourly", enabled: true });
		cronStore.create({ agentId: a2.id, workingScope: scope(undefined, "/b", "r-b"), schedule: "hourly", enabled: true });
		expect(cronStore.listByAgent(a1.id).length).toBe(1);
	});

	test("delete is unbind — referenced agent stays intact", () => {
		const agent = agentStore.create({ name: "PM", roleTag: "pm" } as any);
		const cron = cronStore.create({ agentId: agent.id, workingScope: scope(undefined, "/a", "r-a"), schedule: "hourly", enabled: true });
		cronStore.delete(cron.id);
		expect(cronStore.get(cron.id)).toBeUndefined();
		// Agent untouched.
		expect(agentStore.get(agent.id)).toBeDefined();
	});

	test("deleteByAgent removes all crons for an agent", () => {
		const agent = agentStore.create({ name: "PM", roleTag: "pm" } as any);
		cronStore.create({ agentId: agent.id, workingScope: scope(undefined, "/a", "r-a"), schedule: "hourly", enabled: true });
		cronStore.create({ agentId: agent.id, workingScope: scope(undefined, "/b", "r-b"), schedule: "daily", enabled: true });
		expect(cronStore.listByAgent(agent.id).length).toBe(2);
		cronStore.deleteByAgent(agent.id);
		expect(cronStore.listByAgent(agent.id).length).toBe(0);
	});

	test("CRON_COLUMNS present on fresh DB (no migration script)", () => {
		// Fresh DB should have the crons table after runMigrations.
		const agent = agentStore.create({ name: "PM", roleTag: "pm" } as any);
		const cron = cronStore.create({ agentId: agent.id, workingScope: scope(undefined, "/a", "r-a"), schedule: "weekly", prompt: "p", enabled: false });
		expect(cron.prompt).toBe("p");
		expect(cron.schedule).toBe("weekly");
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
		pmAgent = agentStore.create({ name: "GlobalPM", roleTag: "pm" } as any);
		projA = projectStore.create({ name: "ProjA", workspaceDir: join(tmpDir, "wsA") });
		projB = projectStore.create({ name: "ProjB", workspaceDir: join(tmpDir, "wsB") });
	});

	test("project cron trigger routes via resolveSessionByRoleProject → two crons → two sessions", async () => {
		const cronA = cronStore.create({
			agentId: pmAgent.id, workingScope: scope(projA.id, projA.workspaceDir), schedule: "hourly", enabled: true,
		});
		const cronB = cronStore.create({
			agentId: pmAgent.id, workingScope: scope(projB.id, projB.workspaceDir), schedule: "daily", enabled: true,
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
			agentId: pmAgent.id, workingScope: scope(projA.id, projA.workspaceDir), schedule: "hourly", enabled: true,
		});
		await manager.triggerCron(cron.id);
		await manager.triggerCron(cron.id);
		expect(stubAgentService.calls.length).toBe(2);
		expect(stubAgentService.calls[0].sessionId).toBe(stubAgentService.calls[1].sessionId);
	});

	test("enabled=false cron is not triggered", async () => {
		const cron = cronStore.create({
			agentId: pmAgent.id, workingScope: scope(projA.id, projA.workspaceDir), schedule: "hourly", enabled: false,
		});
		await manager.triggerCron(cron.id);
		expect(stubAgentService.calls.length).toBe(0);
	});

	test("schedule=off cron is not triggered", async () => {
		const cron = cronStore.create({
			agentId: pmAgent.id, workingScope: scope(projA.id, projA.workspaceDir), schedule: "off", enabled: true,
		});
		await manager.triggerCron(cron.id);
		expect(stubAgentService.calls.length).toBe(0);
	});

	test("observation cron (no projectId) routes to agent main session", async () => {
		const cron = cronStore.create({
			agentId: pmAgent.id,
			workingScope: scope(undefined, "/global/ws", "wiki-root:global"),
			schedule: "hourly", enabled: true,
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
			agentId: pmAgent.id, workingScope: scope(projA.id, projA.workspaceDir), schedule: "hourly", enabled: true,
		});
		manager.refreshCron(cron.id);
		expect(manager.getScheduledCronIds()).toContain(cron.id);

		cronStore.update(cron.id, { enabled: false });
		manager.refreshCron(cron.id);
		expect(manager.getScheduledCronIds()).not.toContain(cron.id);
	});

	test("restoreSchedules scans cron table (not project table / agentStore.cronSchedule)", () => {
		// One enabled, one disabled, one off.
		const c1 = cronStore.create({ agentId: pmAgent.id, workingScope: scope(projA.id, projA.workspaceDir), schedule: "hourly", enabled: true });
		cronStore.create({ agentId: pmAgent.id, workingScope: scope(projB.id, projB.workspaceDir), schedule: "daily", enabled: false });
		cronStore.create({ agentId: pmAgent.id, workingScope: scope(projB.id, projB.workspaceDir), schedule: "off", enabled: true });

		manager.restoreSchedules();
		const scheduled = manager.getScheduledCronIds();
		expect(scheduled).toEqual([c1.id]);
	});

	test("deleting a cron does not delete the global agent", () => {
		const cron = cronStore.create({
			agentId: pmAgent.id, workingScope: scope(projA.id, projA.workspaceDir), schedule: "hourly", enabled: true,
		});
		cronStore.delete(cron.id);
		expect(agentStore.get(pmAgent.id)).toBeDefined();
	});
});

// ─── ZeroAdminService cron methods ───────────────────────────

describe("ZeroAdminService cron methods", () => {
	test("createCron validates agent + project refs", () => {
		expect(() => zeroAdmin.createCron({
			agentId: "nonexistent",
			workingScope: scope(undefined, "/x", "r"),
			schedule: "daily",
		})).toThrow(/Agent not found/);

		const agent = agentStore.create({ name: "PM", roleTag: "pm" } as any);
		expect(() => zeroAdmin.createCron({
			agentId: agent.id,
			workingScope: scope("nonexistent-project", "/x", "r"),
			schedule: "daily",
		})).toThrow(/Project not found/);
	});

	test("createCron + listCrons + updateCron + deleteCron lifecycle", () => {
		const agent = agentStore.create({ name: "PM", roleTag: "pm" } as any);
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "ws") });

		const cron = zeroAdmin.createCron({
			agentId: agent.id,
			workingScope: scope(proj.id, proj.workspaceDir),
			schedule: "daily",
		});
		expect(cron.enabled).toBe(true); // default
		expect(zeroAdmin.listCrons().length).toBe(1);
		expect(zeroAdmin.listCrons({ agentId: agent.id }).length).toBe(1);

		const updated = zeroAdmin.updateCron(cron.id, { schedule: "weekly", enabled: false });
		expect(updated.schedule).toBe("weekly");
		expect(updated.enabled).toBe(false);

		zeroAdmin.deleteCron(cron.id);
		expect(zeroAdmin.listCrons().length).toBe(0);
		// Agent still present.
		expect(agentStore.get(agent.id)).toBeDefined();
	});

	test("deleteAgent cascades its cron entries (reverse direction)", () => {
		const agent = agentStore.create({ name: "PM", roleTag: "pm" } as any);
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "ws") });
		zeroAdmin.createCron({ agentId: agent.id, workingScope: scope(proj.id, proj.workspaceDir), schedule: "daily" });
		zeroAdmin.createCron({ agentId: agent.id, workingScope: scope(proj.id, proj.workspaceDir, "r2"), schedule: "hourly" });
		expect(cronStore.listByAgent(agent.id).length).toBe(2);
		zeroAdmin.deleteAgent(agent.id);
		expect(cronStore.listByAgent(agent.id).length).toBe(0);
	});
});

// ─── cron tools ──────────────────────────────────────────────

describe("cron admin tools", () => {
	test("CreateCron / UpdateCron / DeleteCron / ListCrons invoke ZeroAdminService via ctx.zeroAdmin", async () => {
		const { ZERO_ADMIN_TOOLS } = await import("../../src/runtime/tools/zero-admin-tools.js");
		const agent = agentStore.create({ name: "PM", roleTag: "pm" } as any);
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "ws") });
		// AI SDK tool() execute receives (input, opts); ctx lives at opts.experimental_context.
		const ctx = { experimental_context: { zeroAdmin } } as any;

		const created = JSON.parse(await ZERO_ADMIN_TOOLS.CreateCron.execute({
			agentId: agent.id,
			workingScope: scope(proj.id, proj.workspaceDir),
			schedule: "daily",
		}, ctx));
		expect(created.agentId).toBe(agent.id);

		const updated = JSON.parse(await ZERO_ADMIN_TOOLS.UpdateCron.execute({
			id: created.id, schedule: "weekly",
		}, ctx));
		expect(updated.schedule).toBe("weekly");

		const list = JSON.parse(await ZERO_ADMIN_TOOLS.ListCrons.execute({}, ctx));
		expect(list.length).toBe(1);

		const del = JSON.parse(await ZERO_ADMIN_TOOLS.DeleteCron.execute({ id: created.id }, ctx));
		expect(del.success).toBe(true);
		expect(zeroAdmin.listCrons().length).toBe(0);
	});

	test("CreateCron without ctx.zeroAdmin returns error string (fail-soft)", async () => {
		const { ZERO_ADMIN_TOOLS } = await import("../../src/runtime/tools/zero-admin-tools.js");
		const result = await ZERO_ADMIN_TOOLS.CreateCron.execute({
			agentId: "x", workingScope: scope(undefined, "/x", "r"), schedule: "daily",
		}, { experimental_context: {} } as any);
		expect(String(result)).toMatch(/Error:/);
	});
});
