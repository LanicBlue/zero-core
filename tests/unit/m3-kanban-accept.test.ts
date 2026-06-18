// M3 acceptance-fix 单元测试 — 看板 plan-gate pending + verify accept→archivist
//
// # 文件说明书
//
// ## 核心功能
// 验证 acceptance-M3 第 4 条(看板 pending plan 入口)和第 6 条(verify accept
// → archivist)在最新修复后成立:
//   - 缺陷 1 修复后:OrchestratePlanStore.list({ state: "pending" }) 可作为
//     看板 IPC pending 入口的数据源;ConfirmRegistry.confirm/reject 唤醒挂起
//     的 Orchestrate 工具。
//
// ## v0.8 P7 适配
//   - 缺陷 2 (verify_accept → archivist) 由 P7 拉模型重做接通:verify-tool 调
//     PM(delegateTask)拿 verdict → PmService.submitCoverageVerdict →
//     ArchivistService.mergeFeatureToMain + 状态 → closed。ProjectNotificationRouter
//     已废;requirement-hooks 只保留 plan→build + lead autoPickupIfIdle。
//   - 这里的测试改为:① 确认 requirement-hooks 不再自动 build→verify(P7 显式提交)
//     ② 端到端 verify-tool → archivist merge 闭环见 p7-end-to-end.test.ts。
//
// ## 关键文件
//   - src/server/orchestrate-store.ts (plan store + ConfirmRegistry)
//   - src/server/requirement-hooks.ts (plan→build + autoPickupIfIdle)
//   - src/runtime/tools/verify-tool.ts (verify-tool → submitCoverageVerdict)
//   - src/server/pm-service.ts (submitCoverageVerdict → archivist merge)
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


// ─── v0.8 P7:verify-tool → archivist merge 端到端(取代缺陷 2 router 路径)──
//
// P7 重做后,缺陷 2(verify accept → archivist)的机制完全变了:
//   - ProjectNotificationRouter 已删;requirement-hooks 不再自动 build→verify。
//   - lead 显式调 verify 工具 → delegateTask 给 PM → PM verdict 回灌 →
//     PmService.submitCoverageVerdict → ArchivistService.mergeFeatureToMain +
//     状态 → closed。
//
// 这一节直接驱动 verify-tool.execute(),mock delegateTask 返回 APPROVED/
// REJECTED,断言 PmService → ArchivistService 链路 + 终态正确。

import { verifyTool } from "../../src/runtime/tools/verify-tool.js";
import { getToolExecute } from "../../src/runtime/tools/tool-factory.js";
import { PmService } from "../../src/server/pm-service.js";
import { RequirementDocStore } from "../../src/server/requirement-doc-store.js";
import { WikiStore } from "../../src/server/wiki-node-store.js";

function buildPmForP7(archivistService: any, pmAgentId: string): PmService {
	return new PmService({
		agentService: { sendPrompt: async () => {} } as any,
		agentStore,
		projectStore,
		requirementStore,
		requirementDocStore: new RequirementDocStore({
			getWorkspaceDir: (pid: string) => projectStore.get(pid)?.workspaceDir,
		}),
		wikiNodeStore: new WikiStore(sessionDB),
		manifestStore,
		archivistService,
		sessionDB,
		// @ts-ignore — pmAgentId unused here, kept for parity with future wiring
		...({} as any),
	});
}

describe("v0.8 P7 — verify-tool → PM verdict → archivist merge (defect 2 P7 重做)", () => {
	function setupReadyRequirement(opts: { pmAgentId: string; projectWorkspace: string }) {
		const project = projectStore.create({ name: "P7P", workspaceDir: opts.projectWorkspace } as any);
		// PM agent that "created" the requirement (route-by-agentId).
		const req = requirementStore.create({
			projectId: project.id,
			title: "Verify-me",
			status: "discuss",
			source: "analyst",
			priority: "normal",
			createdByAgentId: opts.pmAgentId,
			reviewerAgentId: opts.pmAgentId,
		} as any);
		// Advance to verify (real flow: ready→plan→build→verify).
		requirementStore.transitionStatus(req.id, "ready", "user", "discuss → ready");
		requirementStore.transitionStatus(req.id, "plan", "lead", "ready → plan");
		requirementStore.transitionStatus(req.id, "build", "lead", "plan → build");
		requirementStore.transitionStatus(req.id, "verify", "system", "build → verify (lead submitted)");
		return { project, req };
	}

	test("verify-tool APPROVED → PmService.submitCoverageVerdict → archivistService.mergeFeatureToMain → status closed", async () => {
		const merges: Array<{ projectId: string; requirementId: string }> = [];
		const archivist = {
			mergeFeatureToMain: async (projectId: string, requirementId: string) => {
				merges.push({ projectId, requirementId });
				return { ok: true, ref: "main-merged-1" };
			},
		};
		const pm = buildPmForP7(archivist, "pm-agent-xyz");
		const pmAgent = agentStore.create({ name: "PM" } as any);

		const { req, project } = setupReadyRequirement({ pmAgentId: pmAgent.id, projectWorkspace: join(tmpDir, "ws-p7-1") });

		const execute = getToolExecute(verifyTool)!;
		const out = await execute(
			{ requirementId: req.id, summary: "ready" },
			{
				workingDir: project.workspaceDir,
				agentId: "lead-1",
				emit: () => {},
				requirementStore,
				pmService: pm,
				delegateTask: async () => "VERDICT: APPROVED — covers the intent",
			} as any,
		);

		expect(merges).toEqual([{ projectId: project.id, requirementId: req.id }]);
		expect(out).toMatch(/APPROVED/);
		expect(out).toMatch(/main-merged-1/);
		expect(requirementStore.get(req.id)!.status).toBe("closed");
	});

	test("verify-tool REJECTED → no merge; feedback recorded; status stays 'verify'", async () => {
		const merges: any[] = [];
		const archivist = {
			mergeFeatureToMain: async () => { merges.push("called"); return { ok: true }; },
		};
		const pm = buildPmForP7(archivist, "pm-agent-xyz");
		const pmAgent = agentStore.create({ name: "PM" } as any);
		const { req, project } = setupReadyRequirement({ pmAgentId: pmAgent.id, projectWorkspace: join(tmpDir, "ws-p7-2") });

		const execute = getToolExecute(verifyTool)!;
		const out = await execute(
			{ requirementId: req.id, summary: "ready" },
			{
				workingDir: project.workspaceDir,
				agentId: "lead-1",
				emit: () => {},
				requirementStore,
				pmService: pm,
				delegateTask: async () => "VERDICT: REJECTED — missing tests for X",
			} as any,
		);

		expect(merges).toEqual([]);
		expect(out).toMatch(/REJECTED/);
		expect(out).toMatch(/missing tests for X/);
		expect(requirementStore.get(req.id)!.status).toBe("verify");
		// Feedback message recorded on the requirement (audit + lead surface).
		const msgs = requirementStore.getMessages(req.id);
		expect(msgs.some((m) => m.content.includes("NOT_COVERED"))).toBe(true);
	});

	test("verify-tool PM dispatch failure → degrade to fail-safe (no merge, no advance)", async () => {
		const merges: any[] = [];
		const archivist = {
			mergeFeatureToMain: async () => { merges.push("called"); return { ok: true }; },
		};
		const pm = buildPmForP7(archivist, "pm-agent-xyz");
		const pmAgent = agentStore.create({ name: "PM" } as any);
		const { req, project } = setupReadyRequirement({ pmAgentId: pmAgent.id, projectWorkspace: join(tmpDir, "ws-p7-3") });

		const execute = getToolExecute(verifyTool)!;
		const out = await execute(
			{ requirementId: req.id },
			{
				workingDir: project.workspaceDir,
				agentId: "lead-1",
				emit: () => {},
				requirementStore,
				pmService: pm,
				delegateTask: async () => { throw new Error("PM session crashed"); },
			} as any,
		);

		expect(merges).toEqual([]);
		expect(out).toMatch(/PM coverage dispatch failed/i);
		expect(requirementStore.get(req.id)!.status).toBe("verify");
	});

	test("verify-tool with no req.createdByAgentId → returns error (P7 addresses PM by req-recorded agentId)", async () => {
		const archivist = { mergeFeatureToMain: async () => ({ ok: true }) };
		const pm = buildPmForP7(archivist, "pm-agent-xyz");
		const project = projectStore.create({ name: "P7-noPM", workspaceDir: join(tmpDir, "ws-p7-4") } as any);
		// No createdByAgentId, no reviewerAgentId.
		const req = requirementStore.create({
			projectId: project.id, title: "Orphan", status: "build",
			source: "user", priority: "normal",
		} as any);

		const execute = getToolExecute(verifyTool)!;
		const out = await execute(
			{ requirementId: req.id },
			{
				workingDir: project.workspaceDir,
				agentId: "lead-1",
				emit: () => {},
				requirementStore,
				pmService: pm,
				delegateTask: async () => "VERDICT: APPROVED",
			} as any,
		);
		expect(out).toMatch(/no reviewerAgentId/i);
	});
});
