// F3 unit tests: Flow compound verify + worktree centralization + delivery
// hook = ready + old-tool replacement + RENAMED_TOOLS back-compat — project-flow
//
// # File spec
//
// ## Core
// Verifies acceptance-F3.md / plan-F3.md:
//   - Flow.verify (compound): APPROVED → submitCoverageVerdict(covered=true)
//     + merge ok → status closed + emit `requirements.verified` + Decision Log
//     written. REJECTED → submitCoverageVerdict(covered=false) + rework
//     verify→build + emit `requirements.rejected` + Decision Log written.
//   - Degraded paths: PM dispatch failure keeps status in verify; merge
//     failure keeps status in verify; pmService absent returns verdict text.
//   - Worktree centralization: centralFeatureWorktreePath shape +
//     featureWorktreePath prefers central when present, falls back to legacy.
//     Flow.plan calls createFeatureWorktree WITH projectId + surfaces the
//     worktree path on ctx.featureWorkspace.
//   - Delivery work template hook is `requirements.ready` (not create) and
//     the actionPrompt references Flow actions (plan/startBuild/finishBuild/
//     verify).
//   - Old tools retired: CreateRequirement / CreateRequirementWithDoc /
//     verify absent from ALL_TOOLS; Flow present.
//   - RENAMED_TOOLS back-compat: legacy spellings → "Flow".
//
// ## Inputs
// Temporary SessionDB (mkdtempSync) + real RequirementStore + mocked
// delegateTask / pmService / gitIntegration.
//
// ## Output
// Vitest cases.
//

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { RequirementStore } from "../../src/server/requirement-store.js";
import { runMigrations } from "../../src/server/db-migration.js";
import {
	emitTransition,
	onDataChange,
	_resetDataChangeHubForTest,
} from "../../src/server/data-change-hub.js";
import { flowTool } from "../../src/runtime/tools/flow-tool.js";
import { getToolExecute } from "../../src/runtime/tools/tool-factory.js";
import { ALL_TOOLS } from "../../src/runtime/tools/index.js";
import { createFlowActions } from "../../src/server/flow-actions.js";
import { RENAMED_TOOLS } from "../../src/core/tool-registry.js";
import {
	featureWorktreePath,
	centralFeatureWorktreePath,
	featureBranchName,
} from "../../src/server/archivist-git.js";
import { defaultProjectWorks } from "../../src/server/builtin-work-templates.js";
import { ZERO_CORE_DIR } from "../../src/core/config.js";

const execFlow = getToolExecute(flowTool)!;

let tmpDir: string;
let workspaceDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let requirementStore: RequirementStore;
let PROJECT_ID: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-f3-verify-"));
	workspaceDir = join(tmpDir, "ws");
	mkdirSync(workspaceDir, { recursive: true });

	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	requirementStore = new RequirementStore(sessionDB);

	const project = projectStore.create({ name: "F3 Test", workspaceDir } as any);
	PROJECT_ID = project.id;

	_resetDataChangeHubForTest();
});

afterEach(async () => {
	await new Promise((r) => setTimeout(r, 10));
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function docPath(id: string): string {
	return join(workspaceDir, "docs", "requirements", `${id}.md`);
}

/** Seed a requirement doc (mirrors Flow.create's Intent write) so transition +
 * verify actions can assert the doc structure evolves. */
function seedDoc(id: string, status: string): void {
	mkdirSync(join(workspaceDir, "docs", "requirements"), { recursive: true });
	writeFileSync(
		docPath(id),
		`# Seed\n\n> Requirement: ${id} · status: ${status}\n\n## Intent\n\nseed intent\n`,
		"utf-8",
	);
}

/** Create + walk a requirement to the given status, returning its id. */
function seedReqAt(status: "verify" | "build"): string {
	const req = requirementStore.create({
		projectId: PROJECT_ID,
		title: "Seed",
		description: "seed intent",
		status: "found",
		source: "analyst",
		priority: "normal",
		reviewer: "analyst",
		createdByAgentId: "agent-pm",
		reviewerAgentId: "agent-pm",
	} as any);
	seedDoc(req.id, "found");
	requirementStore.transitionStatus(req.id, "discuss", "analyst", "seed");
	requirementStore.transitionStatus(req.id, "ready", "user", "seed");
	requirementStore.transitionStatus(req.id, "plan", "lead", "seed");
	requirementStore.transitionStatus(req.id, "build", "lead", "seed");
	if (status === "build") return req.id;
	requirementStore.transitionStatus(req.id, "verify", "system", "seed");
	return req.id;
}

function buildCtx(overrides: Record<string, any> = {}) {
	// project-flow F4: the Flow tool forwards to ctx.flowActions. Build the
	// shared backend; pmService is supplied per-test via overrides
	// (flowActions takes precedence when present, so we rebuild below if the
	// caller injects a pmService).
	const baseFlowActions = createFlowActions({
		requirementStore,
		resolveWorkspaceDir: () => workspaceDir,
		emitTransition,
	});
	const ctx = {
		workingDir: workspaceDir,
		agentId: "agent-lead",
		emit: () => {},
		requirementStore,
		flowActions: baseFlowActions,
		emitTransition,
		contextBundle: { projectId: PROJECT_ID, workspaceDir, wikiRootNodeId: `root:${PROJECT_ID}` },
		...overrides,
	};
	// If the caller supplied a pmService, rebuild flowActions so verify's
	// compound close sees it (the backend is constructed once per ctx).
	if (overrides.pmService) {
		ctx.flowActions = createFlowActions({
			requirementStore,
			resolveWorkspaceDir: () => workspaceDir,
			emitTransition,
			pmService: overrides.pmService,
		});
	}
	return ctx;
}

// ─── Flow.verify · APPROVED → merge + closed + verified signal ───────

describe("Flow.verify · APPROVED path", () => {
	test("delegates PM, submits covered=true, merges, status→closed, emits requirements.verified, writes Decision Log", async () => {
		const id = seedReqAt("verify");
		const delegateTask = vi.fn().mockResolvedValue("VERDICT: APPROVED — full coverage");
		const submitCoverageVerdict = vi.fn().mockResolvedValue({
			covered: true,
			reviewerAgentId: "agent-pm",
			merge: { ok: true, ref: "abc123" },
			finalStatus: "closed",
		});

		const out = await execFlow(
			{ action: "verify", id, summary: "done" } as any,
			buildCtx({ delegateTask, pmService: { submitCoverageVerdict } }),
		);

		// PM was delegated the coverage task targeting the recorded PM agent.
		expect(delegateTask).toHaveBeenCalledTimes(1);
		const [task, opts] = delegateTask.mock.calls[0];
		expect(task).toContain(id);
		expect(opts).toEqual({ targetAgentId: "agent-pm" });

		// Verdict driven through pmService.
		expect(submitCoverageVerdict).toHaveBeenCalledWith(
			id,
			{ covered: true, reason: "full coverage" },
			{ reviewerAgentId: "agent-pm" },
		);

		// merge ok + finalStatus closed (transitionStatus already happened in
		// the mocked submitCoverageVerdict; we just assert the tool didn't
		// override). pmService drove closed, so status is closed.
		expect(out).toMatch(/PM APPROVED/);
		expect(out).toContain("abc123");

		// Decision Log section written to the doc.
		const body = readFileSync(docPath(id), "utf-8");
		expect(body).toContain("## Decision Log");
		expect(body).toContain("APPROVED");
		expect(body).toContain("abc123");

		// requirements.verified signal fired via the hub.
		const cb = vi.fn();
		onDataChange(cb);
		// Re-run to capture the signal (the previous run already emitted; the
		// hub was reset between). Instead assert via a fresh run on a fresh req.
		_resetDataChangeHubForTest();
		const id2 = seedReqAt("verify");
		const cb2 = vi.fn();
		onDataChange(cb2);
		await execFlow(
			{ action: "verify", id: id2 } as any,
			buildCtx({
				delegateTask: vi.fn().mockResolvedValue("VERDICT: APPROVED — ok"),
				pmService: {
					submitCoverageVerdict: vi.fn().mockResolvedValue({
						covered: true, merge: { ok: true, ref: "r" }, finalStatus: "closed",
					}),
				},
			}),
		);
		await new Promise((r) => setTimeout(r, 0));
		const verified = cb2.mock.calls
			.flatMap((c) => c[0].changes)
			.some((c: any) => c.signal === "verified");
		expect(verified).toBe(true);
	});

	test("merge failed → status stays in verify, signal verified still fires, Decision Log notes the failure", async () => {
		const id = seedReqAt("verify");
		const out = await execFlow(
			{ action: "verify", id } as any,
			buildCtx({
				delegateTask: vi.fn().mockResolvedValue("VERDICT: APPROVED — ok"),
				pmService: {
					submitCoverageVerdict: vi.fn().mockResolvedValue({
						covered: true,
						merge: { ok: false, error: "conflict" },
						finalStatus: "verify",
					}),
				},
			}),
		);
		expect(out).toMatch(/PM APPROVED/);
		expect(out).toContain("FAILED");
		const body = readFileSync(docPath(id), "utf-8");
		expect(body).toContain("Archivist merge FAILED");
	});
});

// ─── Flow.verify · REJECTED → rework + rejected signal ───────────────

describe("Flow.verify · REJECTED path (rework)", () => {
	test("records feedback, transitions verify→build, emits requirements.rejected, Decision Log notes rework", async () => {
		const id = seedReqAt("verify");
		const delegateTask = vi.fn().mockResolvedValue("VERDICT: REJECTED — missing edge case X");
		const submitCoverageVerdict = vi.fn().mockResolvedValue({
			covered: false,
			reviewerAgentId: "agent-pm",
			finalStatus: "verify",
		});

		const cb = vi.fn();
		onDataChange(cb);

		const out = await execFlow(
			{ action: "verify", id } as any,
			buildCtx({ delegateTask, pmService: { submitCoverageVerdict } }),
		);
		await new Promise((r) => setTimeout(r, 0));

		expect(submitCoverageVerdict).toHaveBeenCalledWith(
			id,
			{ covered: false, reason: "missing edge case X" },
			{ reviewerAgentId: "agent-pm" },
		);
		// Rework transition verify→build (lead).
		expect(requirementStore.get(id)!.status).toBe("build");
		expect(out).toMatch(/PM REJECTED/);
		expect(out).toContain("returned to 'build'");

		// Signal.
		const rejected = cb.mock.calls
			.flatMap((c) => c[0].changes)
			.some((c: any) => c.signal === "rejected");
		expect(rejected).toBe(true);

		// Decision Log notes the rework.
		const body = readFileSync(docPath(id), "utf-8");
		expect(body).toContain("## Decision Log");
		expect(body).toContain("REJECTED");
		expect(body).toContain("Rework");
	});
});

// ─── Flow.verify · degraded paths ────────────────────────────────────

describe("Flow.verify · degraded paths", () => {
	test("status not 'verify' → friendly error, no delegation", async () => {
		const id = seedReqAt("build");
		const delegateTask = vi.fn();
		const out = await execFlow(
			{ action: "verify", id } as any,
			buildCtx({ delegateTask, pmService: { submitCoverageVerdict: vi.fn() } }),
		);
		expect(out).toMatch(/^Error:/);
		expect(out).toMatch(/verify requires status='verify'/);
		expect(delegateTask).not.toHaveBeenCalled();
		expect(requirementStore.get(id)!.status).toBe("build");
	});

	test("no delegateTask → error, no PM dispatch", async () => {
		const id = seedReqAt("verify");
		const out = await execFlow({ action: "verify", id } as any, buildCtx({}));
		expect(out).toMatch(/delegateTask not available/);
	});

	test("PM dispatch throws → status stays in verify, caller told to retry", async () => {
		const id = seedReqAt("verify");
		const delegateTask = vi.fn().mockRejectedValue(new Error("PM down"));
		const submitCoverageVerdict = vi.fn();
		const out = await execFlow(
			{ action: "verify", id } as any,
			buildCtx({ delegateTask, pmService: { submitCoverageVerdict } }),
		);
		expect(out).toMatch(/PM coverage dispatch failed/);
		expect(submitCoverageVerdict).not.toHaveBeenCalled();
		expect(requirementStore.get(id)!.status).toBe("verify");
	});

	test("pmService absent → verdict text returned, no merge/close", async () => {
		const id = seedReqAt("verify");
		const out = await execFlow(
			{ action: "verify", id } as any,
			buildCtx({ delegateTask: vi.fn().mockResolvedValue("VERDICT: APPROVED — ok") }),
		);
		expect(out).toMatch(/PM APPROVED/);
		expect(out).toMatch(/pmService not wired/);
		// Decision Log still written.
		const body = readFileSync(docPath(id), "utf-8");
		expect(body).toContain("## Decision Log");
	});
});

// ─── Worktree centralization (pure path helpers) ─────────────────────

describe("Worktree centralization (project-flow §4.2)", () => {
	test("centralFeatureWorktreePath shape: {ZERO_CORE_DIR}/projects/{slug}/req-{shortId}", () => {
		// Requirement ids are UUIDs (no "req-" prefix); shortId = first 8 chars.
		const p = centralFeatureWorktreePath("Proj Alpha!", "1234567890abcdef");
		expect(p.startsWith(ZERO_CORE_DIR)).toBe(true);
		expect(p).toContain(join("projects", "proj-alpha"));
		expect(p.endsWith(join("req-12345678"))).toBe(true);
	});

	test("featureBranchName is req-{shortId}", () => {
		expect(featureBranchName("1234567890abcdef")).toBe("req-12345678");
	});

	test("featureWorktreePath prefers central when present, falls back to legacy otherwise", () => {
		const ws = join(tmpDir, "ws");
		const central = centralFeatureWorktreePath(PROJECT_ID, "abc12345xxxx");
		// No central dir yet → legacy path under {ws}.worktrees.
		const legacy = featureWorktreePath(ws, "abc12345xxxx", PROJECT_ID);
		expect(legacy).toBe(join(ws + ".worktrees", "req-abc12345"));

		// Create the central dir → central wins.
		mkdirSync(central, { recursive: true });
		const now = featureWorktreePath(ws, "abc12345xxxx", PROJECT_ID);
		expect(now).toBe(central);
	});

	test("featureWorktreePath without projectId is always legacy", () => {
		const ws = join(tmpDir, "ws");
		expect(featureWorktreePath(ws, "abc12345xxxx")).toBe(
			join(ws + ".worktrees", "req-abc12345"),
		);
	});
});

// ─── Flow.plan creates a worktree via gitIntegration (central path) ────

describe("Flow.plan · worktree creation via gitIntegration", () => {
	test("plan calls createFeatureWorktree WITH projectId + surfaces path on ctx.featureWorkspace", async () => {
		const id = seedReqAtBuildReady();
		const central = centralFeatureWorktreePath(PROJECT_ID, id);
		const createFeatureWorktree = vi.fn().mockResolvedValue({
			ok: true,
			worktreePath: central,
			branch: `req-${id.substring(0, 8)}`,
		});
		const ctx = buildCtx({ gitIntegration: { createFeatureWorktree } });

		const out = await execFlow({ action: "plan", id, plan: "p" } as any, ctx);

		expect(createFeatureWorktree).toHaveBeenCalledTimes(1);
		const [projectPath, requirementId, projectId] = createFeatureWorktree.mock.calls[0];
		expect(projectPath).toBe(workspaceDir);
		expect(requirementId).toBe(id);
		expect(projectId).toBe(PROJECT_ID);
		// ctx.featureWorkspace stamped with the central path.
		expect((ctx as any).featureWorkspace).toBe(central);
		expect(out).toContain(central);
		expect(requirementStore.get(id)!.status).toBe("plan");
	});

	test("gitIntegration absent → plan still transitions + writes Plan section (non-blocking)", async () => {
		const id = seedReqAtBuildReady();
		const out = await execFlow({ action: "plan", id, plan: "p" } as any, buildCtx());
		expect(out).toMatch(/Requirement plan:/);
		expect(requirementStore.get(id)!.status).toBe("plan");
		expect(readFileSync(docPath(id), "utf-8")).toContain("## Plan");
	});

	test("createFeatureWorktree fails → plan still transitions; note records failure", async () => {
		const id = seedReqAtBuildReady();
		const createFeatureWorktree = vi.fn().mockRejectedValue(new Error("no git"));
		const out = await execFlow(
			{ action: "plan", id, plan: "p" } as any,
			buildCtx({ gitIntegration: { createFeatureWorktree } }),
		);
		expect(out).toMatch(/Requirement plan:/);
		expect(out).toMatch(/worktree creation failed/);
		expect(requirementStore.get(id)!.status).toBe("plan");
	});
});

/** Walk a requirement to 'ready' (plan action's legal source). */
function seedReqAtBuildReady(): string {
	const req = requirementStore.create({
		projectId: PROJECT_ID,
		title: "Seed",
		description: "seed",
		status: "found",
		source: "analyst",
		priority: "normal",
		reviewer: "analyst",
	} as any);
	seedDoc(req.id, "found");
	requirementStore.transitionStatus(req.id, "discuss", "analyst", "seed");
	requirementStore.transitionStatus(req.id, "ready", "user", "seed");
	return req.id;
}

// ─── Delivery work template: hook = ready + Flow in prompt ────────────

describe("Delivery work template (builtin-work-templates) · F3", () => {
	test("需求管理 work hooks on requirements.ready (not create)", () => {
		const works = defaultProjectWorks(PROJECT_ID, "F3Proj");
		const delivery = works.find((w) => w.name === "需求管理")!;
		expect(delivery).toBeTruthy();
		expect(delivery.hooks).toEqual([
			{ event: "requirements.ready", collection: "requirements", enabled: true },
		]);
	});

	test("actionPrompt references the Flow actions (plan/startBuild/finishBuild/verify)", () => {
		const works = defaultProjectWorks(PROJECT_ID, "F3Proj");
		const delivery = works.find((w) => w.name === "需求管理")!;
		const prompt = delivery.actionPrompt;
		expect(prompt).toMatch(/Flow\.plan/);
		expect(prompt).toMatch(/Flow\.startBuild/);
		expect(prompt).toMatch(/Flow\.finishBuild/);
		expect(prompt).toMatch(/Flow\.verify/);
		// requiredTools includes Flow.
		expect(delivery.requiredTools).toContain("Flow");
	});
});

// ─── Old tools retired + RENAMED_TOOLS back-compat ───────────────────

describe("Old tools retired (F3) + RENAMED_TOOLS → Flow", () => {
	test("CreateRequirement / CreateRequirementWithDoc / verify absent from ALL_TOOLS", () => {
		expect(ALL_TOOLS.CreateRequirement).toBeUndefined();
		expect(ALL_TOOLS.CreateRequirementWithDoc).toBeUndefined();
		expect(ALL_TOOLS.verify).toBeUndefined();
		expect(ALL_TOOLS.Flow).toBeDefined();
	});

	test("RENAMED_TOOLS maps every legacy spelling to Flow", () => {
		for (const key of [
			"CreateRequirement",
			"create_requirement",
			"createrequirement",
			"CreateRequirementWithDoc",
			"create_requirement_with_doc",
			"createrequirementwithdoc",
			"verify",
			"Verify",
		]) {
			expect(RENAMED_TOOLS[key]).toBe("Flow");
		}
		// Unrelated mappings still intact.
		expect(RENAMED_TOOLS.bash).toBe("Shell");
		expect(RENAMED_TOOLS.wiki).toBe("Wiki");
	});
});
