// M4 单元测试:PM 产品管线 + discuss 文档为中心 + 覆盖判断
//
// # 文件说明书
//
// ## 核心功能
// 验证 M4 核心交付 (acceptance-M4.md),并适配 v0.8 P7 拉模型语义:
//   - RequirementDocStore:需求文档落 repo ({workspace}/.zero/requirements/{pid}/),
//     跨设备可恢复;buildNewRequirementDoc 幂等(不覆盖已有)
//   - PmService.createRequirementWithDoc:RequirementRecord + repo doc + 默认
//     reviewerAgentId = createdByAgentId(决策 34);幂等(同 title 不重建)
//   - PmService.openDiscussSession(requirementId):按 req.createdByAgentId 路由
//     {PM, projectId} session(v0.8 P7 — 删 findPmAgent roleTag 查找)
//   - PmService.submitCoverageVerdict:covered=true → archivistService.mergeFeatureToMain
//     + 增量扫描 + 状态 → closed(=archived,§4.6);covered=false → 意见写回
//     requirement.addMessage;stamp reviewerAgentId(决策 34)
//   - RequirementRecord 新字段(docPath / createdByAgentId / assignedAgentId /
//     reviewerAgentId)落库 + 读取往返
//   - PM cron 只建新需求、不改已有(决策 7)——buildNewRequirementDoc 幂等性
//
// ## v0.8 P7 适配
// - 删 projectNotificationRouter mock —— 改为 archivistService mock。
// - openDiscussSession 入参从 projectId 改为 requirementId。
// - submitCoverageVerdict 断言:covered=true 触发 archivistService.mergeFeatureToMain +
//   状态 → closed;covered=false 写 status_change 消息,状态留 verify。
// - createRequirementWithDoc 显式传 createdByAgentId(测试自构造 PM agent,
//   生产链路里是 tool 从 ctx.agentId 透传过来)。
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { RequirementStore } from "../../src/server/requirement-store.js";
import { OrchestrateManifestStore } from "../../src/server/orchestrate-store.js";
import {
	RequirementDocStore,
	requirementDocAbsPath,
	requirementDocRelPath,
} from "../../src/server/requirement-doc-store.js";
import { PmService } from "../../src/server/pm-service.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { WikiStore } from "../../src/server/wiki-node-store.js";
// v0.8 P0 (§1.4 过渡期): roleTag 不再走 store round-trip;PM agent 物理列直接 seed。
import { seedAgentWithRoleTag } from "./helpers/p0-test-helpers.js";

let tmpDir: string;
let workspaceDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let requirementStore: RequirementStore;
let manifestStore: OrchestrateManifestStore;
let wikiStore: WikiStore;
let docStore: RequirementDocStore;

let PROJECT_ID = "proj-test";
let PM_AGENT_ID = "pm-agent-1";

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-m4-"));
	workspaceDir = join(tmpDir, "ws");
	mkdirSync(workspaceDir, { recursive: true });

	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	requirementStore = new RequirementStore(sessionDB);
	manifestStore = new OrchestrateManifestStore(sessionDB);
	wikiStore = new WikiStore(sessionDB);

	// ProjectStore.create auto-mints the id; capture it for downstream use.
	const project = projectStore.create({ name: "Test", workspaceDir } as any);
	PROJECT_ID = project.id;

	// Register the global PM agent (roleTag=pm). AgentStore.create auto-mints
	// the id; capture it for downstream assertions.
	// v0.8 P0 (§1.4): roleTag removed from AgentRecord; seed the physical
	// column so listByRoleTag('pm') resolves it (legacy diagnostics path).
	// v0.8 P7: workflow path no longer reads roleTag — PmService.openDiscussSession
	// routes by req.createdByAgentId. We still keep the physical column for any
	// diagnostics / legacy callers.
	const pmAgent = agentStore.create({
		name: "PM",
		systemPrompt: "pm",
		toolPolicy: { tools: {} },
	} as any);
	seedAgentWithRoleTag(sessionDB, pmAgent.id, "pm");
	PM_AGENT_ID = pmAgent.id;

	docStore = new RequirementDocStore({
		getWorkspaceDir: (pid) => projectStore.get(pid)?.workspaceDir,
	});
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function buildPm(overrides?: {
	agentService?: any;
	archivistService?: any;
}): PmService {
	return new PmService({
		agentService: overrides?.agentService ?? { sendPrompt: async () => {} } as any,
		agentStore,
		projectStore,
		requirementStore,
		requirementDocStore: docStore,
		wikiNodeStore: wikiStore,
		manifestStore,
		archivistService: overrides?.archivistService,
		sessionDB,
	});
}

/** Create a requirement with the canonical createdByAgentId (P7 — PM agent that
 * created it). Mirrors what the CreateRequirementWithDoc tool does in prod
 * (passes ctx.agentId → createdByAgentId). */
function makeReq(pm: PmService, title: string, opts?: { body?: string; summary?: string; priority?: any }) {
	return pm.createRequirementWithDoc({
		projectId: PROJECT_ID,
		title,
		summary: opts?.summary,
		body: opts?.body,
		priority: opts?.priority,
		source: "agent",
		createdByAgentId: PM_AGENT_ID,
	});
}

/**
 * Push a freshly-created requirement through the state machine to 'verify',
 * mirroring the real flow (lead picks up → builds → submits verify). Used in
 * submitCoverageVerdict tests so the verdict lands in a realistic state.
 */
function advanceToVerify(reqId: string): void {
	requirementStore.transitionStatus(reqId, "ready", "user", "discuss → ready (test setup)");
	requirementStore.transitionStatus(reqId, "plan", "agent", "ready → plan (test setup)");
	requirementStore.transitionStatus(reqId, "build", "agent", "plan → build (test setup)");
	requirementStore.transitionStatus(reqId, "verify", "system", "build → verify (test setup)");
}

// ─── RequirementDocStore ──────────────────────────────────────

describe("RequirementDocStore (decision 12 — repo doc, cross-device)", () => {
	test("buildNewRequirementDoc writes to {workspace}/.zero/requirements/{pid}/{rid}.md", () => {
		const rel = docStore.buildNewRequirementDoc(PROJECT_ID, "req-abc", "# title\nbody");
		expect(rel).toBe(`.zero/requirements/${PROJECT_ID}/req-abc.md`);
		const abs = requirementDocAbsPath(workspaceDir, PROJECT_ID, "req-abc");
		expect(existsSync(abs)).toBe(true);
		expect(readFileSync(abs, "utf-8")).toContain("# title");
	});

	test("buildNewRequirementDoc is idempotent — does NOT overwrite existing (decision 7)", () => {
		docStore.buildNewRequirementDoc(PROJECT_ID, "req-1", "ORIGINAL");
		// Second call must not overwrite.
		docStore.buildNewRequirementDoc(PROJECT_ID, "req-1", "CHANGED");
		const content = docStore.readRequirementDoc(PROJECT_ID, "req-1");
		expect(content).toBe("ORIGINAL");
	});

	test("updateRequirementDoc overwrites (PM discuss / user edits)", () => {
		docStore.buildNewRequirementDoc(PROJECT_ID, "req-1", "v1");
		docStore.updateRequirementDoc(PROJECT_ID, "req-1", "v2");
		expect(docStore.readRequirementDoc(PROJECT_ID, "req-1")).toBe("v2");
	});

	test("read returns undefined when missing", () => {
		expect(docStore.readRequirementDoc(PROJECT_ID, "nope")).toBeUndefined();
	});

	test("listRequirementDocs lists all docs in a project", () => {
		docStore.buildNewRequirementDoc(PROJECT_ID, "req-a", "a");
		docStore.buildNewRequirementDoc(PROJECT_ID, "req-b", "b");
		const list = docStore.listRequirementDocs(PROJECT_ID);
		expect(list.length).toBe(2);
		expect(list.every((p) => p.startsWith(`.zero/requirements/${PROJECT_ID}/`))).toBe(true);
	});

	test("path helpers are OS-independent (forward slashes)", () => {
		expect(requirementDocRelPath("p1", "r1")).toBe(".zero/requirements/p1/r1.md");
		expect(requirementDocAbsPath(workspaceDir, "p1", "r1")).toContain("requirements");
	});
});

// ─── PmService — createRequirementWithDoc ─────────────────────

describe("PmService.createRequirementWithDoc (decision 12/14/34)", () => {
	test("creates RequirementRecord + repo doc; status starts at 'discuss'", () => {
		const pm = buildPm();
		const req = makeReq(pm, "Add login");
		expect(req.status).toBe("discuss");
		expect(req.docPath).toBe(`.zero/requirements/${PROJECT_ID}/${req.id}.md`);
		expect(existsSync(join(workspaceDir, req.docPath!))).toBe(true);
	});

	test("reviewerAgentId defaults to createdByAgentId (decision 34 — coverage party)", () => {
		const pm = buildPm();
		const req = makeReq(pm, "X");
		expect(req.createdByAgentId).toBe(PM_AGENT_ID);
		expect(req.reviewerAgentId).toBe(PM_AGENT_ID);
	});

	test("idempotent — same title in same project returns existing, no new doc", () => {
		const pm = buildPm();
		const a = makeReq(pm, "Dup");
		const b = makeReq(pm, "Dup");
		expect(b.id).toBe(a.id);
		expect(requirementStore.listByProject(PROJECT_ID).length).toBe(1);
	});

	test("new fields persist + round-trip through the store", () => {
		const pm = buildPm();
		const created = makeReq(pm, "RT");
		const reloaded = requirementStore.get(created.id)!;
		expect(reloaded.docPath).toBe(created.docPath);
		expect(reloaded.createdByAgentId).toBe(PM_AGENT_ID);
		expect(reloaded.reviewerAgentId).toBe(PM_AGENT_ID);
		expect(reloaded.assignedAgentId ?? undefined).toBeUndefined();
	});
});

// ─── PmService — discuss session routing ──────────────────────

describe("PmService.openDiscussSession (v0.8 P7 — route by req.createdByAgentId)", () => {
	test("finds or creates a session keyed by (PM agent, projectId)", () => {
		const pm = buildPm();
		const req1 = makeReq(pm, "Discuss A");
		const r1 = pm.openDiscussSession(req1.id);
		expect(r1.created).toBe(true);
		expect(r1.agentId).toBe(PM_AGENT_ID);
		// Second call with the same requirement reuses the same session.
		const r2 = pm.openDiscussSession(req1.id);
		expect(r2.created).toBe(false);
		expect(r2.session.id).toBe(r1.session.id);
	});

	test("two requirements from the same PM agent share the {PM, projectId} session", () => {
		const pm = buildPm();
		const req1 = makeReq(pm, "One");
		const req2 = makeReq(pm, "Two");
		// Both were created by the same PM agent → same {PM, projectId} session.
		const r1 = pm.openDiscussSession(req1.id);
		const r2 = pm.openDiscussSession(req2.id);
		expect(r2.session.id).toBe(r1.session.id);
	});

	test("throws when the requirement has no createdByAgentId (P7 needs req-recorded agentId)", () => {
		const pm = buildPm();
		// Build a requirement directly via the store, no createdByAgentId.
		const bare = requirementStore.create({
			projectId: PROJECT_ID,
			title: "Bare",
			status: "discuss",
		} as any);
		expect(() => pm.openDiscussSession(bare.id)).toThrow(/createdByAgentId/i);
	});

	test("throws when the recorded PM agent has been deleted", () => {
		const pm = buildPm();
		const req = makeReq(pm, "Orphan");
		agentStore.delete(PM_AGENT_ID);
		expect(() => pm.openDiscussSession(req.id)).toThrow(/not found in agent store/i);
	});
});

// ─── PmService — coverage verdict wiring (v0.8 P7 — archivist merge) ─

describe("PmService.submitCoverageVerdict (v0.8 P7 — verdict drives archivist merge)", () => {
	test("covered=true calls archivistService.mergeFeatureToMain + transitions to 'closed' (=archived)", async () => {
		const merges: Array<{ projectId: string; requirementId: string }> = [];
		const pm = buildPm({
			archivistService: {
				mergeFeatureToMain: async (projectId: string, requirementId: string) => {
					merges.push({ projectId, requirementId });
					return { ok: true, ref: "main-abc123" };
				},
			},
		});
		const req = makeReq(pm, "Cover me");
		// Push the requirement through the state machine to 'verify' (mirrors the
		// real flow: ready → plan → build → verify, last hop via the verify tool).
		advanceToVerify(req.id);
		const outcome = await pm.submitCoverageVerdict(req.id, { covered: true, reason: "all good" });
		expect(merges).toEqual([{ projectId: PROJECT_ID, requirementId: req.id }]);
		expect(outcome.covered).toBe(true);
		expect(outcome.merge?.ok).toBe(true);
		expect(outcome.merge?.ref).toBe("main-abc123");
		expect(outcome.finalStatus).toBe("closed");
		// Persisted status reflects the close.
		expect(requirementStore.get(req.id)!.status).toBe("closed");
	});

	test("covered=true with merge failure leaves status in 'verify' (cron fallback will retry)", async () => {
		const pm = buildPm({
			archivistService: {
				mergeFeatureToMain: async () => { throw new Error("git conflict"); },
			},
		});
		const req = makeReq(pm, "Conflicted");
		advanceToVerify(req.id);
		const outcome = await pm.submitCoverageVerdict(req.id, { covered: true });
		expect(outcome.merge?.ok).toBe(false);
		expect(outcome.merge?.error).toMatch(/git conflict/i);
		expect(outcome.finalStatus).toBe("verify");
		expect(requirementStore.get(req.id)!.status).toBe("verify");
	});

	test("covered=true without archivistService wired leaves status in 'verify'", async () => {
		const pm = buildPm(); // no archivistService
		const req = makeReq(pm, "No archivist");
		advanceToVerify(req.id);
		const outcome = await pm.submitCoverageVerdict(req.id, { covered: true });
		expect(outcome.merge?.ok).toBe(false);
		expect(outcome.finalStatus).toBe("verify");
	});

	test("covered=false writes a status_change message + leaves status in 'verify'", async () => {
		const pm = buildPm({
			archivistService: { mergeFeatureToMain: async () => ({ ok: true }) },
		});
		const req = makeReq(pm, "Gap");
		advanceToVerify(req.id);
		const outcome = await pm.submitCoverageVerdict(req.id, { covered: false, reason: "missing tests" });
		expect(outcome.covered).toBe(false);
		expect(outcome.finalStatus).toBe("verify");
		expect(requirementStore.get(req.id)!.status).toBe("verify");
		const msgs = requirementStore.getMessages(req.id);
		const verdict = msgs.find((m) => m.content.includes("PM coverage verdict"));
		expect(verdict).toBeDefined();
		expect(verdict!.content).toContain("NOT_COVERED");
		expect(verdict!.content).toContain("missing tests");
	});

	test("records a status_change message on every verdict (audit trail)", async () => {
		const pm = buildPm({
			archivistService: { mergeFeatureToMain: async () => ({ ok: true, ref: "r" }) },
		});
		const req = makeReq(pm, "Audit");
		advanceToVerify(req.id);
		await pm.submitCoverageVerdict(req.id, { covered: true, reason: "ok" });
		const msgs = requirementStore.getMessages(req.id);
		const verdict = msgs.find((m) => m.content.includes("PM coverage verdict"));
		expect(verdict).toBeDefined();
		expect(verdict!.content).toContain("COVERED");
	});

	test("does not introduce productionReady multi-gate aggregation (single verdict → single merge)", async () => {
		let mergeCount = 0;
		const pm = buildPm({
			archivistService: {
				mergeFeatureToMain: async () => { mergeCount++; return { ok: true, ref: "r" }; },
			},
		});
		const req = makeReq(pm, "Gate");
		advanceToVerify(req.id);
		await pm.submitCoverageVerdict(req.id, { covered: true });
		expect(mergeCount).toBe(1); // exactly one merge — no multi-gate fan-out
	});

	test("stamps reviewerAgentId from opts, overriding the default (decision 34)", async () => {
		const otherReviewer = "reviewer-other";
		const pm = buildPm({
			archivistService: { mergeFeatureToMain: async () => ({ ok: true, ref: "r" }) },
		});
		const req = makeReq(pm, "Review stamp");
		advanceToVerify(req.id);
		const outcome = await pm.submitCoverageVerdict(
			req.id, { covered: true }, { reviewerAgentId: otherReviewer },
		);
		expect(outcome.reviewerAgentId).toBe(otherReviewer);
		expect(requirementStore.get(req.id)!.reviewerAgentId).toBe(otherReviewer);
	});
});

// ─── Coverage evidence view ───────────────────────────────────

describe("PmService.buildCoverageView (decision 34 — product-level coverage)", () => {
	test("returns intent doc + latest manifest", () => {
		const pm = buildPm();
		const req = makeReq(pm, "View", { body: "# Intent\n..." });
		// Seed a manifest for this requirement.
		manifestStore.create({
			requirementId: req.id,
			planId: "plan-1",
			projectId: PROJECT_ID,
			touchedFiles: ["src/a.ts"],
			tests: [{ name: "t1", ok: true }],
			review: { verdict: "approved" },
			summary: "summary",
		} as any);

		const view = pm.buildCoverageView(req.id);
		expect(view.requirement?.id).toBe(req.id);
		expect(view.intentDoc).toContain("# Intent");
		expect(view.manifest?.touchedFiles).toEqual(["src/a.ts"]);
		expect(view.manifest?.review?.verdict).toBe("approved");
	});
});

// ─── PM discovery is agent-driven (no service method) ─────────
//
// v0.8 (M4 design): PM discovery is fully agent-driven — the cron only sends
// a prompt that wakes the PM session, and PM uses the CreateRequirementWithDoc
// tool (which routes through createRequirementWithDoc) to create requirements.
// There is no PmService.discoverAndCreateRequirement service method; the
// end-to-end PM-tool-creates-requirement behavior is covered in
// m4-pm-tool.test.ts.

// ─── PM cron write isolation (decision 7) ─────────────────────

describe("PM write isolation (decision 7 — cron only creates, never modifies)", () => {
	test("PM re-creating the same requirement does not touch the existing doc", () => {
		const pm = buildPm();
		const req = makeReq(pm, "Iso", { body: "FIRST" });
		// Simulate PM discuss having edited the doc.
		docStore.updateRequirementDoc(PROJECT_ID, req.id, "EDITED_BY_DISCUSS");
		// Cron re-scan tries to create again — must be a no-op.
		const again = makeReq(pm, "Iso", { body: "CRON_ATTEMPT" });
		expect(again.id).toBe(req.id);
		expect(docStore.readRequirementDoc(PROJECT_ID, req.id)).toBe("EDITED_BY_DISCUSS");
	});
});
