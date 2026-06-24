// M4 单元测试: PM CreateRequirementWithDoc 工具 + discuss 跳转携带需求文档
//
// # 文件说明书
//
// ## 核心功能
// 验证 M4 缺陷 1 / 缺陷 2 修复 (用户澄清的设计意图),并适配 v0.8 P7
// 拉模型(tool 入参 / 寻址用 createdByAgentId):
//
//   缺陷 1 — PM 用工具创建需求 + 绑定需求文档 + 落 discuss 栏:
//   - CreateRequirementWithDoc 工具调用 PmService.createRequirementWithDoc
//   - 产出 status='discuss' 的 RequirementRecord + repo 文档 + docPath 绑定
//   - 工具走 ctx.pmService + ctx.contextBundle.projectId (cron 激活路径)
//   - role-presets PM preset 把 CreateRequirementWithDoc 放进 toolPolicy.tools
//
//   缺陷 2 — discuss 跳转携带需求文档 (纯函数/约定层断言):
//   - handleDiscuss 在切到 chat 页 + 打开 session 后, 还需 dispatch
//     zero-file-select { path: req.docPath, root: workspaceDir }
//   - 此处通过 docPath 字段存在 + 路径形态断言 (UI 集成由人检/E2E 覆盖)
//
//   死代码清理:
//   - PmService.discoverAndCreateRequirement 已删除 (发现由 PM agent 驱动)
//
//   v0.8 P7:
//   - openDiscuss 入参从 (projectId) 改为 (requirementId)(走 req.createdByAgentId)。
//   - Tool 调用必须把 ctx.agentId 透传到 createRequirementWithDoc 的
//     createdByAgentId —— 否则 verify/discuss 在 P7 寻址不到 PM agent
//     (TODO sub1: requirement-tools.ts createRequirementWithDocTool 当前
//     未透传 createdByAgentId=ctx.agentId;P7 端到端闭环硬依赖,需补一行)。
//     在补齐前,本文件对 tool 路径断言"记录创建 + docPath + status",对
//     createdByAgentId 的断言走 pmService 直调路径 (绕过 tool)。
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
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
} from "../../src/server/requirement-doc-store.js";
import { PmService } from "../../src/server/pm-service.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { WikiStore } from "../../src/server/wiki-node-store.js";
import { createRequirementWithDocTool } from "../../src/runtime/tools/requirement-tools.js";
import { getToolExecute } from "../../src/runtime/tools/tool-factory.js";
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
	tmpDir = mkdtempSync(join(tmpdir(), "zero-m4-tool-"));
	workspaceDir = join(tmpDir, "ws");
	mkdirSync(workspaceDir, { recursive: true });

	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	requirementStore = new RequirementStore(sessionDB);
	manifestStore = new OrchestrateManifestStore(sessionDB);
	wikiStore = new WikiStore(sessionDB);

	const project = projectStore.create({ name: "Test", workspaceDir } as any);
	PROJECT_ID = project.id;

	const pmAgent = agentStore.create({
		name: "PM",
		systemPrompt: "pm",
		toolPolicy: { tools: {} },
	} as any);
	// v0.8 P0 (§1.4): seed role_tag physical column so PmService.findPmAgent resolves.
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

function buildPm(): PmService {
	return new PmService({
		agentService: { sendPrompt: async () => {} } as any,
		agentStore,
		projectStore,
		requirementStore,
		requirementDocStore: docStore,
		wikiNodeStore: wikiStore,
		manifestStore,
		sessionDB,
	});
}

/** Build the tool context that the cron-triggered PM session would carry. */
function buildPmToolContext(pm: PmService) {
	return {
		workingDir: workspaceDir,
		agentId: PM_AGENT_ID,
		emit: () => {},
		pmService: pm,
		// projectId rides on the session context bundle (D-B) on cron-triggered
		// PM sessions; legacy ctx.projectId is the fallback.
		contextBundle: { projectId: PROJECT_ID, workspaceDir, wikiRootNodeId: `wiki-root:${PROJECT_ID}` },
	};
}

// ─── CreateRequirementWithDoc tool ────────────────────────────

describe("CreateRequirementWithDoc tool (defect 1 — PM creates requirement + doc + discuss)", () => {
	test("creates RequirementRecord at status='discuss' + repo doc + docPath binding", async () => {
		const pm = buildPm();
		const execute = getToolExecute(createRequirementWithDocTool)!;
		const out = await execute(
			{ title: "Add login page", summary: "users need to sign in", priority: "normal" },
			buildPmToolContext(pm),
		);
		expect(out).toMatch(/Requirement created:/);

		const reqs = requirementStore.listByProject(PROJECT_ID);
		expect(reqs.length).toBe(1);
		const req = reqs[0];
		expect(req.title).toBe("Add login page");
		expect(req.status).toBe("discuss");
		expect(req.docPath).toBe(`.zero/requirements/${PROJECT_ID}/${req.id}.md`);
		expect(req.createdByAgentId).toBe(PM_AGENT_ID);
		// docPath resolves to a real file in the workspace.
		expect(existsSync(join(workspaceDir, req.docPath!))).toBe(true);
	});

	test("doc content carries the title + summary (intent seeded)", async () => {
		const pm = buildPm();
		const execute = getToolExecute(createRequirementWithDocTool)!;
		await execute(
			{ title: "Hardening", summary: "tighten input validation", priority: "high" },
			buildPmToolContext(pm),
		);
		const req = requirementStore.listByProject(PROJECT_ID)[0];
		const abs = requirementDocAbsPath(workspaceDir, PROJECT_ID, req.id);
		const body = require("node:fs").readFileSync(abs, "utf-8");
		expect(body).toContain("# Hardening");
		expect(body).toContain("tighten input validation");
	});

	test("idempotent — same title returns existing record, no new doc", async () => {
		const pm = buildPm();
		const execute = getToolExecute(createRequirementWithDocTool)!;
		await execute({ title: "Dup", priority: "normal" }, buildPmToolContext(pm));
		await execute({ title: "Dup", priority: "normal" }, buildPmToolContext(pm));
		expect(requirementStore.listByProject(PROJECT_ID).length).toBe(1);
	});

	test("errors cleanly when pmService missing (non-PM session)", async () => {
		const execute = getToolExecute(createRequirementWithDocTool)!;
		const out = await execute(
			{ title: "X", priority: "normal" },
			{ workingDir: workspaceDir, agentId: "other", emit: () => {} } as any,
		);
		expect(out).toMatch(/PM service not available/i);
	});

	test("errors cleanly when projectId missing (non-project session)", async () => {
		const pm = buildPm();
		const execute = getToolExecute(createRequirementWithDocTool)!;
		const out = await execute(
			{ title: "X", priority: "normal" },
			// No contextBundle.projectId, no ctx.projectId.
			{ workingDir: workspaceDir, agentId: PM_AGENT_ID, emit: () => {}, pmService: pm } as any,
		);
		expect(out).toMatch(/projectId not available/i);
	});

	test("accepts ctx.projectId fallback when contextBundle has none", async () => {
		const pm = buildPm();
		const execute = getToolExecute(createRequirementWithDocTool)!;
		const out = await execute(
			{ title: "Legacy ctx", priority: "normal" },
			{
				workingDir: workspaceDir,
				agentId: PM_AGENT_ID,
				emit: () => {},
				pmService: pm,
				projectId: PROJECT_ID,
			} as any,
		);
		expect(out).toMatch(/Requirement created:/);
		expect(requirementStore.listByProject(PROJECT_ID).length).toBe(1);
	});
});

// ─── defect 2: discuss jump carries the requirement doc ──────

describe("defect 2 — discuss jump opens the requirement doc", () => {
	test("a requirement created via the PM tool carries a docPath that resolves under the workspace", async () => {
		// This is the data contract handleDiscuss relies on: it dispatches
		// `zero-file-select` with { path: req.docPath, root: workspaceDir }.
		// Asserting the docPath shape + on-disk presence here covers the
		// backend half; the UI dispatch is exercised via the renderer.
		const pm = buildPm();
		const execute = getToolExecute(createRequirementWithDocTool)!;
		await execute(
			{ title: "Discuss me", summary: "needs PM discuss", priority: "normal" },
			buildPmToolContext(pm),
		);
		const req = requirementStore.listByProject(PROJECT_ID)[0];
		expect(req.docPath).toBeTruthy();
		expect(req.docPath!.startsWith(`.zero/requirements/${PROJECT_ID}/`)).toBe(true);
		expect(existsSync(join(workspaceDir, req.docPath!))).toBe(true);
		// The root that handleDiscuss would pass = project.workspaceDir.
		expect(projectStore.get(PROJECT_ID)!.workspaceDir).toBe(workspaceDir);
	});
});

// ─── dead-code cleanup ────────────────────────────────────────

describe("dead-code cleanup — discoverAndCreateRequirement removed", () => {
	test("PmService no longer exposes discoverAndCreateRequirement", () => {
		const pm = buildPm();
		expect(typeof (pm as any).discoverAndCreateRequirement).toBe("undefined");
	});
	// Keep the methods that ARE still used by tools / IPC.
	test("PmService still exposes the methods used by tools / IPC", () => {
		const pm = buildPm();
		expect(typeof pm.createRequirementWithDoc).toBe("function");
		expect(typeof pm.openDiscussSession).toBe("function");
		expect(typeof pm.submitCoverageVerdict).toBe("function");
		expect(typeof pm.buildCoverageView).toBe("function");
		expect(typeof pm.readProjectWikiSummary).toBe("function");
	});
});
