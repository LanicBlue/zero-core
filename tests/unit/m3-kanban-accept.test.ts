// M3 acceptance-fix 单元测试 — 看板 plan-gate pending(confirm/reject 入口)
//
// # 文件说明书
//
// ## 核心功能
// 验证 acceptance-M3 第 4 条(看板 pending plan 入口)在最新修复后成立:
//   - 缺陷 1 修复后:OrchestratePlanStore.list({ state: "pending" }) 可作为
//     看板 IPC pending 入口的数据源;ConfirmRegistry.confirm/reject 唤醒挂起
//     的 Orchestrate 工具。
//
// ## 历史
//   - 缺陷 2(verify accept → archivist)的端到端闭环在 project-flow F3 已迁到
//     Flow.verify(见 tests/unit/f3-flow-verify.test.ts)。Flow.verify 是单一入口,
//     调 PM delegateTask 拿 verdict → PmService.submitCoverageVerdict →
//     ArchivistService.mergeFeatureToMain + 状态 → closed。ProjectNotificationRouter
//     已废;requirement-hooks 只保留 plan→build + lead autoPickupIfIdle。
//   - 本文件不再驱动 verify-tool(F5 已删);只保留 plan-gate confirm/reject 用例。
//
// ## 关键文件
//   - src/server/orchestrate-store.ts (plan store + ConfirmRegistry)
//   - src/server/requirement-hooks.ts (plan→build + autoPickupIfIdle)
//   - src/runtime/tools/flow-tool.ts (Flow.verify 复合,见 f3-flow-verify)
//   - src/server/pm-service.ts (submitCoverageVerdict → archivist merge)
//
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDatabase } from "../../src/server/core-database.js";
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
let sessionDB: CoreDatabase;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let requirementStore: RequirementStore;
let planStore: OrchestratePlanStore;
let manifestStore: OrchestrateManifestStore;
let registry: ConfirmRegistry;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-m3-fix-"));
	sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
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


// (project-flow F5) The "verify-tool → PM verdict → archivist merge" section
// that used to live here is dropped: verify-tool.ts is deleted and Flow.verify
// (the compound replacement) is exercised end-to-end in
// tests/unit/f3-flow-verify.test.ts (APPROVED → merge + closed; REJECTED →
// rework + feedback; PM dispatch failure fail-safe; reviewer-resolution).
