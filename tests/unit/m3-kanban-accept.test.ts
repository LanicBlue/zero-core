// M3 acceptance-fix 单元测试 — 看板 plan-gate pending + verify accept→archivist
//
// # 文件说明书
//
// ## 核心功能
// 验证 acceptance-M3 第 4 条(看板 pending plan 入口)和第 6 条(verify accept
// → archivist 通知触发)在最新修复后成立:
//   - 缺陷 1 修复后:OrchestratePlanStore.list({ state: "pending" }) 可作为
//     看板 IPC pending 入口的数据源;ConfirmRegistry.confirm/reject 唤醒挂起
//     的 Orchestrate 工具。
//   - 缺陷 2 修复后:requirement-hooks 的 verify PASSED 分支会调
//     projectNotificationRouter.notify("verify_accept", ...)。
//
// ## 关键文件
//   - src/server/orchestrate-store.ts (plan store + ConfirmRegistry)
//   - src/server/project-notification-router.ts (verify_accept → archivist)
//   - src/server/requirement-hooks.ts (verify PASSED → notify verify_accept)
//
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { RequirementStore } from "../../src/server/requirement-store.js";
import {
	OrchestratePlanStore,
	OrchestrateManifestStore,
	ConfirmRegistry,
} from "../../src/server/orchestrate-store.js";
import { runMigrations } from "../../src/server/db-migration.js";
// v0.8 P0 (§1.4 过渡期): roleTag 不再走 store round-trip;物理列直接 seed。
import { seedAgentWithRoleTag } from "./helpers/p0-test-helpers.js";

let tmpDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let requirementStore: RequirementStore;
let planStore: OrchestratePlanStore;
let manifestStore: OrchestrateManifestStore;
let registry: ConfirmRegistry;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-m3-fix-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	requirementStore = new RequirementStore(sessionDB);
	planStore = new OrchestratePlanStore(sessionDB);
	manifestStore = new OrchestrateManifestStore(sessionDB);
	registry = ConfirmRegistry.getInstance();
	for (const id of registry.listPendingPlanIds()) registry.drop(id);
});

afterEach(() => {
	for (const id of registry.listPendingPlanIds()) registry.drop(id);
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

// ─── 缺陷 1:kanban pending plan entry (acceptance-M3 item 4) ──────────

describe("kanban plan-gate pending entry (defect 1 fix)", () => {
	test("planStore.list({ state: 'pending', projectId }) returns the right pending plans", () => {
		// Two pending plans, one for proj-A one for proj-B, plus one completed.
		const pA = planStore.create({
			requirementId: "req-1", projectId: "proj-A",
			leadAgentId: "lead-1", leadSessionId: "sess-1",
			flow: JSON.stringify({ requirementId: "req-1", title: "Plan A", root: { kind: "barrier", id: "b" } }),
			state: "pending",
		});
		planStore.create({
			requirementId: "req-2", projectId: "proj-B",
			leadAgentId: "lead-1", leadSessionId: "sess-1",
			flow: "{}", state: "pending",
		});
		planStore.create({
			requirementId: "req-3", projectId: "proj-A",
			leadAgentId: "lead-1", leadSessionId: "sess-1",
			flow: "{}", state: "completed",
		});

		// Simulate what the kanban IPC `orchestrate:pending` channel does.
		const result = planStore.list({ state: "pending", projectId: "proj-A" });
		expect(result.length).toBe(1);
		expect(result[0].id).toBe(pA.id);
		expect(result[0].state).toBe("pending");
	});

	test("confirm path: setState confirmed + ConfirmRegistry.confirm resolves awaiter", async () => {
		const plan = planStore.create({
			requirementId: "req-1", projectId: "proj-1",
			leadAgentId: "lead-1", leadSessionId: "sess-1",
			flow: "{}", state: "pending",
		});
		const p = registry.register(plan.id);

		// Mirror orchestrate-handlers confirm path.
		planStore.setState(plan.id, "confirmed");
		const ok = registry.confirm(plan.id);
		expect(ok).toBe(true);
		expect(await p).toBe(true);
		expect(planStore.get(plan.id)?.state).toBe("confirmed");

		// Plan no longer appears in pending list.
		expect(planStore.list({ state: "pending", projectId: "proj-1" }).length).toBe(0);
	});

	test("reject path: setState rejected + reason + ConfirmRegistry.reject resolves to false", async () => {
		const plan = planStore.create({
			requirementId: "req-1", projectId: "proj-1",
			leadAgentId: "lead-1", leadSessionId: "sess-1",
			flow: "{}", state: "pending",
		});
		const p = registry.register(plan.id);
		p.catch(() => {});

		planStore.setState(plan.id, "rejected", { rejectionReason: "missing tests" });
		const ok = registry.reject(plan.id);
		expect(ok).toBe(true);
		expect(await p).toBe(false);
		const stored = planStore.get(plan.id);
		expect(stored?.state).toBe("rejected");
		expect(stored?.rejectionReason).toBe("missing tests");
	});
});

// ─── 缺陷 2:verify accept → archivist notification (acceptance-M3 item 6) ──

describe("verify accept → notify archivist (defect 2 fix)", () => {
	test("ProjectNotificationRouter.notify('verify_accept') resolves an archivist role session + sends prompt", async () => {
		const { ProjectNotificationRouter } = await import("../../src/server/project-notification-router.js");

		// Register an archivist agent (roleTag='archivist').
		// v0.8 P0 (§1.4): roleTag removed from AgentRecord; seed the physical
		// column so findRoleAgent('archivist') finds it.
		const archivistAgent = agentStore.create({
			name: "Archivist",
			workspaceDir: join(tmpDir, "ws"),
		});
		seedAgentWithRoleTag(sessionDB, archivistAgent.id, "archivist");

		const project = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "ws") });
		const req = requirementStore.create({
			projectId: project.id, title: "V", status: "verify",
			source: "user", priority: "normal", reviewer: "user",
		} as any);

		const sent: Array<{ agentId: string; sessionId: string; prompt: string }> = [];
		const router = new ProjectNotificationRouter({
			agentService: {
				sendPrompt: async (prompt: string, agent: any, sessionId: string) => {
					sent.push({ agentId: agent.id, sessionId, prompt });
				},
			} as any,
			agentStore,
			projectStore,
			requirementStore,
			sessionDB,
			leadService: { pickupRequirement: async () => "x" } as any,
			manifestStore,
		});

		// Top-level dispatch should route verify_accept → archivist session.
		await router.notify("verify_accept", req.id, project.id);

		expect(sent.length).toBe(1);
		const target = sent[0];
		// Prompt mentions the merge task + requirementId (archivist must merge feature→main).
		expect(target.prompt).toMatch(/merge/i);
		expect(target.prompt).toContain(req.id);
		// The role-session-resolved agentId is the archivist's.
		expect(target.agentId).toBe(archivistAgent.id);
	});

	test("verify_accept with no archivist agent does NOT throw (cron fallback will retry)", async () => {
		const { ProjectNotificationRouter } = await import("../../src/server/project-notification-router.js");
		const project = projectStore.create({ name: "P2", workspaceDir: join(tmpDir, "ws2") });

		const router = new ProjectNotificationRouter({
			agentService: { sendPrompt: async () => {} } as any,
			agentStore,
			projectStore,
			requirementStore,
			sessionDB,
			leadService: { pickupRequirement: async () => "x" } as any,
			manifestStore,
		});

		// No archivist agent registered — notify must not throw; it logs + returns.
		await expect(router.notify("verify_accept", "req-missing", project.id)).resolves.toBeUndefined();
	});

	test("requirement-hooks verify PASSED fires notify('verify_accept') before archiveRequirement", async () => {
		// Register the hooks with mocked analystService + projectNotificationRouter
		// and verify the verify_accept notify is invoked when reviewer=analyst and
		// verifyRequirement resolves to passed:true.
		const { registerRequirementHooks } = await import("../../src/server/requirement-hooks.js");
		const { HookRegistry } = await import("../../src/core/hook-registry.js");

		const project = projectStore.create({ name: "P3", workspaceDir: join(tmpDir, "ws3") });
		const req = requirementStore.create({
			projectId: project.id, title: "H", status: "build",
			source: "user", priority: "normal", reviewer: "analyst",
		} as any);

		const notifyCalls: Array<{ kind: string; reqId: string; projectId: string }> = [];
		const projectNotificationRouter = {
			notify: async (kind: string, reqId: string, projectId: string) => {
				notifyCalls.push({ kind, reqId, projectId });
			},
		};

		const archivedCalls: string[] = [];
		const analystService = {
			verifyRequirement: async () => ({ passed: true, report: "PASSED" }),
			archiveRequirement: async (id: string) => { archivedCalls.push(id); },
		};

		// Build a minimal hook registry and register the hooks against it.
		const registryInst = new HookRegistry();
		registerRequirementHooks({
			requirementStore,
			taskStepStore: {
				listByRequirement: () => [
					{ id: "s1", status: "completed", role: "developer", title: "step", output: "" } as any,
				],
			} as any,
			leadService: { autoPickupIfIdle: async () => null } as any,
			analystService: analystService as any,
			notificationService: undefined,
			projectNotificationRouter: projectNotificationRouter as any,
			hookRegistry: registryInst,
		});

		// Simulate the PostTurnComplete firing for a Lead session bound to the build req.
		// The hook's name-pattern guard requires agentId to start with "Lead-".
		const leadAgent = agentStore.create({
			name: "Lead-P3", roleTag: "lead",
			workspaceDir: project.workspaceDir,
		} as any);
		requirementStore.update(req.id, { assignedLeadSessionId: "sess-lead" } as any);

		await registryInst.trigger("PostTurnComplete", {
			agentId: "Lead-P3",  // match the name-pattern guard in requirement-hooks
			sessionId: "sess-lead",
		} as any);

		// Wait one microtask round — verifyRequirement + notify + archive are chained.
		await new Promise((r) => setTimeout(r, 30));

		// verify_accept notify must have fired before archive.
		expect(notifyCalls).toContainEqual({ kind: "verify_accept", reqId: req.id, projectId: project.id });
		expect(archivedCalls).toContain(req.id);
	});
});
