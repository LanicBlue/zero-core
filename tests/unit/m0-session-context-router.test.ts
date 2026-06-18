// M0 单元测试：身份/上下文分离地基
//
// # 文件说明书
//
// ## 核心功能
// 验证 M0 的核心交付 (acceptance-M0.md):
//   - resolveSessionByRoleProject: find-or-create 路由 (同一 PM agent 服务多 project)
//   - bundle 继承 (per-call override)
//   - SessionDB context 列持久化
//   - role-presets (lead/PM/archivist/analyzer/planner/dev/review/qa/zero)
//   - ManagementService.instantiateTemplate (一键实例化 + toolPolicy 接好)
//   - ManagementService.updateAgent (consolidates toolPolicy) / exposeAgentAsTool
//   - ProjectStore workspaceDir 唯一约束 + 不可改
//
// ## 输入
// 临时 SessionDB (mkdtempSync) + 真实 stores。
//
// ## 输出
// Vitest 用例。
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { AgentToolStore } from "../../src/server/agent-tool-store.js";
import {
	resolveSessionByRoleProject,
	buildProjectBundle,
	defaultWikiRootResolver,
} from "../../src/server/session-context-router.js";
import { ManagementService } from "../../src/server/management-service.js";
import { ROLE_PRESETS, getPreset, listPresets, buildAgentFromPreset } from "../../src/runtime/role-templates.js";
import { runMigrations } from "../../src/server/db-migration.js";
// v0.8 P0 (§1.4 过渡期): roleTag 不再走 store round-trip;测试需要带 role_tag
// 的 agent 时直接写物理列。
import { seedAgentWithRoleTag } from "./helpers/p0-test-helpers.js";

let tmpDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let agentToolStore: AgentToolStore;
let management: ManagementService;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-m0-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	agentToolStore = new AgentToolStore(sessionDB);
	management = new ManagementService({ agentStore, projectStore, agentToolStore });
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Data layer ─────────────────────────────────────────────

describe("M0 data layer", () => {
	test("AgentRecord persists roleTag (legacy physical column)", () => {
		// v0.8 P0 (§1.4): roleTag removed from AgentRecord type; store no
		// longer round-trips it. The physical `role_tag` column is retained
		// and AgentStore.listByRoleTag reads it raw. Test seeds it directly.
		const agent = agentStore.create({ name: "Test PM" } as any);
		seedAgentWithRoleTag(sessionDB, agent.id, "pm");
		// Type no longer exposes roleTag — but listByRoleTag finds the row
		// via the legacy physical column.
		expect(agentStore.listByRoleTag("pm").map((a) => a.id)).toContain(agent.id);
	});

	test("AgentStore.listByRoleTag filters by tag", () => {
		const a1 = agentStore.create({ name: "PM1" } as any);
		seedAgentWithRoleTag(sessionDB, a1.id, "pm");
		const a2 = agentStore.create({ name: "Lead1" } as any);
		seedAgentWithRoleTag(sessionDB, a2.id, "lead");
		const a3 = agentStore.create({ name: "PM2" } as any);
		seedAgentWithRoleTag(sessionDB, a3.id, "pm");
		expect(agentStore.listByRoleTag("pm").length).toBe(2);
		expect(agentStore.listByRoleTag("lead").length).toBe(1);
	});

	test("ProjectRecord has only slim fields", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "ws1") });
		expect(Object.keys(proj).sort()).toEqual(["createdAt", "id", "name", "updatedAt", "workspaceDir"].sort());
	});

	test("ProjectStore workspaceDir uniqueness", () => {
		const ws = join(tmpDir, "ws-shared");
		projectStore.create({ name: "P1", workspaceDir: ws });
		expect(() => projectStore.create({ name: "P2", workspaceDir: ws })).toThrow(/already bound/);
	});

	test("ProjectStore workspaceDir immutable on update", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "ws1") });
		// Attempt to change workspaceDir — should be silently ignored
		const updated = projectStore.update(proj.id, { workspaceDir: join(tmpDir, "ws2") } as any);
		expect(updated.workspaceDir).toBe(proj.workspaceDir);
	});

	test("SessionRecord carries context bundle", () => {
		const session = sessionDB.createSession("pm-1", "test", {
			projectId: "proj-1",
			workspaceDir: "/tmp/ws",
			wikiRootNodeId: "wiki-root:proj-1",
		});
		expect(session.context?.projectId).toBe("proj-1");
		expect(session.context?.workspaceDir).toBe("/tmp/ws");
		expect(session.context?.wikiRootNodeId).toBe("wiki-root:proj-1");

		// Reload from DB
		const fetched = sessionDB.getSession(session.id);
		expect(fetched?.context?.projectId).toBe("proj-1");
	});
});

// ─── Bundle routing ─────────────────────────────────────────

describe("resolveSessionByRoleProject", () => {
	let projA: any, projB: any;

	beforeEach(() => {
		projA = projectStore.create({ name: "ProjA", workspaceDir: join(tmpDir, "wsA") });
		projB = projectStore.create({ name: "ProjB", workspaceDir: join(tmpDir, "wsB") });
	});

	test("creates new session on first call, reuses on second (same PM, same project)", () => {
		const deps = { sessionDB, projectStore };
		const r1 = resolveSessionByRoleProject(deps, "pm-global", projA.id);
		expect(r1.created).toBe(true);

		const r2 = resolveSessionByRoleProject(deps, "pm-global", projA.id);
		expect(r2.created).toBe(false);
		expect(r2.session.id).toBe(r1.session.id);
	});

	test("one global PM agent serves two projects via two sessions", () => {
		const deps = { sessionDB, projectStore };
		const a = resolveSessionByRoleProject(deps, "pm-global", projA.id);
		const b = resolveSessionByRoleProject(deps, "pm-global", projB.id);
		expect(a.session.id).not.toBe(b.session.id);
		expect(a.session.context?.projectId).toBe(projA.id);
		expect(b.session.context?.projectId).toBe(projB.id);
	});

	test("bundle carries project workspaceDir + wiki root", () => {
		const deps = { sessionDB, projectStore };
		const r = resolveSessionByRoleProject(deps, "pm-global", projA.id);
		expect(r.session.context?.workspaceDir).toBe(projA.workspaceDir);
		expect(r.session.context?.wikiRootNodeId).toBe(defaultWikiRootResolver(projA.id));
	});

	test("per-call bundle override narrows workspace", () => {
		const deps = { sessionDB, projectStore };
		const r = resolveSessionByRoleProject(deps, "pm-global", projA.id, {
			bundleOverride: { workspaceDir: join(projA.workspaceDir, "subdir") },
		});
		expect(r.session.context?.workspaceDir).toBe(join(projA.workspaceDir, "subdir"));
		// projectId override is ignored — it's the lookup key
		expect(r.session.context?.projectId).toBe(projA.id);
	});

	test("findSessionByAgentAndProject matches by (agentId, projectId)", () => {
		resolveSessionByRoleProject({ sessionDB, projectStore }, "pm-x", projA.id);
		const found = sessionDB.findSessionByAgentAndProject("pm-x", projA.id);
		expect(found).toBeDefined();
		// Different agent — no match
		expect(sessionDB.findSessionByAgentAndProject("pm-y", projA.id)).toBeUndefined();
	});

	test("buildProjectBundle throws on unknown project", () => {
		expect(() => buildProjectBundle({ projectStore }, "does-not-exist")).toThrow(/not found/);
	});
});

// ─── Role presets ───────────────────────────────────────────

describe("role presets", () => {
	test("all expected coding-scenario presets exist", () => {
		const ids = ROLE_PRESETS.map((p) => p.roleTag);
		expect(new Set(ids)).toEqual(new Set([
			"lead", "pm", "archivist", "analyzer", "planner", "developer", "reviewer", "qa", "zero",
		]));
	});

	test("analyzer has multiple lenses", () => {
		const analyzers = listPresets("analyzer");
		expect(analyzers.length).toBeGreaterThanOrEqual(4);
		expect(analyzers.map((a) => a.id)).toContain("analyzer-architecture");
	});

	test("planner has multiple domains", () => {
		const planners = listPresets("planner");
		expect(planners.length).toBeGreaterThanOrEqual(4);
	});

	test("lead whitelists planner/dev/review/qa", () => {
		const lead = getPreset("lead");
		expect(lead?.whitelistedRoleTags).toEqual(
			expect.arrayContaining(["planner", "developer", "reviewer", "qa"]),
		);
	});

	test("PM whitelists analyzer", () => {
		const pm = getPreset("pm");
		expect(pm?.whitelistedRoleTags).toEqual(["analyzer"]);
	});

	test("archivist whitelists analyzer", () => {
		const archivist = getPreset("archivist");
		expect(archivist?.whitelistedRoleTags).toEqual(["analyzer"]);
	});

	test("buildAgentFromPreset produces AgentRecord-shaped input (no roleTag — RFC §1.4)", () => {
		// v0.8 P6 (RFC §1.4): agent identity = name + systemPrompt; the template's
		// roleTag is organization metadata and is NOT propagated onto the built
		// agent. The deprecated `buildAgentFromPreset` alias forwards to
		// `buildAgentFromTemplate` which omits roleTag.
		const input = buildAgentFromPreset("pm", { name: "MyPM" });
		expect(input.name).toBe("MyPM");
		expect((input as any).roleTag).toBeUndefined();
		expect(input.systemPrompt).toContain("PM");
		expect(input.toolPolicy).toBeDefined();
	});

	test("presets carry M0 degradation notes for incomplete-mechanism roles", () => {
		// PM/lead/archivist/zero have downstream M dependencies; their presets
		// should honestly flag the M0 degradation.
		for (const id of ["lead", "pm", "archivist", "zero"]) {
			const preset = getPreset(id);
			expect(preset?.m0DegradedNote, `${id} should have m0DegradedNote`).toBeTruthy();
		}
	});
});

// ─── ManagementService ───────────────────────────────────────

describe("ManagementService", () => {
	test("createProject / listProjects / deleteProject", () => {
		const p = management.createProject({ name: "P", workspaceDir: join(tmpDir, "x") });
		expect(management.listProjects().length).toBe(1);
		management.deleteProject(p.id);
		expect(management.listProjects().length).toBe(0);
	});

	test("createAgent + updateAgent (consolidates toolPolicy — P3 §7.3 replaces setToolPolicy/setToolEnabled)", () => {
		const a = management.createAgent({ name: "A" } as any);
		// v0.8 P3: setToolPolicy + setToolEnabled collapsed into a single
		// updateAgent toolPolicy patch (the Agent update action surface).
		management.updateAgent(a.id, {
			toolPolicy: { executionMode: "parallel", tools: { Read: { enabled: true } } },
		});
		const updated = management.getAgent(a.id);
		expect(updated?.toolPolicy?.executionMode).toBe("parallel");
		expect(updated?.toolPolicy?.tools?.Read?.enabled).toBe(true);
	});

	test("instantiateTemplate wires whitelisted callee roles into toolPolicy (by entry.id)", () => {
		// First create some callee role agents (analyzer, planner, dev, etc.)
		// v0.8 P0 (§1.4): roleTag no longer round-trips via store; seed the
		// physical column so ensureRoleAgentExposed's listByRoleTag finds them.
		for (const [name, tag] of [
			["Analyzer-A", "analyzer"],
			["Planner-A", "planner"],
			["Dev-A", "developer"],
			["Reviewer-A", "reviewer"],
			["QA-A", "qa"],
		] as const) {
			const a = management.createAgent({ name } as any);
			seedAgentWithRoleTag(sessionDB, a.id, tag);
		}

		// Expose them (lead's toolPolicy references expose entries)
		// v0.8 P3: instantiatePreset renamed to instantiateTemplate (the
		// Agent.create + template path's service-side counterpart).
		const lead = management.instantiateTemplate("lead", { name: "MyLead" });
		// v0.8 P0 (§1.4): roleTag is gone from AgentRecord; lead's identity is
		// name+systemPrompt. The built preset still carries roleTag as a legacy
		// side-channel via buildAgentFromPreset, but it is NOT on the persisted
		// record. Skip the roleTag assertion on the persisted record.

		// toolPolicy.tools should now have entries keyed by AgentToolEntry.id
		// (at least one for each whitelisted roleTag)
		const tools = lead.toolPolicy?.tools ?? {};
		const enabledKeys = Object.keys(tools).filter((k) => tools[k].enabled);

		// Built-in tools (Shell/Read/Grep/Glob) are name-keyed; the agent-tool
		// callee references are keyed by entry.id (decision 2). Separate them.
		const BUILTIN = new Set(["Shell", "Read", "Write", "Edit", "Grep", "Glob"]);
		const agentToolKeys = enabledKeys.filter((k) => !BUILTIN.has(k));
		expect(agentToolKeys.length).toBeGreaterThanOrEqual(4); // planner/dev/review/qa

		// Each agent-tool policy key should correspond to a real AgentToolEntry id
		const allEntries = agentToolStore.list();
		for (const key of agentToolKeys) {
			expect(allEntries.find((e) => e.id === key), `key ${key} should match an AgentToolEntry id`).toBeDefined();
		}
	});

	test("exposeAgentAsTool is idempotent", () => {
		const a = management.createAgent({ name: "Exposed" } as any);
		const e1 = management.exposeAgentAsTool(a.id, { name: "exposed-tool" });
		const e2 = management.exposeAgentAsTool(a.id, { name: "exposed-tool" });
		expect(e1.id).toBe(e2.id);
	});

	test("deleteAgent cascades agent-tool entries", () => {
		const a = management.createAgent({ name: "Cascade" } as any);
		management.exposeAgentAsTool(a.id, { name: "cascade-tool" });
		expect(agentToolStore.list().length).toBeGreaterThanOrEqual(1);
		management.deleteAgent(a.id);
		expect(agentToolStore.list().find((e) => e.agentId === a.id)).toBeUndefined();
	});
});
