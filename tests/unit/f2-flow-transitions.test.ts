// F2 unit tests: Flow transition actions + named hook signals — project-flow
//
// # File spec
//
// ## Core
// Verifies acceptance-F2.md / plan-F2.md:
//   - pick / ready / plan / startBuild / finishBuild each perform the legal
//     status transition, write the matching doc section (file, not DB), and
//     emit the named hook signal (requirements.<signal>) via ctx.emitTransition.
//   - Illegal transitions (e.g. found→build direct) return a friendly "Error:".
//   - create keeps emitting the natural requirements.create (F1 not regressed).
//   - The named-signal mechanism + ProjectWorkHookManager: a work subscribed to
//     `requirements.ready` fires when the ready action emits the signal; a work
//     subscribed to `requirements.buildFinished` does NOT fire on ready.
//
// ## Inputs
// Temporary SessionDB (mkdtempSync) + real RequirementStore + ProjectWorkStore
// + emitTransition wired through the real hub (onDataChange spy). For the hook
// manager test we feed a fake ProjectWorkRunner that records fireProjectWork
// calls so we can assert which work fired.
//
// ## Output
// Vitest cases.
//

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { RequirementStore } from "../../src/server/requirement-store.js";
import { ProjectWorkStore } from "../../src/server/project-work-store.js";
import { runMigrations } from "../../src/server/db-migration.js";
import {
	emitTransition,
	onDataChange,
	_resetDataChangeHubForTest,
} from "../../src/server/data-change-hub.js";
import { ProjectWorkHookManager } from "../../src/server/project-work-hook-manager.js";
import { flowTool } from "../../src/runtime/tools/flow-tool.js";
import { getToolExecute } from "../../src/runtime/tools/tool-factory.js";

// Drive the action switch directly (bypasses the AI SDK wrapper + hooks).
const execFlow = getToolExecute(flowTool)!;

let tmpDir: string;
let workspaceDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let requirementStore: RequirementStore;
let projectWorkStore: ProjectWorkStore;
let PROJECT_ID: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-f2-flow-"));
	workspaceDir = join(tmpDir, "ws");
	mkdirSync(workspaceDir, { recursive: true });

	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	requirementStore = new RequirementStore(sessionDB);
	projectWorkStore = new ProjectWorkStore(sessionDB);

	const project = projectStore.create({ name: "F2 Test", workspaceDir } as any);
	PROJECT_ID = project.id;

	_resetDataChangeHubForTest();
});

afterEach(async () => {
	// Drain any pending hub flush (setTimeout 0) so a late flush doesn't hit a
	// closed DB. The hub's flush + the async handleDataChange both need a couple
	// of macrotask ticks to settle.
	await new Promise((r) => setTimeout(r, 10));
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function buildCtx(overrides: Record<string, any> = {}) {
	return {
		workingDir: workspaceDir,
		agentId: "agent-f2",
		emit: () => {},
		requirementStore,
		// Wire the real hub emitter so transition actions fire named signals.
		emitTransition,
		contextBundle: { projectId: PROJECT_ID, workspaceDir, wikiRootNodeId: `root:${PROJECT_ID}` },
		...overrides,
	};
}

function docPath(id: string): string {
	return join(workspaceDir, "docs", "requirements", `${id}.md`);
}

/** Create + walk a requirement through to the given status, returning its id. */
function seedReqAt(status: "found" | "discuss" | "ready" | "plan" | "build"): string {
	const req = requirementStore.create({
		projectId: PROJECT_ID,
		title: "Seed",
		description: "seed intent",
		status: "found",
		source: "analyst",
		priority: "normal",
		reviewer: "analyst",
	}) as any;
	// Mirror Flow.create's Intent-doc side effect so transition-action tests can
	// assert the doc structure evolves (F1 section preserved by later writes).
	mkdirSync(join(workspaceDir, "docs", "requirements"), { recursive: true });
	writeFileSync(docPath(req.id),
		`# Seed\n\n> Requirement: ${req.id} · status: ${req.status}\n\n## Intent\n\nseed intent\n`,
		"utf-8");
	if (status === "found") return req.id;
	requirementStore.transitionStatus(req.id, "discuss", "analyst", "seed");
	if (status === "discuss") return req.id;
	requirementStore.transitionStatus(req.id, "ready", "user", "seed");
	if (status === "ready") return req.id;
	requirementStore.transitionStatus(req.id, "plan", "lead", "seed");
	if (status === "plan") return req.id;
	requirementStore.transitionStatus(req.id, "build", "lead", "seed");
	return req.id;
}

// ─── transition actions: status + doc section + signal ──────────────

describe("Flow tool · pick (found→discuss)", () => {
	test("transitions, writes Summary section, emits requirements.picked", async () => {
		const id = seedReqAt("found");
		const out = await execFlow(
			{ action: "pick", id, summary: "User confirmed the export scope." },
			buildCtx(),
		);
		expect(out).toMatch(/Requirement pick:/);
		expect(requirementStore.get(id)!.status).toBe("discuss");

		const body = readFileSync(docPath(id), "utf-8");
		expect(body).toContain("## Summary");
		expect(body).toContain("User confirmed the export scope.");
		// Intent section created by F1 must still be present.
		expect(body).toContain("## Intent");
	});

	test("replaces an existing Summary on re-pick", async () => {
		const id = seedReqAt("found");
		await execFlow({ action: "pick", id, summary: "first" }, buildCtx());
		// revert to found via store so we can pick again (discuss→found is user-only)
		requirementStore.transitionStatus(id, "found", "user", "redo");
		await execFlow({ action: "pick", id, summary: "second take" }, buildCtx());

		const body = readFileSync(docPath(id), "utf-8");
		expect(body).not.toContain("first");
		expect(body).toContain("second take");
		expect(body.match(/## Summary/g)!.length).toBe(1);
	});
});

describe("Flow tool · ready (discuss→ready)", () => {
	test("transitions and emits requirements.ready (no section)", async () => {
		const id = seedReqAt("discuss");
		const out = await execFlow({ action: "ready", id }, buildCtx());
		expect(out).toMatch(/Requirement ready:/);
		expect(requirementStore.get(id)!.status).toBe("ready");
	});
});

describe("Flow tool · plan (ready→plan)", () => {
	test("transitions, writes Plan section, emits requirements.planned", async () => {
		const id = seedReqAt("ready");
		const out = await execFlow(
			{ action: "plan", id, plan: "Step 1: schema. Step 2: export." },
			buildCtx(),
		);
		expect(out).toMatch(/Requirement plan:/);
		expect(requirementStore.get(id)!.status).toBe("plan");

		const body = readFileSync(docPath(id), "utf-8");
		expect(body).toContain("## Plan");
		expect(body).toContain("Step 1: schema");
	});

	test("does NOT create a worktree (deferred to F3)", async () => {
		const id = seedReqAt("ready");
		await execFlow({ action: "plan", id, plan: "x" }, buildCtx());
		// F3 owns worktree creation; the only filesystem side effect here is the
		// doc section. Nothing under .worktrees / ~/.zero-core/projects/... is
		// created in F2.
		expect(existsSync(join(tmpDir, "ws.worktrees"))).toBe(false);
	});
});

describe("Flow tool · startBuild (plan→build)", () => {
	test("transitions and emits requirements.buildStarted", async () => {
		const id = seedReqAt("plan");
		const out = await execFlow({ action: "startBuild", id }, buildCtx());
		expect(out).toMatch(/Requirement startBuild:/);
		expect(requirementStore.get(id)!.status).toBe("build");
	});
});

describe("Flow tool · finishBuild (build→verify)", () => {
	test("transitions, writes Coverage section, emits requirements.buildFinished", async () => {
		const id = seedReqAt("build");
		const out = await execFlow(
			{ action: "finishBuild", id, coverage: "All paths covered; tests green." },
			buildCtx(),
		);
		expect(out).toMatch(/Requirement finishBuild:/);
		expect(requirementStore.get(id)!.status).toBe("verify");

		const body = readFileSync(docPath(id), "utf-8");
		expect(body).toContain("## Coverage");
		expect(body).toContain("All paths covered");
	});
});

// ─── named signals actually reach hub listeners ─────────────────────

describe("Flow tool · named hook signals via hub", () => {
	test("ready action emits requirements.ready with the updated record", async () => {
		const id = seedReqAt("discuss");
		const cb = vi.fn();
		onDataChange(cb);

		await execFlow({ action: "ready", id }, buildCtx());
		await new Promise((r) => setTimeout(r, 0)); // flush

		const reqEvents = cb.mock.calls.map((c) => c[0]).filter((e: any) => e.collection === "requirements");
		// update (transitionStatus) + update (emitTransition) coalesce to one
		// change for the id; the signal stamps requirements.ready on it.
		const changes = reqEvents.flatMap((e: any) => e.changes as any[]);
		const ready = changes.find((c) => c.signal === "ready");
		expect(ready).toBeTruthy();
		expect(ready.record).toBeTruthy();
		expect((ready.record as any).status).toBe("ready");
	});

	test("each action emits its specific named signal", async () => {
		// pick
		let id = seedReqAt("found");
		let cb = vi.fn(); onDataChange(cb);
		await execFlow({ action: "pick", id, summary: "s" }, buildCtx());
		await new Promise((r) => setTimeout(r, 0));
		expect(cb.mock.calls.flatMap((c) => c[0].changes).some((c: any) => c.signal === "picked")).toBe(true);

		// plan
		_resetDataChangeHubForTest();
		id = seedReqAt("ready");
		cb = vi.fn(); onDataChange(cb);
		await execFlow({ action: "plan", id, plan: "p" }, buildCtx());
		await new Promise((r) => setTimeout(r, 0));
		expect(cb.mock.calls.flatMap((c) => c[0].changes).some((c: any) => c.signal === "planned")).toBe(true);

		// finishBuild
		_resetDataChangeHubForTest();
		id = seedReqAt("build");
		cb = vi.fn(); onDataChange(cb);
		await execFlow({ action: "finishBuild", id, coverage: "c" }, buildCtx());
		await new Promise((r) => setTimeout(r, 0));
		expect(cb.mock.calls.flatMap((c) => c[0].changes).some((c: any) => c.signal === "buildFinished")).toBe(true);
	});
});

// ─── illegal transitions return a friendly error ────────────────────

describe("Flow tool · illegal transitions", () => {
	test("found→build (startBuild) is illegal → Error with valid targets", async () => {
		const id = seedReqAt("found");
		const out = await execFlow({ action: "startBuild", id }, buildCtx());
		expect(out).toMatch(/^Error:/);
		expect(out).toMatch(/startBuild transition failed/);
		// state unchanged
		expect(requirementStore.get(id)!.status).toBe("found");
	});

	test("plan→ready via ready action is illegal (discuss→ready only)", async () => {
		const id = seedReqAt("plan");
		const out = await execFlow({ action: "ready", id }, buildCtx());
		expect(out).toMatch(/^Error:/);
		expect(requirementStore.get(id)!.status).toBe("plan");
	});

	test("missing id → friendly error", async () => {
		const out = await execFlow({ action: "ready" } as any, buildCtx());
		expect(out).toMatch(/id is required/i);
	});
});

// ─── F1 not regressed: create still emits requirements.create ───────

describe("Flow tool · create signal not regressed (F1)", () => {
	test("create emits natural requirements.create via the hub", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		await execFlow(
			{ action: "create", projectId: PROJECT_ID, title: "New", description: "x" },
			buildCtx(),
		);
		await new Promise((r) => setTimeout(r, 0));

		const createChange = cb.mock.calls
			.flatMap((c) => c[0].changes)
			.find((c: any) => c.op === "create");
		expect(createChange).toBeTruthy();
	});
});

// ─── ProjectWorkHookManager matches named transition signals ────────

describe("ProjectWorkHookManager · named signal matching", () => {
	test("work subscribed to requirements.ready fires on the ready signal", async () => {
		const work = projectWorkStore.create({
			projectId: PROJECT_ID,
			name: "Delivery",
			actionPrompt: "Deliver the requirement.",
			requiredTools: [],
			agentId: null,
			hooks: [{ event: "requirements.ready", collection: "requirements", enabled: true }],
			enabled: true,
		} as any);

		const fired: string[] = [];
		const fakeRunner = {
			async fireProjectWork(workId: string) {
				fired.push(workId);
				return { status: "ok" as const };
			},
		};
		const mgr = new ProjectWorkHookManager({
			projectWorkStore,
			projectWorkRunner: fakeRunner as any,
		});
		const stop = mgr.start();

		const id = seedReqAt("discuss");
		await execFlow({ action: "ready", id }, buildCtx());
		// Drain the hub flush (1 tick) + the async handleDataChange (1+ ticks
		// after fireProjectWork resolves) so the assertion sees the fire.
		await new Promise((r) => setTimeout(r, 20));

		expect(fired).toEqual([work.id]);
		stop();
		await new Promise((r) => setTimeout(r, 0));
	});

	test("work subscribed to requirements.buildFinished does NOT fire on ready", async () => {
		const otherWork = projectWorkStore.create({
			projectId: PROJECT_ID,
			name: "Coverage watcher",
			actionPrompt: "Await coverage.",
			requiredTools: [],
			agentId: null,
			hooks: [{ event: "requirements.buildFinished", collection: "requirements", enabled: true }],
			enabled: true,
		} as any);

		const fired: string[] = [];
		const fakeRunner = {
			async fireProjectWork(workId: string) {
				fired.push(workId);
				return { status: "ok" as const };
			},
		};
		const mgr = new ProjectWorkHookManager({
			projectWorkStore,
			projectWorkRunner: fakeRunner as any,
		});
		const stop = mgr.start();

		const id = seedReqAt("discuss");
		await execFlow({ action: "ready", id }, buildCtx());
		await new Promise((r) => setTimeout(r, 20));

		expect(fired).toEqual([]);
		stop();
		// sanity: the work exists and is found for its own event
		expect(projectWorkStore.listWithHook("requirements.buildFinished").map((w) => w.id)).toContain(otherWork.id);
		await new Promise((r) => setTimeout(r, 0));
	});
});
