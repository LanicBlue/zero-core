// 单元测试:/api/health 端点(自更新冒烟用)
//
// # 文件说明书
//
// ## 核心功能
// 测 GET /api/health 的字段聚合:DB 完整性/可写性、provider/agent 计数、workspace 存在性、版本、运行时长。
// health 端点从 server/index.ts 抽到 health-router.ts(依赖注入),本测试用 mock 依赖 + 真实 express
// 起随机端口验证端点行为,给自更新工作流 P4 冒烟门(db && dbWritable && providers>=1 && agents>=1)加回归保护。
//
// ## 输入
// mock 的 sessionDB(getDb → mock better-sqlite3 db)、providerStore/agentStore(list)、workspaceConfig(workspaceDir)
//
// ## 输出
// Vitest 用例:happy path 全字段、integrity 损坏、db 不可写、store 抛错兜底、workspace 不存在
//
// ## 定位
// tests/unit/ — server 层 health 端点回归保护(plan 自更新验证 #1)
//
// ## 依赖
// vitest、express、node:http、../../src/server/health-router.ts
//
// ## 维护规则
// health-router 返回字段变更需同步本测试断言 + scripts/self-update.cjs 的 P4 冒烟门
//

import { describe, test, expect, vi } from "vitest";
import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Helpers ────────────────────────────────────────────────

function listen(app: Express): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const server = createServer(app);
		server.listen(0, () => resolve({ server, port: (server.address() as { port: number }).port }));
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

async function request(port: number, path: string): Promise<{ status: number; data: any }> {
	const resp = await fetch(`http://localhost:${port}${path}`);
	const text = await resp.text();
	try { return { status: resp.status, data: JSON.parse(text) }; }
	catch { return { status: resp.status, data: text }; }
}

// mock better-sqlite3 Database(health 只用 pragma + exec)
function mockDb(opts: { integrity?: string; execThrows?: boolean } = {}) {
	return {
		pragma: vi.fn(() => [{ integrity_check: opts.integrity ?? "ok" }]),
		exec: vi.fn(() => { if (opts.execThrows) throw new Error("disk I/O error"); }),
	};
}

async function setupHealth(deps: any): Promise<{ server: Server; port: number }> {
	const { createHealthRouter } = await import("../../src/server/health-router.js");
	const app = express();
	app.use(express.json());
	app.use(createHealthRouter(deps));
	return listen(app);
}

// ─── Tests ──────────────────────────────────────────────────

describe("GET /api/health", () => {
	test("happy path: 全字段正确(db ok + writable + 计数 + version + workspace)", async () => {
		const db = mockDb(); // integrity ok, exec 不抛
		const { server, port } = await setupHealth({
			sessionDB: { getDb: () => db },
			providerStore: { list: () => [{ id: "p1" }, { id: "p2" }] },
			agentStore: { list: () => [{ id: "a1" }, { id: "a2" }, { id: "a3" }] },
			workspaceConfig: { workspaceDir: process.cwd() }, // 存在
		});
		try {
			const res = await request(port, "/api/health");
			expect(res.status).toBe(200);
			expect(res.data).toEqual(expect.objectContaining({
				ready: true,
				db: true,
				dbWritable: true,
				integrity: "ok",
				providers: 2,
				agents: 3,
				version: "0.1.0",
			}));
			expect(res.data.workspace).toEqual({ exists: true });
			expect(typeof res.data.uptimeMs).toBe("number");
			expect(res.data.uptimeMs).toBeGreaterThanOrEqual(0);
			// 确认实际调用了 db 探针(不是硬编码)
			expect(db.pragma).toHaveBeenCalledWith("integrity_check");
			expect(db.exec).toHaveBeenCalled();
		} finally { await close(server); }
	});

	test("integrity 损坏:db=false,integrity 反映问题(dbWritable 仍独立判定)", async () => {
		const db = mockDb({ integrity: "file is not a database" });
		const { server, port } = await setupHealth({
			sessionDB: { getDb: () => db },
			providerStore: { list: () => [{ id: "p1" }] },
			agentStore: { list: () => [{ id: "a1" }] },
			workspaceConfig: { workspaceDir: process.cwd() },
		});
		try {
			const res = await request(port, "/api/health");
			expect(res.status).toBe(200);
			expect(res.data.db).toBe(false);
			expect(res.data.integrity).toBe("file is not a database");
			// exec 仍成功 → dbWritable 与 integrity 独立
			expect(res.data.dbWritable).toBe(true);
		} finally { await close(server); }
	});

	test("db 不可写:exec 抛 → dbWritable=false(自更新冒烟门此处应判失败)", async () => {
		const db = mockDb({ execThrows: true }); // integrity ok, exec 抛
		const { server, port } = await setupHealth({
			sessionDB: { getDb: () => db },
			providerStore: { list: () => [{ id: "p1" }] },
			agentStore: { list: () => [{ id: "a1" }] },
			workspaceConfig: { workspaceDir: process.cwd() },
		});
		try {
			const res = await request(port, "/api/health");
			expect(res.status).toBe(200);
			expect(res.data.dbWritable).toBe(false);
			expect(res.data.db).toBe(true); // integrity 仍 ok,与可写性正交
			expect(res.data.integrity).toBe("ok");
		} finally { await close(server); }
	});

	test("store.list 抛错:providers/agents 兜底为 0(端点不 500)", async () => {
		const db = mockDb();
		const { server, port } = await setupHealth({
			sessionDB: { getDb: () => db },
			providerStore: { list: () => { throw new Error("store locked"); } },
			agentStore: { list: () => { throw new Error("store locked"); } },
			workspaceConfig: { workspaceDir: process.cwd() },
		});
		try {
			const res = await request(port, "/api/health");
			expect(res.status).toBe(200);
			expect(res.data.providers).toBe(0);
			expect(res.data.agents).toBe(0);
		} finally { await close(server); }
	});

	test("workspace 不存在:workspace.exists=false", async () => {
		const db = mockDb();
		const { server, port } = await setupHealth({
			sessionDB: { getDb: () => db },
			providerStore: { list: () => [] },
			agentStore: { list: () => [] },
			workspaceConfig: { workspaceDir: join(tmpdir(), "zc-health-nonexistent-xyz") },
		});
		try {
			const res = await request(port, "/api/health");
			expect(res.status).toBe(200);
			expect(res.data.workspace).toEqual({ exists: false });
		} finally { await close(server); }
	});
});
