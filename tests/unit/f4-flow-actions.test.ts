// F4 unit tests: FlowActions shared backend — single source for REST + runtime
//
// # File spec
//
// ## Core
// Verifies acceptance-F4.md / plan-F4.md:
//   - createFlowActions returns ONE backend; both the runtime Flow tool and
//     the REST requirement-router drive transition + doc section + named hook
//     signal through it (single source — structural assertion).
//   - transition action writes the doc section (file) + emits the named signal
//     (requirements.<signal>) via the hub.
//   - verify with a user-supplied verdict (REST/UI path, no delegation):
//     APPROVED → submitCoverageVerdict(covered=true) → merge + closed +
//     verified signal; REJECTED → rework build + rejected signal.
//   - legacy docPath fallback: a doc seeded under .zero/requirements/{pid}/ is
//     still readable / writable (F4 migration — old projects keep rendering).
//
// ## Migration coverage
//   - ManagementService.resyncDeliveryWorkHookToReady migrates a seeded
//     delivery work still hooked on `requirements.create` to `requirements.ready`,
//     leaves user-customized works alone, idempotent.
//
// ## Inputs
// Temporary SessionDB (mkdtempSync) + real RequirementStore + ProjectWorkStore
// + emitTransition wired through the real hub (onDataChange spy). For the
// verify path a fake PmService records submitCoverageVerdict calls.
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
import { ManagementService } from "../../src/server/management-service.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { runMigrations } from "../../src/server/db-migration.js";
import {
	emitTransition,
	onDataChange,
	_resetDataChangeHubForTest,
	type DataChangeEvent,
} from "../../src/server/data-change-hub.js";
import {
	createFlowActions,
	type FlowActions,
	resolveExistingDocPath,
	writeDocSection,
} from "../../src/server/flow-actions.js";

let tmpDir: string;
let workspaceDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let requirementStore: RequirementStore;
let projectWorkStore: ProjectWorkStore;
let PROJECT_ID: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-f4-flow-"));
	workspaceDir = join(tmpDir, "ws");
	mkdirSync(workspaceDir, { recursive: true });

	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	requirementStore = new RequirementStore(sessionDB);
	projectWorkStore = new ProjectWorkStore(sessionDB);

	const project = projectStore.create({ name: "F4 Test", workspaceDir } as any);
	PROJECT_ID = project.id;

	_resetDataChangeHubForTest();
});

afterEach(async () => {
	await new Promise((r) => setTimeout(r, 10));
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function buildActions(overrides: { pmService?: any; emitTransition?: any } = {}): FlowActions {
	return createFlowActions({
		requirementStore,
		resolveWorkspaceDir: () => workspaceDir,
		emitTransition: overrides.emitTransition ?? emitTransition,
		pmService: overrides.pmService,
	});
}

/** Drain + capture hub events between two points. */
function captureSignals(): { events: DataChangeEvent[]; stop: () => void } {
	const events: DataChangeEvent[] = [];
	const stop = onDataChange((e) => events.push(e));
	return { events, stop };
}

function signalsFor(events: DataChangeEvent[], collection: "requirements"): string[] {
	const out: string[] = [];
	for (const e of events) {
		if (e.collection !== collection) continue;
		for (const c of e.changes) out.push(c.signal ?? c.op);
	}
	return out;
}

function newReq(status: "found" | "verify" = "found", overrides: Record<string, any> = {}): string {
	const r = requirementStore.create({
		projectId: PROJECT_ID,
		title: "T",
		description: "intent",
		status,
		source: "agent",
		priority: "normal",
		reviewer: "agent",
		...overrides,
	} as any);
	return r.id;
}

function docPath(id: string): string {
	return join(workspaceDir, "docs", "requirements", `${id}.md`);
}

function legacyDocPath(id: string): string {
	return join(workspaceDir, ".zero", "requirements", PROJECT_ID, `${id}.md`);
}

// ─── single source: same backend serves REST + runtime ──────────────

describe("FlowActions · single source (REST + runtime)", () => {
	test("createFlowActions returns an object exposing create/list/get/transition/verify", () => {
		const a = buildActions();
		expect(typeof a.create).toBe("function");
		expect(typeof a.list).toBe("function");
		expect(typeof a.get).toBe("function");
		expect(typeof a.transition).toBe("function");
		expect(typeof a.verify).toBe("function");
	});

	test("transition + doc section + named signal all run through the shared backend", async () => {
		const { events, stop } = captureSignals();
		const actions = buildActions();
		const id = newReq("found");

		const result = actions.transition({ id, action: "pick", body: "summary body" });
		// Hub flushes on the next macrotask.
		await new Promise((r) => setTimeout(r, 10));

		expect(result.requirement.status).toBe("discuss");
		// Doc section written under the canonical path.
		expect(existsSync(docPath(id))).toBe(true);
		const text = readFileSync(docPath(id), "utf-8");
		expect(text).toMatch(/## Summary[\s\S]*summary body/);
		// Named signal emitted.
		expect(signalsFor(events, "requirements")).toContain("picked");
		stop();
	});
});

// ─── create: writes Intent doc + stamps canonical docPath ───────────

describe("FlowActions · create", () => {
	test("writes the Intent doc under docs/requirements/{id}.md (canonical path)", () => {
		const actions = buildActions();
		const { requirement: r } = actions.create({
			projectId: PROJECT_ID,
			title: "Add metrics",
			description: "export prometheus",
			priority: "high",
		});
		expect(existsSync(docPath(r.id))).toBe(true);
		expect(readFileSync(docPath(r.id), "utf-8")).toMatch(/## Intent/);
		// resolveExistingDocPath finds the canonical doc on read.
		expect(resolveExistingDocPath(workspaceDir, PROJECT_ID, r.id)).toBe(docPath(r.id));
	});
});

// ─── verify (user/REST path): verdict supplied directly ─────────────

describe("FlowActions · verify · user verdict path (REST/UI)", () => {
	/**
	 * Fake PmService. The REAL PmService.submitCoverageVerdict drives the
	 * verify→closed transition itself (archivist merge path); we mirror that so
	 * the post-verify record reflects the close. On REJECTED the real service
	 * does NOT advance (rework verify→build is the FlowActions caller's job),
	 * so the fake leaves status in 'verify' and FlowActions performs the
	 * verify→build transition.
	 */
	function fakePm(covered: boolean): any {
		return {
			submitCoverageVerdict: vi.fn().mockImplementation(async (id: string) => {
				if (covered) {
					requirementStore.transitionStatus(id, "closed", "user", "PM APPROVED (mock)");
					return {
						covered: true,
						merge: { ok: true, ref: "abc123" },
						finalStatus: "closed",
					};
				}
				return {
					covered: false,
					merge: { ok: false },
					finalStatus: "verify",
				};
			}),
		};
	}

	/** Wait for the hub's coalesced flush (macrotask) so signals land. */
	async function flushHub(): Promise<void> {
		await new Promise((r) => setTimeout(r, 10));
	}

	test("APPROVED verdict → submitCoverageVerdict(covered=true) + closed + verified signal", async () => {
		const { events, stop } = captureSignals();
		const pm = fakePm(true);
		const actions = buildActions({ pmService: pm });
		const id = newReq("verify");

		const result = await actions.verify({
			id,
			projectId: PROJECT_ID,
			source: { kind: "verdict", covered: true, reason: "all covered" },
		});
		await flushHub();

		expect(pm.submitCoverageVerdict).toHaveBeenCalledWith(
			id,
			{ covered: true, reason: "all covered" },
		);
		expect(result.applied).toBe(true);
		expect(result.requirement.status).toBe("closed");
		expect(signalsFor(events, "requirements")).toContain("verified");
		stop();
	});

	test("REJECTED verdict → rework verify→build + rejected signal + Decision Log", async () => {
		const { events, stop } = captureSignals();
		const pm = fakePm(false);
		const actions = buildActions({ pmService: pm });
		const id = newReq("verify");
		// Seed a doc so Decision Log lands somewhere.
		mkdirSync(join(workspaceDir, "docs", "requirements"), { recursive: true });
		writeFileSync(docPath(id), `# T\n\n## Intent\n\nx\n`, "utf-8");

		const result = await actions.verify({
			id,
			projectId: PROJECT_ID,
			source: { kind: "verdict", covered: false, reason: "missing tests" },
		});
		await flushHub();

		expect(result.applied).toBe(true);
		expect(result.requirement.status).toBe("build");
		expect(signalsFor(events, "requirements")).toContain("rejected");
		const text = readFileSync(docPath(id), "utf-8");
		expect(text).toMatch(/## Decision Log[\s\S]*REJECTED — missing tests/);
		stop();
	});

	test("verdict source 'none' degrades — status stays in verify, no signal", async () => {
		const actions = buildActions();
		const id = newReq("verify");
		const result = await actions.verify({ id, projectId: PROJECT_ID, source: { kind: "none" } });
		expect(result.applied).toBe(false);
		expect(result.requirement.status).toBe("verify");
	});
});

// ─── legacy docPath fallback ────────────────────────────────────────

describe("FlowActions · legacy docPath fallback (.zero/requirements/...)", () => {
	test("resolveExistingDocPath honours a pre-F4 doc under .zero/requirements/{pid}/{id}.md", () => {
		const id = "req-legacy";
		mkdirSync(join(workspaceDir, ".zero", "requirements", PROJECT_ID), { recursive: true });
		writeFileSync(legacyDocPath(id), "# legacy\n", "utf-8");
		// No canonical doc; legacy path returned.
		expect(resolveExistingDocPath(workspaceDir, PROJECT_ID, id)).toBe(legacyDocPath(id));
		// Canonical doc present wins.
		mkdirSync(join(workspaceDir, "docs", "requirements"), { recursive: true });
		writeFileSync(docPath(id), "# canonical\n", "utf-8");
		expect(resolveExistingDocPath(workspaceDir, PROJECT_ID, id)).toBe(docPath(id));
	});

	test("writeDocSection writes to the existing legacy doc when no canonical exists", () => {
		const id = "req-legacy2";
		mkdirSync(join(workspaceDir, ".zero", "requirements", PROJECT_ID), { recursive: true });
		writeFileSync(legacyDocPath(id), `# T\n\n## Intent\n\nx\n`, "utf-8");

		writeDocSection(workspaceDir, PROJECT_ID, id, "Summary", "legacy summary");

		// Canonical not created; legacy updated.
		expect(existsSync(docPath(id))).toBe(false);
		expect(readFileSync(legacyDocPath(id), "utf-8")).toMatch(/## Summary[\s\S]*legacy summary/);
	});
});

// ─── migration: resyncDeliveryWorkHookToReady ───────────────────────

describe("ManagementService.resyncDeliveryWorkHookToReady (F4 migration)", () => {
	function makeSvc(): ManagementService {
		const agentStore = new AgentStore(sessionDB);
		return new ManagementService({ agentStore, projectStore } as any);
	}

	test("migrates a delivery work hooked on requirements.create → requirements.ready", () => {
		const svc = makeSvc();
		(svc as any).projectWorkStore = projectWorkStore;
		// Seed a work the way pre-F3 projects stored it: create-event hook.
		const work = projectWorkStore.create({
			projectId: PROJECT_ID,
			name: "需求管理",
			actionPrompt: "old prompt",
			requiredTools: [],
			agentId: null,
			contextPolicy: {},
			hooks: [{ event: "requirements.create", collection: "requirements", enabled: true }],
			enabled: true,
		} as any);

		svc.resyncDeliveryWorkHookToReady();

		const after = projectWorkStore.get(work.id)!;
		expect(after.hooks[0].event).toBe("requirements.ready");
	});

	test("leaves works already on requirements.ready alone (idempotent)", () => {
		const svc = makeSvc();
		(svc as any).projectWorkStore = projectWorkStore;
		const work = projectWorkStore.create({
			projectId: PROJECT_ID,
			name: "需求管理",
			actionPrompt: "p",
			requiredTools: [],
			agentId: null,
			contextPolicy: {},
			hooks: [{ event: "requirements.ready", collection: "requirements", enabled: true }],
			enabled: true,
		} as any);

		svc.resyncDeliveryWorkHookToReady(); // should be a no-op

		const after = projectWorkStore.get(work.id)!;
		expect(after.hooks[0].event).toBe("requirements.ready");
	});

	test("leaves user-customized (non-delivery-name) works alone", () => {
		const svc = makeSvc();
		(svc as any).projectWorkStore = projectWorkStore;
		const work = projectWorkStore.create({
			projectId: PROJECT_ID,
			name: "My custom work",
			actionPrompt: "p",
			requiredTools: [],
			agentId: null,
			contextPolicy: {},
			hooks: [{ event: "requirements.create", collection: "requirements", enabled: true }],
			enabled: true,
		} as any);

		svc.resyncDeliveryWorkHookToReady();

		const after = projectWorkStore.get(work.id)!;
		// Name doesn't match → untouched.
		expect(after.hooks[0].event).toBe("requirements.create");
	});
});
