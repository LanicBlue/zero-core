// M4 单元测试: session 路由 (agentId, projectId?) — ensureProjectSession
//
// # 文件说明书
//
// ## 核心功能
// 验证 M4 交付:
//   - management.ensureProjectSession(agentId, projectId): find-or-create,
//     续接(同 (agent, project) 复用同一 session)。
//   - 不同 project → 不同 session;同 project → 同 session。
//   - session.context.projectId 正确落库(渲染端据此按 project 命名/过滤)。
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { ProjectStore } from "../../src/server/project-store.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { ManagementService } from "../../src/server/management-service.js";
import { runMigrations } from "../../src/server/db-migration.js";

let tmpDir: string;
let sessionDB: SessionDB;
let projectStore: ProjectStore;
let agentStore: AgentStore;
let management: ManagementService;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-m4-route-"));
	const ws = join(tmpDir, "ws");
	mkdirSync(ws, { recursive: true });
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	agentStore = new AgentStore(sessionDB);
	management = new ManagementService({ agentStore, projectStore });
	management.setSessionDB(sessionDB);
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("ManagementService.ensureProjectSession — (agentId, projectId) routing", () => {
	test("creates a project session carrying context.projectId", () => {
		const project = projectStore.create({ name: "P1", workspaceDir: join(tmpDir, "p1") } as any);
		const r = management.ensureProjectSession("agt-1", project.id);
		expect(r.created).toBe(true);
		const s = sessionDB.getSession(r.sessionId)!;
		expect(s.context?.projectId).toBe(project.id);
		expect(s.context?.wikiRootNodeId).toBe(`wiki-root:${project.id}`);
	});

	test("reuses the same session on second call (find-or-create, 续接)", () => {
		const project = projectStore.create({ name: "P1", workspaceDir: join(tmpDir, "p1") } as any);
		const a = management.ensureProjectSession("agt-1", project.id);
		const b = management.ensureProjectSession("agt-1", project.id);
		expect(a.sessionId).toBe(b.sessionId);
		expect(b.created).toBe(false);
	});

	test("different projects → different sessions", () => {
		const p1 = projectStore.create({ name: "P1", workspaceDir: join(tmpDir, "p1") } as any);
		const p2 = projectStore.create({ name: "P2", workspaceDir: join(tmpDir, "p2") } as any);
		const a = management.ensureProjectSession("agt-1", p1.id);
		const b = management.ensureProjectSession("agt-1", p2.id);
		expect(a.sessionId).not.toBe(b.sessionId);
	});

	test("same project, different agents → different sessions (per-agent)", () => {
		const project = projectStore.create({ name: "P1", workspaceDir: join(tmpDir, "p1") } as any);
		const a = management.ensureProjectSession("agt-A", project.id);
		const b = management.ensureProjectSession("agt-B", project.id);
		expect(a.sessionId).not.toBe(b.sessionId);
	});
});
