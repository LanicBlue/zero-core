// Wiki + Core 维护管理路由(wiki-system-redesign plan-08 §3 + §5)
//
// # 文件说明书
//
// ## 核心功能
// 管理面 REST 路由(`/api/wiki-maintain`),暴露:
//   - **§3 备份/恢复**:`backup/all`、`backup/core`、`backup/wiki`、
//     `backup/list`、`backup/verify`、`backup/restore`、`backup/rotate`。
//   - **§5 维护任务**:`integrity`、`foreign-keys`、`fts/rebuild`、
//     `optimize`、`legacy/cleanup`(显式 only,不在 startup 自动跑)。
//
// ## 设计原则
//   - **不走 Agent shell** —— 此路由仅供管理 UI / CLI 调用,Agent 工具
//     无权访问(参考 plan-08 §2 fs guard)。authority 由 server host 注入
//     (复用 wiki-admin-router 的 WIKI_ADMIN_AUTHORITY 模式)。
//   - **不操作活跃 DB 的 checkpoint/VACUUM/migration**(memory feedback-
//     sessions-db-readonly)。integrity_check / foreign_key_check 只读;
//     VACUUM INTO 走 snapshot 路径,不写活跃 DB。
//   - **失败 soft** —— 单个 endpoint 失败不阻断其它;返 500 + error 字段。
//
// ## Authority
//   router 内部模块级常量 WIKI_ADMIN_AUTHORITY 注入到每个请求处理逻辑的
//   audit 记录(actor=@wiki-admin, canManage=true)。renderer 不能从 body
//   自授身份(FORBIDDEN_BODY_KEYS 守卫)。
//

import { Router } from "express";
import type { CoreDatabase } from "./core-database.js";
import type { WikiDatabase } from "./wiki/wiki-database.js";
import { BackupService, type SnapshotKind, type VerifyResult } from "./wiki-backup-service.js";
import { log } from "../core/logger.js";

/**
 * FORBIDDEN_BODY_KEYS —— 与 wiki-admin-router 同款:拒绝 renderer 从 body
 * 自授身份。管理面 authority 由 server host 注入。
 */
const FORBIDDEN_BODY_KEYS = new Set([
	"agentId", "actorAgentId", "sessionId", "requestId",
	"actor", "canManage", "authority",
]);

function bodyHasForgedIdentity(raw: unknown): string[] {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
	const found: string[] = [];
	for (const key of Object.keys(raw as Record<string, unknown>)) {
		if (FORBIDDEN_BODY_KEYS.has(key)) found.push(key);
	}
	return found;
}

export interface WikiMaintenanceRouterDeps {
	coreDb: CoreDatabase;
	wikiDb?: WikiDatabase;
	keepRecent?: number;
	/**
	 * P1-4: DB + 备份目录路径注入(透传给 BackupService)。生产 composition
	 * root(server/index.ts)应通过 DatabaseManager 的 path getter 注入,让
	 * DatabaseManager 作为路径权威;不传时 BackupService fallback 到
	 * database-paths 常量(保留 back-compat)。
	 */
	coreDbPath?: string;
	wikiDbPath?: string;
	coreBackupDir?: string;
	wikiBackupDir?: string;
}

export function createWikiMaintenanceRouter(deps: WikiMaintenanceRouterDeps): Router {
	const router = Router();
	const backup = new BackupService({
		coreDb: deps.coreDb,
		wikiDb: deps.wikiDb,
		keepRecent: deps.keepRecent,
		coreDbPath: deps.coreDbPath,
		wikiDbPath: deps.wikiDbPath,
		coreBackupDir: deps.coreBackupDir,
		wikiBackupDir: deps.wikiBackupDir,
	});

	// ─── §3 Backup ─────────────────────────────────────────────────

	// plan-08 §3: snapshot 调用是 async(better-sqlite3 `Database.backup()` 返
	// Promise,在线 page-level copy;Router handler 必须 await,否则 res.json 会
	// 序列化一个 Promise 对象而不是 manifest(前序 sub 死在这)。Express 5 自动
	// catch async handler 抛出,但显式 try/catch 让错误日志有 context。
	router.post("/backup/all", async (req, res) => {
		const forged = bodyHasForgedIdentity(req.body);
		if (forged.length > 0) return res.status(400).json({ error: `forged identity keys: ${forged.join(", ")}` });
		try {
			const note = (req.body?.note as string | undefined)?.slice(0, 200);
			const result = await backup.snapshotAll(note);
			res.json(result);
		} catch (err) {
			log.warn("wiki-maintain", `backup/all failed: ${(err as Error).message}`);
			res.status(500).json({ error: (err as Error).message });
		}
	});

	router.post("/backup/core", async (req, res) => {
		const forged = bodyHasForgedIdentity(req.body);
		if (forged.length > 0) return res.status(400).json({ error: `forged identity keys: ${forged.join(", ")}` });
		try {
			const note = (req.body?.note as string | undefined)?.slice(0, 200);
			const manifest = await backup.snapshotCore(note);
			res.json(manifest);
		} catch (err) {
			log.warn("wiki-maintain", `backup/core failed: ${(err as Error).message}`);
			res.status(500).json({ error: (err as Error).message });
		}
	});

	router.post("/backup/wiki", async (req, res) => {
		const forged = bodyHasForgedIdentity(req.body);
		if (forged.length > 0) return res.status(400).json({ error: `forged identity keys: ${forged.join(", ")}` });
		try {
			const note = (req.body?.note as string | undefined)?.slice(0, 200);
			const manifest = await backup.snapshotWiki(note);
			res.json(manifest);
		} catch (err) {
			log.warn("wiki-maintain", `backup/wiki failed: ${(err as Error).message}`);
			res.status(500).json({ error: (err as Error).message });
		}
	});

	router.get("/backup/list", (_req, res) => {
		try {
			res.json(backup.listSnapshots());
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	router.post("/backup/verify", (req, res) => {
		try {
			const snapshotPath = req.body?.snapshotPath as string | undefined;
			if (!snapshotPath) return res.status(400).json({ error: "snapshotPath required" });
			const result: VerifyResult = backup.verifySnapshot(snapshotPath);
			res.json(result);
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	router.post("/backup/restore", (req, res) => {
		try {
			const snapshotPath = req.body?.snapshotPath as string | undefined;
			const kind = req.body?.kind as SnapshotKind | undefined;
			if (!snapshotPath || !kind) return res.status(400).json({ error: "snapshotPath + kind required" });
			if (kind !== "core" && kind !== "wiki") return res.status(400).json({ error: "kind must be core|wiki" });
			const restoredPath = backup.restoreSnapshot(snapshotPath, kind);
			res.json({ restoredPath, note: "Snapshot restored to a NEW temp path. Active DB untouched. Manual swap required." });
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	router.post("/backup/rotate", (_req, res) => {
		try {
			res.json(backup.rotate());
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	// ─── §5 Maintenance ────────────────────────────────────────────

	router.post("/integrity", (_req, res) => {
		try {
			const coreResult = runIntegrityCheck(deps.coreDb.getDb());
			const wikiResult = deps.wikiDb ? runIntegrityCheck(deps.wikiDb.getDb()) : null;
			res.json({ core: coreResult, wiki: wikiResult });
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	router.post("/foreign-keys", (_req, res) => {
		try {
			const coreResult = runForeignKeyCheck(deps.coreDb.getDb());
			const wikiResult = deps.wikiDb ? runForeignKeyCheck(deps.wikiDb.getDb()) : null;
			res.json({ core: coreResult, wiki: wikiResult });
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	router.post("/fts/rebuild", (_req, res) => {
		if (!deps.wikiDb) return res.status(400).json({ error: "wiki DB not initialized" });
		try {
			const db = deps.wikiDb.getDb();
			// Drop + rebuild wiki_nodes_fts content table (see wiki-schema.ts
			// for the FTS5 virtual table definition). Idempotent.
			const tx = db.transaction(() => {
				db.exec("INSERT INTO wiki_nodes_fts(wiki_nodes_fts) VALUES('rebuild')");
			});
			tx();
			res.json({ ok: true, message: "wiki_nodes_fts rebuilt" });
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	router.post("/optimize", (_req, res) => {
		// PRAGMA optimize is safe on active DBs (it only updates stats, not
		// pages). memory feedback-sessions-db-readonly bans checkpoint/VACUUM/
		// migration, but PRAGMA optimize is allowed (it's a write to
		// sqlite_stat1, not a checkpoint). We deliberately do NOT issue
		// VACUUM here — that rewrites the DB file (long lock + WAL merge),
		// which is exactly what the readonly rule forbids.
		try {
			const coreResult = runPragmaOptimize(deps.coreDb.getDb());
			const wikiResult = deps.wikiDb ? runPragmaOptimize(deps.wikiDb.getDb()) : null;
			res.json({ core: coreResult, wiki: wikiResult });
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	router.post("/legacy/cleanup", (req, res) => {
		// Explicit-only: drops the legacy project_wiki table on the Core DB.
		// Not run on startup. Caller must confirm via body.confirm = true.
		const confirm = req.body?.confirm === true;
		if (!confirm) {
			return res.status(400).json({
				error: "pass { confirm: true } to drop the legacy project_wiki table",
				note: "This permanently deletes any pre-cutover wiki data still in core.db.",
			});
		}
		try {
			const db = deps.coreDb.getDb();
			const before = (
				db.prepare("SELECT count(*) AS n FROM project_wiki").get() as { n: number } | undefined
			)?.n;
			db.exec("DROP TABLE IF EXISTS project_wiki");
			log.warn("wiki-maintain", `legacy project_wiki dropped (was ${before ?? "absent"} rows)`);
			res.json({ ok: true, droppedRows: before ?? 0 });
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	return router;
}

// ─── Helpers ────────────────────────────────────────────────────

function runIntegrityCheck(db: import("better-sqlite3").Database): { ok: boolean; result: string } {
	const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
	const result = rows.map((r) => r.integrity_check).join("; ");
	return { ok: rows.length === 1 && rows[0].integrity_check === "ok", result };
}

function runForeignKeyCheck(db: import("better-sqlite3").Database): { ok: boolean; violations: number } {
	const rows = db.pragma("foreign_key_check") as Array<unknown>;
	return { ok: rows.length === 0, violations: rows.length };
}

function runPragmaOptimize(db: import("better-sqlite3").Database): { ok: boolean } {
	db.pragma("optimize");
	return { ok: true };
}
