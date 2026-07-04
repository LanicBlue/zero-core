// F1 unit tests: Flow action tool (create/list/get) — project-flow cornerstone
//
// # File spec
//
// ## Core
// Verifies acceptance-F1.md:
//   - create builds a status='found' RequirementRecord + writes the Intent
//     section to {workspace}/docs/requirements/{id}.md (file, not DB).
//   - list returns the project's requirements and honours status/priority filters.
//   - get returns a single record (record only; messages excluded) and errors
//     cleanly on a missing id.
//   - gating: no requirementStore → tool execute returns the requirementStore
//     error (CONDITIONAL_TOOLS drops it from the active set).
//   - created signal: RequirementStore.create flows through SqliteStore → hub,
//     so onDataChange receives { collection:'requirements', op:'create' }
//     naturally (no extra emit needed in Flow).
//
// ## Inputs
// Temporary SessionDB (mkdtempSync) + real RequirementStore + onDataChange spy.
//
// ## Output
// Vitest cases.
//

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { RequirementStore } from "../../src/server/requirement-store.js";
import { runMigrations } from "../../src/server/db-migration.js";
import {
	onDataChange,
	_resetDataChangeHubForTest,
} from "../../src/server/data-change-hub.js";
import { flowTool } from "../../src/runtime/tools/flow-tool.js";
import { getToolExecute } from "../../src/runtime/tools/tool-factory.js";
import {
	ALL_TOOLS,
	buildToolsSet,
} from "../../src/runtime/tools/index.js";

// Get the inner execute (bypasses the AI SDK wrapper + hooks/rate-limit, so
// the test drives the action switch directly and asserts on its return).
const execFlow = getToolExecute(flowTool)!;

function parse(s: unknown): any {
	return typeof s === "string" ? JSON.parse(s) : s;
}

let tmpDir: string;
let workspaceDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let requirementStore: RequirementStore;

let PROJECT_ID = "proj-f1";

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-f1-flow-"));
	workspaceDir = join(tmpDir, "ws");
	mkdirSync(workspaceDir, { recursive: true });

	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	requirementStore = new RequirementStore(sessionDB);

	// requirements.project_id is NOT NULL REFERENCES projects(id), so seed a
	// project first; the FK ties PROJECT_ID to a real row.
	const project = projectStore.create({ name: "F1 Test", workspaceDir } as any);
	PROJECT_ID = project.id;

	_resetDataChangeHubForTest();
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function buildCtx(overrides: Record<string, any> = {}) {
	return {
		workingDir: workspaceDir,
		agentId: "agent-f1",
		emit: () => {},
		requirementStore,
		contextBundle: { projectId: PROJECT_ID, workspaceDir, wikiRootNodeId: `root:${PROJECT_ID}` },
		...overrides,
	};
}

// ─── create ─────────────────────────────────────────────────

describe("Flow tool · create", () => {
	test("creates a status='found' record + writes the Intent doc", async () => {
		const out = await execFlow(
			{ action: "create", projectId: PROJECT_ID, title: "Add metrics export", description: "Export prometheus metrics", priority: "high" },
			buildCtx(),
		);
		expect(out).toMatch(/Requirement created:/);

		const reqs = requirementStore.listByProject(PROJECT_ID);
		expect(reqs.length).toBe(1);
		const req = reqs[0];
		expect(req.status).toBe("found");
		expect(req.title).toBe("Add metrics export");
		expect(req.priority).toBe("high");
		expect(req.source).toBe("analyst");
		expect(req.reviewer).toBe("analyst");

		// The Intent section was written to docs/requirements/{id}.md.
		const abs = join(workspaceDir, "docs", "requirements", `${req.id}.md`);
		expect(existsSync(abs)).toBe(true);
		const body = readFileSync(abs, "utf-8");
		expect(body).toContain("# Add metrics export");
		expect(body).toContain("## Intent");
		expect(body).toContain("Export prometheus metrics");
	});

	test("errors cleanly when requirementStore is missing (gating)", async () => {
		const out = await execFlow(
			{ action: "create", projectId: PROJECT_ID, title: "X" },
			// No requirementStore in the context.
			{ workingDir: workspaceDir, agentId: "agent-f1", emit: () => {}, contextBundle: { projectId: PROJECT_ID, workspaceDir } } as any,
		);
		expect(out).toMatch(/requires ctx.requirementStore/i);
	});

	test("errors cleanly when projectId is missing", async () => {
		const out = await execFlow(
			{ action: "create", title: "X" },
			// No contextBundle.projectId, no ctx.projectId, no input.projectId.
			{ workingDir: workspaceDir, agentId: "agent-f1", emit: () => {}, requirementStore } as any,
		);
		expect(out).toMatch(/projectId is required/i);
	});

	test("errors cleanly when title is missing", async () => {
		const out = await execFlow(
			{ action: "create", projectId: PROJECT_ID },
			buildCtx(),
		);
		expect(out).toMatch(/title is required/i);
	});

	test("falls back to ctx.projectId when contextBundle has none", async () => {
		const out = await execFlow(
			{ action: "create", title: "Legacy path" },
			{
				workingDir: workspaceDir,
				agentId: "agent-f1",
				emit: () => {},
				requirementStore,
				projectId: PROJECT_ID,
			} as any,
		);
		expect(out).toMatch(/Requirement created:/);
		expect(requirementStore.listByProject(PROJECT_ID).length).toBe(1);
	});

	test("falls back to ctx.workingDir when contextBundle.workspaceDir is absent", async () => {
		const out = await execFlow(
			{ action: "create", projectId: PROJECT_ID, title: "Fallback ws", description: "uses workingDir" },
			{
				workingDir: workspaceDir,
				agentId: "agent-f1",
				emit: () => {},
				requirementStore,
				contextBundle: { projectId: PROJECT_ID, wikiRootNodeId: "r" },
			} as any,
		);
		expect(out).toMatch(/Requirement created:/);
		const req = requirementStore.listByProject(PROJECT_ID)[0];
		expect(existsSync(join(workspaceDir, "docs", "requirements", `${req.id}.md`))).toBe(true);
	});
});

// ─── list ─────────────────────────────────────────────────

describe("Flow tool · list", () => {
	let OTHER_PROJECT_ID: string;
	beforeEach(() => {
		const other = projectStore.create({ name: "Other", workspaceDir: join(tmpDir, "ws2") } as any);
		OTHER_PROJECT_ID = other.id;
		requirementStore.create({ projectId: PROJECT_ID, title: "A", description: "a", status: "found", source: "analyst", priority: "low", reviewer: "analyst" });
		requirementStore.create({ projectId: PROJECT_ID, title: "B", description: "b", status: "found", source: "analyst", priority: "high", reviewer: "analyst" });
		requirementStore.create({ projectId: PROJECT_ID, title: "C", description: "c", status: "discuss", source: "analyst", priority: "high", reviewer: "analyst" });
		requirementStore.create({ projectId: OTHER_PROJECT_ID, title: "Z", description: "z", status: "found", source: "analyst", priority: "normal", reviewer: "analyst" });
	});

	test("returns the project's requirements", async () => {
		const out = await execFlow({ action: "list", projectId: PROJECT_ID }, buildCtx());
		const arr = parse(out) as any[];
		expect(arr.length).toBe(3);
		expect(arr.every((r) => r.projectId === PROJECT_ID)).toBe(true);
	});

	test("status filter is honoured", async () => {
		const out = await execFlow({ action: "list", projectId: PROJECT_ID, status: "discuss" }, buildCtx());
		const arr = parse(out) as any[];
		expect(arr.length).toBe(1);
		expect(arr[0].title).toBe("C");
	});

	test("priority filter is honoured", async () => {
		const out = await execFlow({ action: "list", projectId: PROJECT_ID, priority: "high" }, buildCtx());
		const arr = parse(out) as any[];
		expect(arr.length).toBe(2);
		expect(arr.every((r) => r.priority === "high")).toBe(true);
	});

	test("no projectId returns all requirements across projects", async () => {
		const out = await execFlow({ action: "list" }, buildCtx());
		const arr = parse(out) as any[];
		expect(arr.length).toBeGreaterThanOrEqual(4);
	});
});

// ─── get ─────────────────────────────────────────────────

describe("Flow tool · get", () => {
	test("returns the record only (no messages)", async () => {
		const created = requirementStore.create({ projectId: PROJECT_ID, title: "R", description: "d", status: "found", source: "analyst", priority: "normal", reviewer: "analyst" });
		const out = await execFlow({ action: "get", id: created.id }, buildCtx());
		const rec = parse(out);
		expect(rec.id).toBe(created.id);
		expect(rec.title).toBe("R");
		// get returns the record, never the messages array.
		expect(rec.messages).toBeUndefined();
	});

	test("errors cleanly on a missing id", async () => {
		const out = await execFlow({ action: "get", id: "nope" }, buildCtx());
		expect(out).toMatch(/Requirement not found/i);
	});

	test("errors cleanly when id is missing", async () => {
		const out = await execFlow({ action: "get" }, buildCtx());
		expect(out).toMatch(/id is required/i);
	});
});

// ─── gating: CONDITIONAL_TOOLS drops Flow without requirementStore ─

describe("Flow tool · gating", () => {
	test("Flow is in ALL_TOOLS", () => {
		expect(ALL_TOOLS.Flow).toBe(flowTool);
	});

	test("buildToolsSet excludes Flow when ctx has no requirementStore", () => {
		const tools = buildToolsSet(
			{ autoApprove: ["*"] },
			{ workingDir: workspaceDir, agentId: "a", emit: () => {} } as any,
		);
		expect(tools.Flow).toBeUndefined();
	});

	test("buildToolsSet includes Flow when ctx has requirementStore", () => {
		const tools = buildToolsSet(
			{ autoApprove: ["*"] },
			buildCtx(),
		);
		expect(tools.Flow).toBeDefined();
	});
});

// ─── created signal flows through the hub naturally ─────────

describe("Flow tool · created signal (natural hub emit)", () => {
	test("create emits { collection:'requirements', op:'create' } via the hub", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		await execFlow(
			{ action: "create", projectId: PROJECT_ID, title: "Signal", description: "x" },
			buildCtx(),
		);

		// Hub flushes on the next tick (setTimeout 0).
		await new Promise((r) => setTimeout(r, 0));

		expect(cb).toHaveBeenCalled();
		const reqEvents = cb.mock.calls
			.map((c) => c[0])
			.filter((e: any) => e.collection === "requirements");
		expect(reqEvents.length).toBeGreaterThanOrEqual(1);
		const reqEvent = reqEvents[0];
		const createChange = reqEvent.changes.find((c: any) => c.op === "create");
		expect(createChange).toBeTruthy();
		expect(createChange.record).toBeTruthy();
	});

	test("get / list do NOT emit any hub event", async () => {
		const created = requirementStore.create({ projectId: PROJECT_ID, title: "Pre", description: "p", status: "found", source: "analyst", priority: "normal", reviewer: "analyst" });
		// Drain the create flush first.
		await new Promise((r) => setTimeout(r, 0));

		const cb = vi.fn();
		onDataChange(cb);

		await execFlow({ action: "get", id: created.id }, buildCtx());
		await execFlow({ action: "list", projectId: PROJECT_ID }, buildCtx());
		await new Promise((r) => setTimeout(r, 0));

		const reqEvents = cb.mock.calls
			.map((c) => c[0])
			.filter((e: any) => e.collection === "requirements");
		expect(reqEvents.length).toBe(0);
	});
});

// ─── F3: old tools retired, Flow is the single entry point ───────

describe("Flow tool · old requirement tools retired (F3)", () => {
	test("CreateRequirement / CreateRequirementWithDoc / verify are NOT in ALL_TOOLS; Flow is", () => {
		// F3 retired the three legacy tools — Flow is the single entry point.
		expect(ALL_TOOLS.CreateRequirement).toBeUndefined();
		expect(ALL_TOOLS.CreateRequirementWithDoc).toBeUndefined();
		expect(ALL_TOOLS.verify).toBeUndefined();
		expect(ALL_TOOLS.Flow).toBeDefined();
	});
});
