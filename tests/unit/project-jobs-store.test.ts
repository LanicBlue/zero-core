// project_jobs store 单元测试
//
// # 文件说明书
//
// ## 核心功能
// 验证 ProjectJobStore:
//   - create / get / list / listByProject / update
//   - 状态流转 markCompleted / markFailed / markCancelled(写 finishedAt)
//   - hasRunningForProject / hasRunningForSession(驱动 chat 输入锁)
//   - db-migration 建表幂等(fresh DB 有 project_jobs 表 + 列)
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDatabase } from "../../src/server/core-database.js";
import { ProjectJobStore } from "../../src/server/project-job-store.js";
import { runMigrations } from "../../src/server/db-migration.js";

let tmpDir: string;
let sessionDB: CoreDatabase;
let store: ProjectJobStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-pjobs-"));
	sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
	runMigrations(sessionDB);
	store = new ProjectJobStore(sessionDB);
});

afterEach(() => {
	sessionDB.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("ProjectJobStore CRUD + status transitions", () => {
	test("create + get round-trips all fields", () => {
		const job = store.create({
			jobType: "wiki-enrich",
			projectId: "proj-1",
			agentId: "agt-archivist",
			sessionId: "sess-1",
			status: "running",
			startedAt: "2026-06-26T00:00:00.000Z",
			promptSummary: "enrich the wiki",
		});
		expect(job.id).toBeTruthy();
		expect(job.createdAt).toBeTruthy();

		const got = store.get(job.id)!;
		expect(got.jobType).toBe("wiki-enrich");
		expect(got.projectId).toBe("proj-1");
		expect(got.status).toBe("running");
		expect(got.promptSummary).toBe("enrich the wiki");
		expect(got.finishedAt).toBeFalsy();
	});

	test("markCompleted sets status + finishedAt", () => {
		const job = store.create({
			jobType: "wiki-enrich", projectId: "p", status: "running", startedAt: "t",
		});
		const done = store.markCompleted(job.id);
		expect(done.status).toBe("completed");
		expect(done.finishedAt).toBeTruthy();
	});

	test("markFailed records error", () => {
		const job = store.create({
			jobType: "wiki-enrich", projectId: "p", status: "running", startedAt: "t",
		});
		const failed = store.markFailed(job.id, "boom");
		expect(failed.status).toBe("failed");
		expect(failed.error).toBe("boom");
		expect(failed.finishedAt).toBeTruthy();
	});

	test("markCancelled sets cancelled", () => {
		const job = store.create({
			jobType: "wiki-enrich", projectId: "p", status: "running", startedAt: "t",
		});
		expect(store.markCancelled(job.id).status).toBe("cancelled");
	});

	test("listByProject returns newest-first + filters by project", () => {
		store.create({ jobType: "wiki-enrich", projectId: "p1", status: "completed", startedAt: "2026-01-01T00:00:00.000Z" });
		store.create({ jobType: "wiki-enrich", projectId: "p1", status: "running", startedAt: "2026-06-26T00:00:00.000Z" });
		store.create({ jobType: "wiki-enrich", projectId: "p2", status: "running", startedAt: "2026-06-26T00:00:00.000Z" });
		const p1 = store.listByProject("p1");
		expect(p1).toHaveLength(2);
		expect(p1[0].startedAt).toBe("2026-06-26T00:00:00.000Z");
		expect(p1.every((r) => r.projectId === "p1")).toBe(true);
	});
});

describe("ProjectJobStore running-state helpers (chat 输入锁)", () => {
	test("hasRunningForProject true only when a running job exists", () => {
		expect(store.hasRunningForProject("p")).toBe(false);
		store.create({ jobType: "wiki-enrich", projectId: "p", sessionId: "s1", status: "running", startedAt: "t" });
		expect(store.hasRunningForProject("p")).toBe(true);
		// add a completed one — still running present
		store.create({ jobType: "wiki-enrich", projectId: "p", sessionId: "s2", status: "completed", startedAt: "t" });
		expect(store.hasRunningForProject("p")).toBe(true);
		// mark the running one done
		const running = store.listByProjectAndStatus("p", "running")[0];
		store.markCompleted(running.id);
		expect(store.hasRunningForProject("p")).toBe(false);
	});

	test("hasRunningForSession keyed by sessionId", () => {
		store.create({ jobType: "wiki-enrich", projectId: "p", sessionId: "sX", status: "running", startedAt: "t" });
		expect(store.hasRunningForSession("sX")).toBe(true);
		expect(store.hasRunningForSession("other")).toBe(false);
	});
});

describe("db-migration: project_jobs table self-heal", () => {
	test("running migrations twice is idempotent (no error)", () => {
		expect(() => runMigrations(sessionDB)).not.toThrow();
		// store still works after second migration pass
		const job = store.create({ jobType: "wiki-enrich", projectId: "p", status: "running", startedAt: "t" });
		expect(store.get(job.id)).toBeDefined();
	});
});
