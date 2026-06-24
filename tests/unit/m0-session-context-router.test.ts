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
//   - ManagementService.instantiateTemplate (一键实例化 + subagents 接好)
//   - ManagementService.updateAgent (consolidates toolPolicy)
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
import {
	resolveSessionByRoleProject,
	buildProjectBundle,
	defaultWikiRootResolver,
} from "../../src/server/session-context-router.js";
import { ManagementService } from "../../src/server/management-service.js";
import { TemplateStore } from "../../src/server/template-store.js";
import { runMigrations } from "../../src/server/db-migration.js";
// v0.8 P0 (§1.4 过渡期): roleTag 不再走 store round-trip;测试需要带 role_tag
// 的 agent 时直接写物理列。
import { seedAgentWithRoleTag } from "./helpers/p0-test-helpers.js";

let tmpDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let templateStore: TemplateStore;
let management: ManagementService;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-m0-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	templateStore = new TemplateStore(sessionDB);
	management = new ManagementService({ agentStore, projectStore, templateStore });
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

// ─── Templates (能力模板) vs Roles (工作流角色) ──────────────

describe("capability templates (gallery) — no workflow roles mixed in", () => {
	test("gallery holds the 16 capability templates (general + domain experts)", () => {
		const names = new Set(templateStore.list().map((t) => t.name));
		// 通用能力(12)
		for (const n of ["Coder", "Writer", "Translator", "Reviewer", "Analyst", "Tutor",
			"Creative", "Researcher", "Collector", "DevOps", "Product Manager", "Architect"]) {
			expect(names.has(n), `${n} should be in gallery`).toBe(true);
		}
		// 领域专家(4,由 analyzer/qa 重构)
		for (const n of ["Security Expert", "UI/UX Expert", "Performance Expert", "QA Engineer"]) {
			expect(names.has(n), `${n} should be in gallery`).toBe(true);
		}
		expect(templateStore.list().length).toBe(16);
	});

	test("workflow roles are NOT in the gallery (templates unrelated to roles)", () => {
		const names = new Set(templateStore.list().map((t) => t.name));
		// zero/lead/archivist 是工作流角色,退出画廊;developer/reviewer/pm/qa 已由
		// 同名能力等价物覆盖,不再作为独立 role 出现。
		for (const n of ["Zero (管理)", "Lead (交付)", "Archivist (知识)", "Developer", "Reviewer (workflow)"]) {
			expect(names.has(n), `${n} should NOT be in gallery`).toBe(false);
		}
	});

	test("built-in capability templates are idempotent across repeated TemplateStore construction", () => {
		const beforeCount = templateStore.list().length;
		const store2 = new TemplateStore(sessionDB);
		expect(store2.list().length).toBe(beforeCount);
	});

	test("domain-expert capability templates carry toolPolicy.autoApprove", () => {
		const sec = templateStore.list().find((t) => t.name === "Security Expert");
		expect(sec?.toolPolicy?.autoApprove).toContain("Read");
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

	test("instantiateRole seeds the platform role (zero) — general, no workflow specifics", () => {
		// v0.8 ADR-020:代码只留平台级角色(zero)。software-dev 工作流角色
		// (lead/archivist/...)是工作流知识,在 wiki playbook 里,不在代码;
		// instantiateRole 只认平台角色。
		const zero = management.instantiateRole("zero", { name: "MyZero" });

		expect(zero.name).toBe("MyZero");
		expect(zero.systemPrompt).toContain("zero");
		// zero 是通用平台管家,不硬编码 software-dev 工作流细节。
		expect(zero.systemPrompt).toMatch(/general workflow/i);
		expect(zero.toolPolicy?.tools?.AgentRegistry?.enabled).toBe(true);
		expect(zero.subagents ?? []).toEqual([]);
	});

	test("instantiateRole throws on a software-dev role id (those live in wiki, not code)", () => {
		// lead/archivist 是 software-dev 工作流角色,代码里没有。
		expect(() => management.instantiateRole("lead")).toThrow(/Unknown workflow role/);
		expect(() => management.instantiateRole("archivist")).toThrow(/Unknown workflow role/);
	});

	test("instantiateTemplate (capability gallery) throws on a role id (roles are not templates)", () => {
		expect(() => management.instantiateTemplate("zero")).toThrow(/Unknown template/);
	});

	// v0.8 §11.5: exposeAgentAsTool / cascade-agent-tool-entries tests removed
	// (agent-as-tool retired; AgentToolStore dropped).
});
