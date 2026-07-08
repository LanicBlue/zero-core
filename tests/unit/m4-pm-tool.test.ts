// M4 unit tests: PM requirement-creation surface (project-flow F5 rewrite)
//
// # File spec
//
// ## Core
// Verifies the PM session's requirement-creation surface AFTER project-flow F3
// retired the old CreateRequirementWithDoc tool (file deleted in F5). The PM
// session now reaches the requirement flow via Flow.create (the single entry
// point); the legacy PM-specific behaviors that survive live on PmService
// (exercised here + in m4-pm-service.test.ts):
//   - PM can drive Flow.create from a project session (cron-triggered path).
//   - PmService still exposes createRequirementWithDoc / openDiscussSession /
//     submitCoverageVerdict (the server-layer primitives backing the Flow
//     compound verify + discuss routing).
//   - discoverAndCreateRequirement stays removed (PM is agent-driven, not
//     service-driven for discovery).
//
// ## project-flow F5
// The previous version of this file drove the now-deleted
// createRequirementWithDocTool (src/runtime/tools/requirement-tools.ts). The
// tool is gone; Flow.create is the replacement (writes the Intent section to
// docs/requirements/{id}.md; status='found'; docPath NOT stamped — consumers
// resolve via resolveExistingDocPath). Comprehensive Flow.create coverage
// lives in tests/unit/f1-flow-tool.test.ts; this file keeps a PM-session
// smoke + the PmService primitive surface check.
//
// ## Inputs
// Temporary SessionDB (mkdtempSync) + real stores.
//
// ## Output
// Vitest cases.
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { RequirementStore } from "../../src/server/requirement-store.js";
import { OrchestrateManifestStore } from "../../src/server/orchestrate-store.js";
import {
	RequirementDocStore,
} from "../../src/server/requirement-doc-store.js";
import { PmService } from "../../src/server/pm-service.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { WikiStore } from "../../src/server/wiki-node-store.js";
import { flowTool } from "../../src/tools/flow-tool.js";
import { getToolExecute, getToolFormat } from "../../src/tools/tool-factory.js";
import { createFlowActions } from "../../src/server/flow-actions.js";
import { emitTransition } from "../../src/server/data-change-hub.js";
// v0.8 P0 (§1.4 过渡期): roleTag 不再走 store round-trip;PM agent 物理列直接 seed。
import { seedAgentWithRoleTag } from "./helpers/p0-test-helpers.js";

const __execFlow = getToolExecute(flowTool)!;
const __fmtFlow = getToolFormat(flowTool)!;
// tool-decoupling sub-4:Flow now returns ToolResult JSON; wrap to format(JSON) so existing string assertions hold.
const execFlow = (i: any, c: any) => __execFlow(i, c).then(__fmtFlow);

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
	// v0.8 P0 (§1.4): seed role_tag physical column so PmService resolves PM.
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

/** Build the Flow tool context that a cron-triggered PM session would carry. */
function buildPmFlowCtx() {
	const flowActions = createFlowActions({
		requirementStore,
		resolveWorkspaceDir: () => workspaceDir,
		emitTransition,
	});
	return {
		workingDir: workspaceDir,
		agentId: PM_AGENT_ID,
		emit: () => {},
		requirementStore,
		flowActions,
		// projectId rides on the session context bundle (D-B) on cron-triggered
		// PM sessions.
		contextBundle: { projectId: PROJECT_ID, workspaceDir, wikiRootNodeId: `wiki-root:${PROJECT_ID}` },
	};
}

// ─── Flow.create from a PM session(project-flow F5 接管)────────

describe("Flow.create from a PM session (replaces CreateRequirementWithDoc)", () => {
	test("creates a status='found' RequirementRecord + writes the Intent doc", async () => {
		const out = await execFlow(
			{ action: "create", projectId: PROJECT_ID, title: "Add login page", description: "users need to sign in", priority: "high" } as any,
			buildPmFlowCtx(),
		);
		expect(out).toMatch(/Requirement created:/);

		const reqs = requirementStore.listByProject(PROJECT_ID);
		expect(reqs.length).toBe(1);
		const req = reqs[0];
		// Flow.create lands at status='found' (NOT 'discuss' — that was the old
		// PM-tool contract; project-flow §2 puts 'found' on create, 'discuss' on
		// pick). Comprehensive coverage in f1-flow-tool.test.ts.
		expect(req.title).toBe("Add login page");
		expect(req.status).toBe("found");
		expect(req.priority).toBe("high");

		// Flow.create writes the Intent section to docs/requirements/{id}.md
		// (a FILE, never the DB). The legacy .zero/requirements/ path is gone.
		const abs = join(workspaceDir, "docs", "requirements", `${req.id}.md`);
		const { existsSync, readFileSync } = require("node:fs");
		expect(existsSync(abs)).toBe(true);
		const body = readFileSync(abs, "utf-8");
		expect(body).toContain("# Add login page");
		expect(body).toContain("## Intent");
		expect(body).toContain("users need to sign in");
	});

	test("errors cleanly when flowActions / requirementStore are absent (non-project session)", async () => {
		// Flow forwards to ctx.flowActions (injected by agent-service). If a
		// caller invokes execute directly without flowActions, the tool returns
		// a clear error instead of crashing. (A real session always has
		// flowActions when Flow is in the active set — see capabilityHandlesFor
		// in agent-service. CONDITIONAL_TOOLS was removed 2026-07; gating is now
		// single-layer toolPolicy.)
		const out = await execFlow(
			{ action: "create", projectId: PROJECT_ID, title: "X" } as any,
			{ workingDir: workspaceDir, agentId: "other", emit: () => {} } as any,
		);
		expect(out).toMatch(/flowActions/i);
	});

	test("errors cleanly when projectId is missing (no context bundle, no ctx.projectId)", async () => {
		const flowActions = createFlowActions({
			requirementStore,
			resolveWorkspaceDir: () => workspaceDir,
			emitTransition,
		});
		const out = await execFlow(
			{ action: "create", title: "X" } as any,
			{
				workingDir: workspaceDir,
				agentId: PM_AGENT_ID,
				emit: () => {},
				requirementStore,
				flowActions,
			} as any,
		);
		expect(out).toMatch(/projectId/i);
	});
});

// ─── defect 2: discuss jump still carries the requirement doc path ────
//
// project-flow F5: the legacy `.zero/requirements/{projectId}/{id}.md`
// docPath the old tool stamped is gone; Flow consumers resolve the doc via
// resolveExistingDocPath (canonical docs/requirements/{id}.md then legacy
// fallback). The data handleDiscuss reads is now derived, not stamped — see
// f1-flow-tool.test.ts + f4-flow-actions.test.ts for the canonical-path
// coverage. This block intentionally left as a doc-pointer (no assertion):
// the contract it asserted (stamped docPath under .zero/requirements/) is
// intentionally retired.

describe("defect 2 — discuss doc resolution (pointer)", () => {
	test("Flow.create writes the canonical docs/requirements/{id}.md path (covered in f1-flow-tool)", async () => {
		// Smoke: the doc lands at the canonical path. Discuss-session doc
		// resolution is exercised end-to-end via the renderer + f4-flow-actions.
		await execFlow(
			{ action: "create", projectId: PROJECT_ID, title: "Discuss me", description: "needs PM discuss" } as any,
			buildPmFlowCtx(),
		);
		const req = requirementStore.listByProject(PROJECT_ID)[0];
		const abs = join(workspaceDir, "docs", "requirements", `${req.id}.md`);
		const { existsSync } = require("node:fs");
		expect(existsSync(abs)).toBe(true);
		// The project workspaceDir is what handleDiscuss would pass as root.
		expect(projectStore.get(PROJECT_ID)!.workspaceDir).toBe(workspaceDir);
	});
});

// ─── PmService primitive surface(still backs Flow.verify + discuss)──

describe("PmService primitive surface (used by Flow.verify + discuss routing)", () => {
	test("discoverAndCreateRequirement stays removed (PM is agent-driven)", () => {
		const pm = buildPm();
		expect(typeof (pm as any).discoverAndCreateRequirement).toBe("undefined");
	});
	// Keep the methods that ARE still used by Flow.verify / IPC / discuss.
	test("PmService still exposes the methods used by Flow.verify / IPC", () => {
		const pm = buildPm();
		expect(typeof pm.createRequirementWithDoc).toBe("function");
		expect(typeof pm.openDiscussSession).toBe("function");
		expect(typeof pm.submitCoverageVerdict).toBe("function");
		expect(typeof pm.buildCoverageView).toBe("function");
		expect(typeof pm.readProjectWikiSummary).toBe("function");
	});
});
