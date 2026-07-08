// P7 端到端单元测试 — 拉模型闭环(acceptance-P7.md)
//
// # 文件说明书
//
// ## 核心功能
// 验证 v0.8 P7 关键路径终点:
//   ready → plan(lead 领取)→ build(hook 自动推)→ verify(lead 显式提交)→
//   PM verdict → archivist merge → closed
//
// 全程无 ProjectNotificationRouter / notify 推送,寻址用
// req.createdByAgentId / reviewerAgentId(无 roleTag 查找)。
//
// ## 覆盖场景(对应 acceptance-P7.md「测试」节)
//   - 完整 pipeline 跑通:ready→plan→build→verify→archivist merge→closed
//   - verify 不通过 → lead 收意见 → 改计划重提 → 通过
//   - discuss-by-id(req.createdByAgentId 定位 PM session)
//   - 状态机回退(verify 不通过 → 重新走 plan/build/verify)
//   - PM dispatch 失败降级
//   - archivist 未注入 → 状态留 verify(降级)
//
// ## 测试策略
// 不依赖真实 LLM —— delegateTask 是 mock,archivistService 是 mock,
// 状态机 / store / pmService / flowTool 全是真实组件。
// 这等同于 ZERO_CORE_TEST_FIXTURE(mock provider)路径在 unit 层的等价物。
//
// ## project-flow F5
// verify-tool.ts 已删,Flow.verify(复合)是单一入口;本文件改驱动 flowTool。
// 验证语义不变:delegate PM → PmService.submitCoverageVerdict → archivist
// merge → status closed / rework。
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { RequirementStore } from "../../src/server/requirement-store.js";
import { TaskStepStore } from "../../src/server/task-step-store.js";
import { OrchestrateManifestStore } from "../../src/server/orchestrate-store.js";
import { WikiStore } from "../../src/server/wiki-node-store.js";
import { RequirementDocStore } from "../../src/server/requirement-doc-store.js";
import { PmService } from "../../src/server/pm-service.js";
// project-flow F5: verify-tool.ts is deleted; Flow.verify (compound) is the
// replacement. This end-to-end file now drives flowTool — the same single
// entry point the runtime uses. The pmService is the real PmService (so
// archivist merge + status close are real, not mocked), exactly as before.
import { flowTool } from "../../src/tools/flow-tool.js";
import { getToolExecute, getToolFormat } from "../../src/tools/tool-factory.js";
import { createFlowActions } from "../../src/server/flow-actions.js";
import {
	emitTransition,
	_resetDataChangeHubForTest,
} from "../../src/server/data-change-hub.js";
import { runMigrations } from "../../src/server/db-migration.js";

let tmpDir: string;
let workspaceDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let requirementStore: RequirementStore;
let taskStepStore: TaskStepStore;
let manifestStore: OrchestrateManifestStore;
let wikiStore: WikiStore;
let docStore: RequirementDocStore;

let PROJECT_ID: string;
let PM_AGENT_ID: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-p7-e2e-"));
	workspaceDir = join(tmpDir, "ws");
	mkdirSync(workspaceDir, { recursive: true });

	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	requirementStore = new RequirementStore(sessionDB);
	taskStepStore = new TaskStepStore(sessionDB);
	manifestStore = new OrchestrateManifestStore(sessionDB);
	wikiStore = new WikiStore(sessionDB);
	docStore = new RequirementDocStore({
		getWorkspaceDir: (pid) => projectStore.get(pid)?.workspaceDir,
	});

	const project = projectStore.create({ name: "P7-Project", workspaceDir } as any);
	PROJECT_ID = project.id;

	// Register the global PM agent. P7 routes by createdByAgentId, so the PM
	// agent exists before the requirement is created.
	const pmAgent = agentStore.create({
		name: "PM",
		systemPrompt: "pm",
		toolPolicy: { tools: {} },
	} as any);
	PM_AGENT_ID = pmAgent.id;
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Build PmService with a mock archivist that records every merge call. */
function buildPm(archivist?: any): { pm: PmService; merges: any[] } {
	const merges: any[] = [];
	const arch = archivist ?? {
		mergeFeatureToMain: async (projectId: string, requirementId: string) => {
			merges.push({ projectId, requirementId });
			return { ok: true, ref: `main-${requirementId.slice(0, 6)}` };
		},
	};
	const pm = new PmService({
		agentService: { sendPrompt: async () => {} } as any,
		agentStore,
		projectStore,
		requirementStore,
		requirementDocStore: docStore,
		wikiNodeStore: wikiStore,
		manifestStore,
		archivistService: arch,
		sessionDB,
	});
	return { pm, merges };
}

/** Build a requirement created by the PM agent (canonical P7 path). */
function makeRequirement(title: string): { req: any; pm: PmService; merges: any[] } {
	const { pm, merges } = buildPm();
	const req = pm.createRequirementWithDoc({
		projectId: PROJECT_ID,
		title,
		source: "agent",
		createdByAgentId: PM_AGENT_ID,
	});
	return { req, pm, merges };
}

/** Drive the requirement through the state machine: discuss → ready → plan → build → verify. */
function advanceToVerify(reqId: string): void {
	requirementStore.transitionStatus(reqId, "ready", "user", "user confirms discuss");
	requirementStore.transitionStatus(reqId, "plan", "agent", "agent picks up");
	requirementStore.transitionStatus(reqId, "build", "agent", "agent records first step (PostToolUse)");
	requirementStore.transitionStatus(reqId, "verify", "system", "agent submits verify tool");
}

/** Invoke Flow.verify with a caller-supplied verdict. Drives the real
 * PmService (with its real archivistService mock) through the shared
 * flowActions backend — same compound body the REST router uses. The verdict
 * is supplied by the caller (the reviewing agent / user), NOT delegated. */
async function callVerify(
	reqId: string,
	pm: PmService,
	opts: { covered?: boolean; reason?: string } = {},
): Promise<string> {
	const execute = getToolExecute(flowTool)!;
	const format = getToolFormat(flowTool)!;
	// Forward covered/reason only when supplied — omitting covered exercises
	// the degrade path (the tool asks the caller to supply a verdict).
	const input: any = { action: "verify", id: reqId };
	if (opts.covered !== undefined) input.covered = opts.covered;
	if (opts.reason !== undefined) input.reason = opts.reason;
	// Reset the hub so signals from this call don't bleed across tests.
	_resetDataChangeHubForTest();
	const flowActions = createFlowActions({
		requirementStore,
		resolveWorkspaceDir: () => workspaceDir,
		emitTransition,
		pmService: pm,
	});
	// tool-decoupling sub-4:Flow now returns ToolResult JSON; format it back to
	// the LLM-facing string the existing assertions expect. CallerCtx shape =
	// legacy ctx fields passed through (flowActions/contextBundle/etc. have the
	// same names on CallerCtx).
	const json = await execute(input, {
		caller: "internal" as const,
		workingDir: workspaceDir,
		agentId: "agent-1",
		emit: () => {},
		requirementStore,
		flowActions,
		pmService: pm,
		contextBundle: { projectId: PROJECT_ID, workspaceDir, wikiRootNodeId: `root:${PROJECT_ID}` },
	} as any);
	return format(json);
}

// ─── 完整 pipeline(核心)──────────────────────────────────────────

describe("P7 端到端完整 pipeline: ready → plan → build → verify → archivist merge → closed", () => {
	test("happy path: lead submits verify, PM approves, archivist merges, requirement → closed", async () => {
		const { req, pm, merges } = makeRequirement("Full happy path");
		// Phase 1: ready → plan → build → verify (state machine).
		advanceToVerify(req.id);
		expect(requirementStore.get(req.id)!.status).toBe("verify");

		// Phase 2: lead calls verify tool, PM returns APPROVED.
		const out = await callVerify(req.id, pm, {
			covered: true, reason: "change + tests cover the intent",
		});

		// Phase 3: archivist merged + status closed.
		expect(merges).toEqual([{ projectId: PROJECT_ID, requirementId: req.id }]);
		expect(out).toMatch(/APPROVED/);
		expect(out).toMatch(/main-/);
		expect(requirementStore.get(req.id)!.status).toBe("closed");

		// Audit: status_change messages record both verdict + close.
		const msgs = requirementStore.getMessages(req.id);
		expect(msgs.some((m) => m.content.includes("PM coverage verdict") && m.content.includes("COVERED"))).toBe(true);
		expect(msgs.some((m) => m.content.includes("archivist merged"))).toBe(true);
	});

	test("PM rejects → Flow.verify rework verify→build; lead revises + re-submits → closed", async () => {
		const { req, pm, merges } = makeRequirement("Iterate-to-close");
		advanceToVerify(req.id);

		// First submission: PM rejects.
		const out1 = await callVerify(req.id, pm, {
			covered: false, reason: "missing tests for error path",
		});
		expect(out1).toMatch(/REJECTED/);
		expect(out1).toContain("missing tests for error path");
		expect(merges).toEqual([]); // no merge attempted
		// project-flow F3 contract: Flow.verify REJECTED performs the rework
		// transition verify→build itself (the delivery work's next fire reads
		// the Decision Log feedback + re-runs plan→finishBuild→verify). The
		// old verify-tool left status in 'verify'; Flow.verify advances to
		// 'build' on rejection.
		expect(requirementStore.get(req.id)!.status).toBe("build");
		// Feedback recorded on the requirement (lead will read on re-activation).
		const msgs1 = requirementStore.getMessages(req.id);
		expect(msgs1.some((m) => m.content.includes("NOT_COVERED") && m.content.includes("missing tests for error path"))).toBe(true);

		// Lead revises (build → verify via finishBuild-equivalent), then re-submits.
		requirementStore.transitionStatus(req.id, "verify", "system", "lead re-submits verify");
		const out2 = await callVerify(req.id, pm, {
			covered: true, reason: "error path now covered",
		});
		expect(out2).toMatch(/APPROVED/);
		expect(merges).toEqual([{ projectId: PROJECT_ID, requirementId: req.id }]);
		expect(requirementStore.get(req.id)!.status).toBe("closed");
	});
});

// ─── verdict-driven 降级(fail-safe,不卡死)────────────────────────

describe("P7 — verdict-driven 降级(fail-safe,不卡死)", () => {
	test("caller omits covered → degrade guidance, no merge, status stays verify", async () => {
		const { req, pm, merges } = makeRequirement("No verdict");
		advanceToVerify(req.id);

		const out = await callVerify(req.id, pm, {}); // no covered/reason
		expect(out).toMatch(/verdict not supplied/i);
		expect(merges).toEqual([]);
		expect(requirementStore.get(req.id)!.status).toBe("verify");
	});

	test("caller explicitly REJECTS → rework verify→build (no silent approval)", async () => {
		const { req, pm, merges } = makeRequirement("Explicit reject");
		advanceToVerify(req.id);

		const out = await callVerify(req.id, pm, { covered: false, reason: "missing tests for error path" });
		expect(out).toMatch(/REJECTED/);
		expect(merges).toEqual([]);
		// project-flow F3: REJECTED → rework verify→build (Flow.verify does the
		// transition itself; old verify-tool left status 'verify').
		expect(requirementStore.get(req.id)!.status).toBe("build");
	});
});

// ─── archivist 降级 ─────────────────────────────────────────────

describe("P7 — archivist merge 失败 / 未注入降级", () => {
	test("archivist merge throws → status stays verify (cron fallback retries)", async () => {
		const { req } = makeRequirement("Merge conflict");
		advanceToVerify(req.id);

		const { pm } = buildPm({
			mergeFeatureToMain: async () => { throw new Error("git conflict"); },
		});

		const out = await callVerify(req.id, pm, {
			covered: true, reason: "covers",
		});
		expect(out).toMatch(/APPROVED/);
		expect(out).toMatch(/Archivist merge FAILED/i);
		expect(requirementStore.get(req.id)!.status).toBe("verify");
	});

	test("no archivistService wired → status stays verify", async () => {
		const { req } = makeRequirement("No archivist");
		advanceToVerify(req.id);

		// Build PmService WITHOUT archivistService.
		const pm = new PmService({
			agentService: { sendPrompt: async () => {} } as any,
			agentStore, projectStore, requirementStore,
			requirementDocStore: docStore,
			wikiNodeStore: wikiStore,
			manifestStore,
			sessionDB,
		} as any);

		const out = await callVerify(req.id, pm, {
			covered: true, reason: "covers",
		});
		expect(out).toMatch(/APPROVED/);
		expect(out).toMatch(/not wired/i);
		expect(requirementStore.get(req.id)!.status).toBe("verify");
	});
});

// ─── discuss-by-id(契约 1.1 / §4.2)──────────────────────────────

describe("P7 — discuss-by-id(req.createdByAgentId 定位 PM session)", () => {
	test("openDiscussSession(requirementId) resolves the PM agent that created the requirement", () => {
		const { pm } = makeRequirement("Discuss me");
		const req = requirementStore.listByProject(PROJECT_ID)[0];
		const r = pm.openDiscussSession(req.id);
		expect(r.agentId).toBe(PM_AGENT_ID);
		expect(r.session.id).toBeTruthy();
	});

	test("two requirements from the same PM agent share the {PM, projectId} session", () => {
		const { pm } = makeRequirement("First discuss");
		// Second requirement from the same PM agent (cron re-scan same day).
		const req2 = pm.createRequirementWithDoc({
			projectId: PROJECT_ID, title: "Second discuss",
			source: "agent", createdByAgentId: PM_AGENT_ID,
		});
		const req1 = requirementStore.listByProject(PROJECT_ID).find((r) => r.title === "First discuss")!;
		const r1 = pm.openDiscussSession(req1.id);
		const r2 = pm.openDiscussSession(req2.id);
		expect(r1.session.id).toBe(r2.session.id);
	});

	test("openDiscussSession rejects when req has no createdByAgentId (P7 needs agentId)", () => {
		const { pm } = buildPm();
		const bare = requirementStore.create({
			projectId: PROJECT_ID, title: "Orphan", status: "discuss",
		} as any);
		expect(() => pm.openDiscussSession(bare.id)).toThrow(/createdByAgentId/i);
	});

	test("openDiscussSession rejects when the recorded PM agent has been deleted", () => {
		const { pm } = makeRequirement("Orphan PM");
		const req = requirementStore.listByProject(PROJECT_ID).find((r) => r.title === "Orphan PM")!;
		agentStore.delete(PM_AGENT_ID);
		expect(() => pm.openDiscussSession(req.id)).toThrow(/not found in agent store/i);
	});
});

// ─── 寻址契约:全 P7 路径无 roleTag 查找 ──────────────────────────

describe("P7 — 寻址全用 req agentId,无 roleTag scan", () => {
	test("verify path resolves reviewer via req.reviewerAgentId ?? req.createdByAgentId inside pmService (no roleTag, no tool delegation)", async () => {
		const { req, pm, merges } = makeRequirement("Address check");
		advanceToVerify(req.id);

		// The tool itself no longer resolves or delegates to a reviewer — it
		// forwards the caller's verdict. pmService.submitCoverageVerdict stamps
		// reviewerAgentId from the req record (default createdByAgentId). The
		// requirement has both reviewerAgentId + createdByAgentId = PM_AGENT_ID.
		await callVerify(req.id, pm, { covered: true, reason: "ok" });
		expect(requirementStore.get(req.id)!.reviewerAgentId).toBe(PM_AGENT_ID);
		expect(requirementStore.get(req.id)!.createdByAgentId).toBe(PM_AGENT_ID);
		expect(merges.length).toBe(1);
	});

	test("Flow.verify prefers explicit reviewerAgentId (reviewer ≠ creator PM)", async () => {
		// A different PM agent acts as reviewer for this requirement.
		const reviewerPm = agentStore.create({ name: "PM-Reviewer" } as any);
		const { pm } = buildPm();
		const req = pm.createRequirementWithDoc({
			projectId: PROJECT_ID, title: "Reviewer ≠ creator",
			source: "agent", createdByAgentId: PM_AGENT_ID,
		});
		// Stamp a different reviewer.
		requirementStore.update(req.id, { reviewerAgentId: reviewerPm.id } as any);
		advanceToVerify(req.id);

		// submitCoverageVerdict(opts.reviewerAgentId) overrides the default
		// resolution. The tool no longer picks a reviewer, so we exercise the
		// pmService override path directly.
		const outcome = await pm.submitCoverageVerdict(
			req.id, { covered: true }, { reviewerAgentId: reviewerPm.id },
		);
		expect(outcome.reviewerAgentId).toBe(reviewerPm.id);
		expect(requirementStore.get(req.id)!.reviewerAgentId).toBe(reviewerPm.id);
	});
});

// ─── 状态机回退(verify 不通过 → plan)────────────────────────────

describe("P7 — 状态机回退(verify → build → verify,lead revises)", () => {
	test("verify REJECTED → build → verify → APPROVED → closed (lead revises plan)", async () => {
		const { req, pm } = makeRequirement("Loop to close");
		advanceToVerify(req.id);

		// First verify: REJECTED. project-flow F3: Flow.verify reworks
		// verify→build itself; status is now "build" (old verify-tool left it
		// in "verify").
		await callVerify(req.id, pm, {
			covered: false, reason: "incomplete",
		});
		expect(requirementStore.get(req.id)!.status).toBe("build");

		// Lead revises: build → verify again (Flow.verify already did verify→build).
		requirementStore.transitionStatus(req.id, "verify", "system", "lead re-submits");

		// Second verify: APPROVED.
		const out = await callVerify(req.id, pm, {
			covered: true, reason: "complete now",
		});
		expect(out).toMatch(/APPROVED/);
		expect(requirementStore.get(req.id)!.status).toBe("closed");
	});
});

// ─── 拉模型契约:无 ProjectNotificationRouter / notify 推送 ───────

describe("P7 — 拉模型契约(无 router / notify 推送)", () => {
	test("PmService.submitCoverageVerdict drives archivist directly (no notify() call)", async () => {
		// If a router existed and was wired, this test would fail because the
		// archivist mock would be called twice (once via submitCoverageVerdict,
		// once via router.notify). The P7 contract: exactly one merge call,
		// driven by submitCoverageVerdict synchronously.
		const { req, pm, merges } = makeRequirement("No router");
		advanceToVerify(req.id);
		await callVerify(req.id, pm, {
			covered: true, reason: "covers",
		});
		expect(merges.length).toBe(1);
	});

	test("ProjectNotificationRouter module is deleted (import fails)", async () => {
		// The router module must not exist. Importing it should fail.
		let importFailed = false;
		try {
			await import("../../src/server/project-notification-router.js");
		} catch {
			importFailed = true;
		}
		expect(importFailed).toBe(true);
	});

	test("requirement-hooks no longer accepts projectNotificationRouter dep", async () => {
		// The P7 hook registration signature is { requirementStore, taskStepStore,
		// leadService, hookRegistry? }. projectNotificationRouter / analystService
		// / notificationService are gone.
		// Assert by introspecting the function source (cheap + load-bearing).
		const mod = await import("../../src/server/requirement-hooks.js");
		const fnText = (mod as any).registerRequirementHooks.toString();
		expect(fnText).not.toMatch(/projectNotificationRouter/);
		expect(fnText).not.toMatch(/analystService/);
	});
});
