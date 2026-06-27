// 单元测试: session 归档(soft-delete) — archiveSession + archived=0 过滤
//
// # 文件说明书
//
// ## 核心功能
// 验证 v0.8 session 归档:
//   - archiveSession 标记 archived=1,row 保留(getSession 仍可取,archived=true)。
//   - 归档后从活跃视图移除:listSessions/listAllSessions/getMainSession/
//     getMostRecentSession/findSessionByAgentAndProject 均不再命中。
//   - 归档后 ensureProjectSession 走 create 分支建新 session(同 projectId)。

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
	tmpDir = mkdtempSync(join(tmpdir(), "zero-archive-"));
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

describe("SessionDB.archiveSession — soft-delete + archived=0 filters", () => {
	test("archive marks archived=1 but keeps the row (getSession still works)", () => {
		const s = sessionDB.createSession("agt-1", "title");
		sessionDB.archiveSession(s.id);
		const got = sessionDB.getSession(s.id);
		expect(got).toBeDefined();
		expect(got!.archived).toBe(true);
	});

	test("archived session is excluded from listSessions / listAllSessions", () => {
		const a = sessionDB.createSession("agt-1", "a");
		const b = sessionDB.createSession("agt-1", "b");
		sessionDB.archiveSession(a.id);

		const listed = sessionDB.listSessions("agt-1").map((x) => x.id);
		expect(listed).toContain(b.id);
		expect(listed).not.toContain(a.id);

		const all = sessionDB.listAllSessions().map((x) => x.id);
		expect(all).not.toContain(a.id);
	});

	test("archived session is excluded from getMainSession / getMostRecentSession", () => {
		const s = sessionDB.createSession("agt-1");
		sessionDB.setMainSession("agt-1", s.id);
		expect(sessionDB.getMainSession("agt-1")?.id).toBe(s.id);

		sessionDB.archiveSession(s.id);
		expect(sessionDB.getMainSession("agt-1")).toBeUndefined();
		expect(sessionDB.getMostRecentSession("agt-1")?.id).not.toBe(s.id);
	});

	test("archived project session no longer matches findSessionByAgentAndProject", () => {
		const project = projectStore.create({ name: "P1", workspaceDir: join(tmpDir, "p1") } as any);
		const r = management.ensureProjectSession("agt-1", project.id);
		const sid = r.sessionId;

		expect(sessionDB.findSessionByAgentAndProject("agt-1", project.id)?.id).toBe(sid);

		sessionDB.archiveSession(sid);
		expect(sessionDB.findSessionByAgentAndProject("agt-1", project.id)).toBeUndefined();
	});

	test("after archiving, ensureProjectSession creates a NEW replacement session", () => {
		const project = projectStore.create({ name: "P1", workspaceDir: join(tmpDir, "p1") } as any);
		const first = management.ensureProjectSession("agt-1", project.id);
		sessionDB.archiveSession(first.sessionId);

		const second = management.ensureProjectSession("agt-1", project.id);
		expect(second.created).toBe(true);
		expect(second.sessionId).not.toBe(first.sessionId);
		// new one is active (not archived)
		expect(sessionDB.getSession(second.sessionId)!.archived).toBe(false);
	});

	test("archived session does not pollute getProjectResourceUsage", () => {
		const project = projectStore.create({ name: "P1", workspaceDir: join(tmpDir, "p1") } as any);
		const r = management.ensureProjectSession("agt-1", project.id);
		sessionDB.updateSessionUsage(r.sessionId, {
			inputTokens: 100, outputTokens: 50, totalTokens: 150,
			cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0.01,
		});

		const before = management.getProjectResourceUsage(project.id);
		expect(before.inputTokens).toBe(100);

		sessionDB.archiveSession(r.sessionId);
		const after = management.getProjectResourceUsage(project.id);
		expect(after.inputTokens).toBe(0);
		expect(after.sessionCount).toBe(0);
	});
});
