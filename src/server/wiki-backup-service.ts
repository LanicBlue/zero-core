// Wiki + Core 备份/完整性服务(wiki-system-redesign plan-08 §3)
//
// # 文件说明书
//
// ## 核心功能
// 管理级 snapshot:
//   - 用 SQLite Backup API 把活跃 core.db / wiki.db **在线** snapshot 到
//     `${ZERO_CORE_DIR}/backups/core/` 与 `${ZERO_CORE_DIR}/backups/wiki/`,
//     各自独立(不跨库事务)。
//   - snapshot 写一个 manifest(sidecar JSON):source 路径、生成时间、schema
//     version、SHA-256(整文件)、业务 revision(core=最大 agents.wiki_policy_revision /
//     wiki=max(wiki_nodes.revision))。
//   - 不直接复制活跃 wiki.db(plan-08 §3「不直接复制活跃 wiki.db」);只用 Backup API。
//
// ## 不变量(plan-08 §3 / acceptance-08 §C)
//   - **不复制活跃 wiki.db 文件**(用 SQLite Backup API)。
//   - **不 checkpoint 活跃 DB**(memory feedback-sessions-db-readonly)。
//   - Core / Wiki 各自独立 backup + integrity check;一个 manifest 成对记录但
//     分别验证。不声称跨库同一 SQLite transaction。
//   - 写 Wiki 的并发期间 snapshot 可打开且 integrity/foreign_key 通过(SQLite
//     Backup API 保证页级一致)。
//   - readonly 诊断绝不对活跃 DB 执行 checkpoint/VACUUM/migration。
//
// ## API
//   - `snapshotAll()` → 并行做 Core + Wiki snapshot,返 manifest 列表。
//   - `snapshotCore()` / `snapshotWiki()` → 单库 snapshot。
//   - `verifySnapshot(path)` → 打开 snapshot 文件,跑 integrity_check +
//     foreign_key_check + 业务计数核对,返 VerifyResult。
//   - `restoreSnapshot(path, kind)` → 把 snapshot copy 到活跃 DB **旁**的临时
//     路径(不覆盖活跃 DB);返回临时路径供 caller 决定下一步(切换/检查)。
//   - `listSnapshots()` → 列出已有 snapshot + manifest。
//
// ## Git 集成(可选)
//   - `commitSnapshotToGit(snapshotPaths)` → 在 backups/ 目录的 git repo 里
//     只 commit snapshot 文件 + manifest,**不 commit 活跃 WAL/DB**。
//   - 备份目录初始化 git 由管理命令显式触发;不开机自动。
//
// ## 维护规则
//   - snapshot 命名:`${kind}-${ISO8601-utc}.db`。manifest sidecar:同名 `.json`。
//   - rotation:保留最近 N 个(默认 20);超出按时间最旧删。N 可配置。
//

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import type { CoreDatabase } from "./core-database.js";
import type { WikiDatabase } from "./wiki/wiki-database.js";
import { coreDbPath, wikiDbPath, coreBackupDir, wikiBackupDir } from "../core/database-paths.js";
import { log } from "../core/logger.js";

/**
 * Snapshot 类别。Core = core.db;Wiki = wiki.db。各自独立,不混。
 */
export type SnapshotKind = "core" | "wiki";

/**
 * Snapshot manifest(sidecar `.json`,与 `.db` snapshot 同目录同名)。
 *
 * 不声称跨库 transaction;Core 和 Wiki 各自有独立 manifest,只是文件名
 * 时间戳对齐(便于成对查询)。
 */
export interface SnapshotManifest {
	/** Manifest schema version(独立于 DB schema version)。 */
	manifestVersion: 1;
	kind: SnapshotKind;
	/** Snapshot `.db` 文件绝对路径。 */
	snapshotPath: string;
	/** 源活跃 DB 绝对路径(备份时的位置)。 */
	sourcePath: string;
	/** ISO 8601 UTC 生成时间。 */
	createdAt: string;
	/** DB 软件 schema version(core.db 目前无 version → 0;wiki.db 来自 WIKI_SCHEMA_VERSION)。 */
	dbSchemaVersion: number;
	/** SHA-256(snapshot 文件,hex)。 */
	sha256: string;
	/** Snapshot 文件大小(byte)。 */
	sizeBytes: number;
	/** 业务 revision(core=max(agents.wiki_policy_revision);wiki=max(wiki_nodes.revision))。 */
	businessRevision: number;
	/** SQLite 库版本(snapshot 时,diagnostic)。 */
	sqliteVersion: string;
	/** 备份是否触发 bytedance-equal consistency check(integrity_check + fk_check)。 */
	verified: boolean;
	/** Optional operator note(set by management API caller)。 */
	note?: string;
}

/**
 * Verify 结果。
 */
export interface VerifyResult {
	ok: boolean;
	integrityCheck: string;
	foreignKeyCheck: string;
	rootCount: number;
	nodeCount: number;
	linkCount: number;
	auditCount: number;
	repositoryCount: number;
	addressCount: number;
	sourceBindingCount: number;
	error?: string;
}

/**
 * 备份服务依赖。注入 CoreDatabase 与 WikiDatabase 句柄(都已经在
 * DatabaseManager.open 时就绪)。
 *
 * Wiki 句柄可选 —— headless/CLI 路径可能不起 wiki subsystem,这时只能 backup
 * core.db(wiki.db 文件可能也不存在,跳过 wiki snapshot)。
 */
export interface BackupServiceDeps {
	coreDb: CoreDatabase;
	wikiDb?: WikiDatabase;
	/** 保留最近 N 个 snapshot(默认 20)。超出按时间最旧删。 */
	keepRecent?: number;
}

export class BackupService {
	private readonly deps: BackupServiceDeps;
	private readonly keepRecent: number;

	constructor(deps: BackupServiceDeps) {
		this.deps = deps;
		this.keepRecent = deps.keepRecent ?? 20;
	}

	// ─── Snapshot API ───────────────────────────────────────────────

	/**
	 * 同时 snapshot Core + Wiki(顺序执行)。
	 *
	 * 返 `{ core, wiki }`:
	 *   - `core` 总有(snapshotCore 抛错则整体抛,router → HTTP 500)。
	 *   - `wiki` 仅在 **wiki 子系统未启动**(deps.wikiDb 为 undefined,即 headless
	 *     / CLI 路径,见 BackupServiceDeps.wikiDb 注释)时为 null —— 这是有意的、
	 *     合法的"无 wiki 可备份"。
	 *
	 * round-2 Fix 1b (acceptance-08 §C blocker):当 deps.wikiDb **存在** 时,
	 * wiki snapshot 失败必须让错误向上传播 —— 不再 catch+log.warn+返 wiki:null
	 * 的"静默成功"。原实现让管理面 UI 看到 HTTP 200 + wiki:null 就当备份成功,
	 * 但 wiki.db 实际从未被 snapshot(整个 §3 备份面+所有 /api/wiki-maintain/
	 * backup/* endpoint 在 Windows file: URI blocker 下都死成 wiki:null 静默
	 * 成功)。Router try/catch 会把抛出的 error 转 HTTP 500 + 错误消息。
	 */
	async snapshotAll(note?: string): Promise<{ core: SnapshotManifest; wiki: SnapshotManifest | null }> {
		const core = await this.snapshotCore(note);
		if (!this.deps.wikiDb) {
			// 合法的 wiki:null —— wiki subsystem 未启动(无 deps.wikiDb)。
			this.rotate();
			return { core, wiki: null };
		}
		// wiki subsystem 已启动 → 任一库失败都抛(不让 wiki:null 静默成功)。
		const wiki = await this.snapshotWiki(note);
		this.rotate();
		return { core, wiki };
	}

	/**
	 * Core.db snapshot。目标路径 `${coreBackupDir}/core-${ISO}.db`。
	 * 用 SQLite Backup API(在线页级一致;不 checkpoint 源)。
	 */
	async snapshotCore(note?: string): Promise<SnapshotManifest> {
		return this.snapshotOne("core", coreDbPath, coreBackupDir, note);
	}

	/**
	 * Wiki.db snapshot。同上,target = `${wikiBackupDir}/wiki-${ISO}.db`。
	 */
	async snapshotWiki(note?: string): Promise<SnapshotManifest> {
		return this.snapshotOne("wiki", wikiDbPath, wikiBackupDir, note);
	}

	/**
	 * 单库 snapshot 内部实现。打开源 DB(只读模式,避免触发 WAL 状态变化)→
	 * SQLite Backup API → 目标 → 关闭 → 写 manifest + SHA-256。
	 *
	 * 注意:源 DB 用 `readonly` 模式打开(独立 connection),避免任何写入
	 * 副作用(memory feedback-sessions-db-readonly)。活跃 DB 由 caller 持有,
	 * Backup API 在 page 级一致(WAL 模式下 backup 自动等 WAL merge)。
	 */
	private async snapshotOne(kind: SnapshotKind, sourcePath: string, targetDir: string, note?: string): Promise<SnapshotManifest> {
		if (!existsSync(sourcePath)) {
			throw new Error(`source DB not found: ${sourcePath}`);
		}
		mkdirSync(targetDir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const snapshotPath = join(targetDir, `${kind}-${stamp}.db`);
		// Open source READ-ONLY via plain filesystem path.
		// round-2 Fix 1a (acceptance-08 §C blocker): the previous form
		// `file:${sourcePath.replace(/\\/g,"/")}?mode=ro` is a SQLite URI.
		// On Windows, drive-letter paths (file:C:/users/...) confuse the URI
		// scheme parser — SQLite reads `file:C` as a custom scheme and the
		// drive letter as an opaque authority, producing SqliteError
		// 'unable to open database file' whenever the active DB connection
		// is held by DatabaseManager. Plain path + { readonly: true } is
		// better-sqlite3's documented RO form — `mode=ro` is redundant once
		// readonly:true is set — and skips URI parsing entirely. Verified
		// independently by the round-1 adversarial verifier: plain path
		// opens successfully and the SQLite Backup API produces a valid
		// snapshot through it.
		const srcDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
		let sqliteVer = "unknown";
		try {
			// better-sqlqlite3 backup() returns a Promise that resolves when the
			// online page-level copy is complete. WAL merge is automatic.
			await srcDb.backup(snapshotPath);
			sqliteVer = (srcDb.prepare("select sqlite_version() as v").get() as { v: string }).v;
		} finally {
			srcDb.close();
		}
		// Open snapshot, run integrity + business counts, then compute hash.
		const verified = this.verifySnapshotOnDisk(snapshotPath, kind);
		const sha = sha256File(snapshotPath);
		const size = statSync(snapshotPath).size;
		const businessRev = this.readBusinessRevision(snapshotPath, kind);
		const dbSchemaVer = this.readDbSchemaVersion(snapshotPath, kind);
		const manifest: SnapshotManifest = {
			manifestVersion: 1,
			kind,
			snapshotPath,
			sourcePath,
			createdAt: new Date().toISOString(),
			dbSchemaVersion: dbSchemaVer,
			sha256: sha,
			sizeBytes: size,
			businessRevision: businessRev,
			sqliteVersion: sqliteVer,
			verified: verified.ok,
			note,
		};
		writeFileSync(snapshotPath + ".json", JSON.stringify(manifest, null, 2), "utf-8");
		if (!verified.ok) {
			log.warn("backup", `${kind} snapshot ${snapshotPath} verify failed: ${verified.error ?? verified.integrityCheck}`);
		}
		return manifest;
	}

	// ─── Verify / Restore API ───────────────────────────────────────

	/**
	 * Verify a snapshot file. Opens it (read-only), runs integrity_check +
	 * foreign_key_check + business counts. Returns the result; never throws
	 * (failures go into VerifyResult.error).
	 */
	verifySnapshot(snapshotPath: string): VerifyResult {
		const kind: SnapshotKind = basename(snapshotPath).startsWith("core") ? "core" : "wiki";
		return this.verifySnapshotOnDisk(snapshotPath, kind);
	}

	private verifySnapshotOnDisk(snapshotPath: string, kind: SnapshotKind): VerifyResult {
		if (!existsSync(snapshotPath)) {
			return emptyVerify(`snapshot not found: ${snapshotPath}`);
		}
		let db: Database.Database;
		try {
			db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
		} catch (err) {
			return emptyVerify(`cannot open snapshot: ${(err as Error).message}`);
		}
		try {
			const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
			const integrityOk = integrity.length === 1 && integrity[0].integrity_check === "ok";
			const fkCheck = db.pragma("foreign_key_check") as Array<unknown>;
			const fkOk = fkCheck.length === 0;
			const counts = readBusinessCounts(db, kind);
			const ok = integrityOk && fkOk;
			return {
				ok,
				integrityCheck: integrity.map((r) => r.integrity_check).join("; "),
				foreignKeyCheck: fkCheck.length === 0 ? "ok" : `${fkCheck.length} violation(s)`,
				...counts,
				error: ok ? undefined : (!integrityOk ? "integrity_check failed" : "foreign_key_check failed"),
			};
		} catch (err) {
			return emptyVerify(`verify error: ${(err as Error).message}`);
		} finally {
			db.close();
		}
	}

	/**
	 * Restore a snapshot: copy it to a NEW temp path (NOT overwriting the
	 * active DB). Returns the temp path. The management caller decides what
	 * to do with the restored copy (e.g. swap in on next restart after manual
	 * validation). Plan-08 §3: restore 到临时实例 + 验证。
	 *
	 * 不替换活跃 DB —— 那需要停服 + 谨慎流程,由管理命令显式编排,不在本服务做。
	 */
	restoreSnapshot(snapshotPath: string, _kind: SnapshotKind): string {
		if (!existsSync(snapshotPath)) {
			throw new Error(`snapshot not found: ${snapshotPath}`);
		}
		const dir = dirname(snapshotPath);
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const restoredPath = join(dir, `restored-${basename(snapshotPath, ".db")}-${stamp}.db`);
		copyFileSync(snapshotPath, restoredPath);
		// Re-verify the restored copy to confirm the file copy is intact.
		const v = this.verifySnapshotOnDisk(restoredPath, _kind);
		if (!v.ok) {
			rmSync(restoredPath, { force: true });
			throw new Error(`restored copy failed verify: ${v.error ?? "unknown"}`);
		}
		return restoredPath;
	}

	// ─── Listing + rotation ─────────────────────────────────────────

	/**
	 * List all snapshots across core + wiki backup dirs, newest first.
	 * Each entry is the manifest (if present) or a minimal stub (file only).
	 */
	listSnapshots(): SnapshotManifest[] {
		const out: SnapshotManifest[] = [];
		for (const kind of ["core", "wiki"] as const) {
			const dir = kind === "core" ? coreBackupDir : wikiBackupDir;
			if (!existsSync(dir)) continue;
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".db")) continue;
				const snapshotPath = join(dir, file);
				const manifestPath = snapshotPath + ".json";
				if (existsSync(manifestPath)) {
					try {
						out.push(JSON.parse(readFileSync(manifestPath, "utf-8")) as SnapshotManifest);
					} catch {
						out.push(stubManifest(snapshotPath, kind));
					}
				} else {
					out.push(stubManifest(snapshotPath, kind));
				}
			}
		}
		out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		return out;
	}

	/**
	 * Delete snapshots beyond the keepRecent limit (per kind). Newest kept.
	 */
	rotate(): { core: number; wiki: number } {
		return { core: this.rotateKind("core"), wiki: this.rotateKind("wiki") };
	}

	private rotateKind(kind: SnapshotKind): number {
		const dir = kind === "core" ? coreBackupDir : wikiBackupDir;
		if (!existsSync(dir)) return 0;
		const files = readdirSync(dir)
			.filter((f) => f.startsWith(`${kind}-`) && f.endsWith(".db"))
			.map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		let removed = 0;
		for (const entry of files.slice(this.keepRecent)) {
			const base = entry.f.slice(0, -3); // strip .db
			rmSync(join(dir, entry.f), { force: true });
			rmSync(join(dir, `${base}.db-wal`), { force: true });
			rmSync(join(dir, `${base}.db-shm`), { force: true });
			rmSync(join(dir, `${entry.f}.json`), { force: true });
			removed++;
		}
		return removed;
	}

	// ─── Helpers ────────────────────────────────────────────────────

	private readBusinessRevision(snapshotPath: string, kind: SnapshotKind): number {
		const db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
		try {
			if (kind === "core") {
				const row = db.prepare("SELECT MAX(wiki_policy_revision) AS v FROM agents").get() as { v: number | null } | undefined;
				return row?.v ?? 0;
			}
			const row = db.prepare("SELECT MAX(revision) AS v FROM wiki_nodes").get() as { v: number | null } | undefined;
			return row?.v ?? 0;
		} catch {
			return 0;
		} finally {
			db.close();
		}
	}

	private readDbSchemaVersion(snapshotPath: string, kind: SnapshotKind): number {
		if (kind === "core") return 0;
		const db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
		try {
			const row = db.prepare("SELECT version AS v FROM wiki_schema_version ORDER BY version DESC LIMIT 1").get() as { v: number } | undefined;
			return row?.v ?? 0;
		} catch {
			return 0;
		} finally {
			db.close();
		}
	}
}

// ─── Helpers ────────────────────────────────────────────────────

function sha256File(p: string): string {
	const h = createHash("sha256");
	h.update(readFileSync(p));
	return h.digest("hex");
}

function readBusinessCounts(db: Database.Database, kind: SnapshotKind): {
	rootCount: number; nodeCount: number; linkCount: number; auditCount: number;
	repositoryCount: number; addressCount: number; sourceBindingCount: number;
} {
	if (kind === "core") {
		// Core DB has no wiki tables; counts stay 0 (placeholders for the
		// shape — the management caller renders them as "n/a").
		return {
			rootCount: 0, nodeCount: 0, linkCount: 0, auditCount: 0,
			repositoryCount: 0, addressCount: 0, sourceBindingCount: 0,
		};
	}
	const count = (table: string): number => {
		try {
			const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number } | undefined;
			return row?.n ?? 0;
		} catch {
			return 0;
		}
	};
	return {
		rootCount: count("wiki_nodes WHERE parent_id IS NULL"),
		nodeCount: count("wiki_nodes"),
		linkCount: count("wiki_links"),
		auditCount: count("wiki_audit_log"),
		repositoryCount: count("wiki_repositories"),
		addressCount: count("wiki_addresses"),
		sourceBindingCount: count("wiki_source_bindings"),
	};
}

function emptyVerify(error: string): VerifyResult {
	return {
		ok: false,
		integrityCheck: "",
		foreignKeyCheck: "",
		rootCount: 0, nodeCount: 0, linkCount: 0, auditCount: 0,
		repositoryCount: 0, addressCount: 0, sourceBindingCount: 0,
		error,
	};
}

function stubManifest(snapshotPath: string, kind: SnapshotKind): SnapshotManifest {
	const stat = statSync(snapshotPath);
	return {
		manifestVersion: 1,
		kind,
		snapshotPath,
		sourcePath: kind === "core" ? coreDbPath : wikiDbPath,
		createdAt: stat.mtime.toISOString(),
		dbSchemaVersion: 0,
		sha256: "",
		sizeBytes: stat.size,
		businessRevision: 0,
		sqliteVersion: "",
		verified: false,
		note: "(stub — manifest sidecar missing)",
	};
}
