// M4 单元测试:PM 产品管线 + discuss 文档为中心 + 覆盖判断
//
// # 文件说明书
//
// ## 核心功能
// 验证 M4 核心交付 (acceptance-M4.md):
//   - RequirementDocStore:需求文档落 repo ({workspace}/.zero/requirements/{pid}/),
//     跨设备可恢复;buildNewRequirementDoc 幂等(不覆盖已有)
//   - PmService.createRequirementWithDoc:RequirementRecord + repo doc + 默认
//     reviewerAgentId = createdByAgentId(决策 34);幂等(同 title 不重建)
//   - PmService.openDiscussSession:{PM, projectId} → session 路由,跨调用复用
//     同一 session(决策 13/14)
//   - PmService.submitCoverageVerdict:covered=true → notify(verify_accept);
//     covered=false → notify(verify_reject);stamp reviewerAgentId(决策 34)
//   - RequirementRecord 新字段(docPath / createdByAgentId / assignedAgentId /
//     reviewerAgentId)落库 + 读取往返
//   - PM cron 只建新需求、不改已有(决策 7)——buildNewRequirementDoc 幂等性
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
	// column so PmService.findPmAgent (listByRoleTag('pm')) resolves it.
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
	projectNotificationRouter?: any;
}): PmService {
	return new PmService({
		agentService: overrides?.agentService ?? { sendPrompt: async () => {} } as any,
		agentStore,
		projectStore,
		requirementStore,
		requirementDocStore: docStore,
		wikiNodeStore: wikiStore,
		manifestStore,
		projectNotificationRouter: overrides?.projectNotificationRouter,
		sessionDB,
	});
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
		const req = pm.createRequirementWithDoc({ projectId: PROJECT_ID, title: "Add login" });
		expect(req.status).toBe("discuss");
		expect(req.docPath).toBe(`.zero/requirements/${PROJECT_ID}/${req.id}.md`);
		expect(existsSync(join(workspaceDir, req.docPath!))).toBe(true);
	});

	test("reviewerAgentId defaults to createdByAgentId (decision 34 — coverage party)", () => {
		const pm = buildPm();
		const req = pm.createRequirementWithDoc({ projectId: PROJECT_ID, title: "X" });
		expect(req.createdByAgentId).toBe(PM_AGENT_ID);
		expect(req.reviewerAgentId).toBe(PM_AGENT_ID);
	});

	test("idempotent — same title in same project returns existing, no new doc", () => {
		const pm = buildPm();
		const a = pm.createRequirementWithDoc({ projectId: PROJECT_ID, title: "Dup" });
		const b = pm.createRequirementWithDoc({ projectId: PROJECT_ID, title: "Dup" });
		expect(b.id).toBe(a.id);
		expect(requirementStore.listByProject(PROJECT_ID).length).toBe(1);
	});

	test("new fields persist + round-trip through the store", () => {
		const pm = buildPm();
		const created = pm.createRequirementWithDoc({ projectId: PROJECT_ID, title: "RT" });
		const reloaded = requirementStore.get(created.id)!;
		expect(reloaded.docPath).toBe(created.docPath);
		expect(reloaded.createdByAgentId).toBe(PM_AGENT_ID);
		expect(reloaded.reviewerAgentId).toBe(PM_AGENT_ID);
		expect(reloaded.assignedAgentId ?? undefined).toBeUndefined();
	});
});

// ─── PmService — discuss session routing ──────────────────────

describe("PmService.openDiscussSession (decision 13/14 — {PM, projectId} session)", () => {
	test("finds or creates a session keyed by (PM agent, projectId)", () => {
		const pm = buildPm();
		const r1 = pm.openDiscussSession(PROJECT_ID);
		expect(r1.created).toBe(true);
		// Second call reuses the same session (cross-cron, cross-date).
		const r2 = pm.openDiscussSession(PROJECT_ID);
		expect(r2.created).toBe(false);
		expect(r2.session.id).toBe(r1.session.id);
	});

	test("throws when no PM agent is registered", () => {
		// Remove the PM agent.
		agentStore.delete(PM_AGENT_ID);
		const pm = buildPm();
		expect(() => pm.openDiscussSession(PROJECT_ID)).toThrow(/no pm agent/i);
	});
});

// ─── PmService — coverage verdict wiring ──────────────────────

describe("PmService.submitCoverageVerdict (decision 34 — verdict → notification)", () => {
	test("covered=true fires notify('verify_accept')", async () => {
		const calls: Array<{ kind: string; reqId: string; reason?: string }> = [];
		const pm = buildPm({
			projectNotificationRouter: {
				notify: async (kind: string, reqId: string, _pid: string, extra?: { reason?: string }) => {
					calls.push({ kind, reqId, reason: extra?.reason });
				},
			},
		});
		const req = pm.createRequirementWithDoc({ projectId: PROJECT_ID, title: "Cover me" });
		await pm.submitCoverageVerdict(req.id, { covered: true, reason: "all good" });
		expect(calls).toEqual([{ kind: "verify_accept", reqId: req.id, reason: "all good" }]);
	});

	test("covered=false fires notify('verify_reject')", async () => {
		const calls: Array<{ kind: string; reqId: string }> = [];
		const pm = buildPm({
			projectNotificationRouter: {
				notify: async (kind: string, reqId: string) => { calls.push({ kind, reqId }); },
			},
		});
		const req = pm.createRequirementWithDoc({ projectId: PROJECT_ID, title: "Gap" });
		await pm.submitCoverageVerdict(req.id, { covered: false, reason: "missing tests" });
		expect(calls[0].kind).toBe("verify_reject");
	});

	test("records a status_change message (audit trail)", async () => {
		const pm = buildPm({
			projectNotificationRouter: { notify: async () => {} },
		});
		const req = pm.createRequirementWithDoc({ projectId: PROJECT_ID, title: "Audit" });
		await pm.submitCoverageVerdict(req.id, { covered: false, reason: "x" });
		const msgs = requirementStore.getMessages(req.id);
		const verdict = msgs.find((m) => m.content.includes("PM coverage verdict"));
		expect(verdict).toBeDefined();
		expect(verdict!.content).toContain("NOT_COVERED");
	});

	test("does not introduce productionReady multi-gate aggregation (single verdict only)", async () => {
		let notifyCount = 0;
		const pm = buildPm({
			projectNotificationRouter: { notify: async () => { notifyCount++; } },
		});
		const req = pm.createRequirementWithDoc({ projectId: PROJECT_ID, title: "Gate" });
		await pm.submitCoverageVerdict(req.id, { covered: true });
		expect(notifyCount).toBe(1); // exactly one notification — no multi-gate fan-out
	});
});

// ─── Coverage evidence view ───────────────────────────────────

describe("PmService.buildCoverageView (decision 34 — product-level coverage)", () => {
	test("returns intent doc + latest manifest", () => {
		const pm = buildPm();
		const req = pm.createRequirementWithDoc({ projectId: PROJECT_ID, title: "View", body: "# Intent\n..." });
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
		const req = pm.createRequirementWithDoc({ projectId: PROJECT_ID, title: "Iso", body: "FIRST" });
		// Simulate PM discuss having edited the doc.
		docStore.updateRequirementDoc(PROJECT_ID, req.id, "EDITED_BY_DISCUSS");
		// Cron re-scan tries to create again — must be a no-op.
		const again = pm.createRequirementWithDoc({ projectId: PROJECT_ID, title: "Iso", body: "CRON_ATTEMPT" });
		expect(again.id).toBe(req.id);
		expect(docStore.readRequirementDoc(PROJECT_ID, req.id)).toBe("EDITED_BY_DISCUSS");
	});
});
