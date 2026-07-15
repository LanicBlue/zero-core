// Health 端点 — 业务活络探针(自更新冒烟用)
//
// # 文件说明书
//
// ## 核心功能
// 提供 GET /api/health,聚合 DB 完整性/可写性、provider/agent 计数、workspace 存在性、
// 版本与运行时长,供自更新工作流 P4 staging 冒烟判断新版后端是否真正可用。
// /api/ready 只代表 HTTP 已 listen,本端点代表"业务就绪"。
//
// ## 输入
// sessionDB(提供 getDb → better-sqlite3 Database)、providerStore/agentStore(提供 list)、
// workspaceConfig(workspaceDir),均由 server/index.ts createServer 注入。
//
// ## 输出
// GET /api/health → { ready, db, dbWritable, integrity, providers, agents, workspace:{exists}, version, uptimeMs }
//
// ## 定位
// src/server/ 服务层;从 server/index.ts 抽出为独立 router,便于单测(依赖注入)。
//
// ## 依赖
// express Router;node:fs/path/url(读 package.json 版本 + workspace 存在性)。
//
// ## 维护规则
// - 自更新 self-update.cjs 的 P4 冒烟门依赖 db && dbWritable && providers>=1 && agents>=1,
//   改动返回字段需同步 scripts/self-update.cjs 的 healthCheck 校验。
//

import { Router } from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "node:fs";

export function createHealthRouter(deps: {
	sessionDB: { getDb(): { pragma(sql: string): unknown; exec(sql: string): void } };
	providerStore: { list(): unknown[] };
	agentStore: { list(): unknown[] };
	workspaceConfig: { workspaceDir: string };
}) {
	const router = Router();
	const { sessionDB, providerStore, agentStore, workspaceConfig } = deps;

	// Health endpoint — 业务活络(自更新冒烟用);/api/ready 只代表 HTTP listen
	router.get("/api/health", (_req, res) => {
		const db = sessionDB.getDb();
		let integrity = "ok";
		let dbOk = false;
		try {
			const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
			integrity = rows.map((r) => r.integrity_check).join("; ");
			dbOk = integrity === "ok";
		} catch (e: any) {
			integrity = "error: " + (e?.message ?? String(e));
		}
		let dbWritable = false;
		try {
			db.exec("BEGIN; CREATE TEMP TABLE IF NOT EXISTS _health_probe(x); INSERT INTO _health_probe VALUES(1); ROLLBACK;");
			dbWritable = true;
		} catch { /* db not writable */ }
		let providers = 0;
		let agents = 0;
		try { providers = providerStore.list().length; } catch { /* empty */ }
		try { agents = agentStore.list().length; } catch { /* empty */ }
		let version = "unknown";
		try {
			const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
			version = JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "unknown";
		} catch { /* unknown */ }
		res.json({
			ready: true,
			db: dbOk,
			dbWritable,
			integrity,
			providers,
			agents,
			workspace: { exists: existsSync(workspaceConfig.workspaceDir) },
			version,
			uptimeMs: Math.round(process.uptime() * 1000),
		});
	});

	return router;
}
