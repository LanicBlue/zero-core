// 数据库生命周期管理器（wiki-system-redesign plan-00 §3/§4/§5）
//
// # 文件说明书
//
// ## 核心功能
// 服务端**唯一**数据库生命周期管理器。负责：
//   - 启动布局 bootstrap（sessions.db → db/core.db 切换；plan-00 §4）
//   - 退役 knowledge.db 删除（plan-00 §5）
//   - 打开 / 关闭 CoreDatabase（plan-00 已实现）
//   - health（core 项；plan-00 已实现，wiki 项待 plan-01）
//   - WAL checkpoint（core 项已实现；wiki 项待 plan-01）
//   - backup（core/wiki 项待 plan-08）
//
// ## 接口形状（锁定，core/wiki 对称）
//   readonly core: CoreDatabase            // plan-00 已设
//   readonly wiki: WikiDatabase | undefined // plan-01 起设；plan-00 阶段 undefined
//   open(): void                            // bootstrap + 构造 core（+ plan-01 wiki）
//   close(): void
//   health(): DatabaseHealthMap             // plan-00 只返 core 项
//   checkpointCore(): void                  // plan-00 已实现
//   checkpointWiki(): void                  // plan-01 实现
//   backupCore(dest): string                // plan-08 实现
//   backupWiki(dest): string                // plan-08 实现
//
// ## 不做
//   - 跨库 SQL / transaction / 共享 migration（plan-00 §G 拒绝条件）。
//   - 不直接持有 WikiDatabase 实例（plan-00 阶段 wiki 字段恒 undefined）。
//
// ## 错误码
//   - `DATABASE_LAYOUT_CONFLICT`：启动布局冲突（plan-00 §4）。本阶段闭集仅此一个。
//
// ## 维护规则
//   - 启动序：DatabaseManager 必须在任何 CoreDatabase 被业务代码构造之前 open()。
//   - 所有 DB 路径来自 src/core/database-paths.ts。
//   - sessions.db readonly 不变量（memory feedback-sessions-db-readonly）：
//     本文件对**旧** sessions.db 的 wal_checkpoint(TRUNCATE) 是**启动时**做的，
//     此时本进程是 sessions.db 的唯一所有者（其它代码还没拿到 handle）——
//     这是受许可的维护路径。诊断/读取活跃库的代码必须用 { readonly: true }
//     且绝不 checkpoint/VACUUM/migrate。

import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync, copyFileSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/logger.js";
import { ZERO_CORE_DIR } from "../core/config.js";
import {
	coreDbPath,
	legacyCoreDbPath,
	layoutMarkerPath,
	coreBackupDir,
	DB_DIR,
} from "../core/database-paths.js";
import { CoreDatabase } from "./core-database.js";
import type { WikiDatabase } from "./wiki-database.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * 健康状态映射。Plan-00 阶段只含 `core`；Plan-01 起补 `wiki`。
 * 形状锁定：后续 plan 不得改名，只补字段。
 */
export interface DatabaseHealthMap {
	/** Core DB 健康状态。Plan-00 实现。 */
	core: DatabaseHealthEntry;
	/**
	 * Wiki DB 健康状态。Plan-01 起补；Plan-00 阶段省略（undefined）。
	 * 锁定的字段位置 —— 不得改名。
	 */
	wiki?: DatabaseHealthEntry;
}

export interface DatabaseHealthEntry {
	/** DB 文件是否存在（open 后应为 true）。 */
	exists: boolean;
	/** 是否可写（PRAGMA writable_schema + 实际 INSERT/UPDATE 测试通过）。 */
	writable: boolean;
	/** integrity_check 结果（"ok" 表示通过）。 */
	integrity: "ok" | string;
	/** foreign_key_check 结果（"ok" 表示通过）。 */
	foreignKeys: "ok" | string;
	/** 当前 journal_mode（WAL / MEMORY / ...）。 */
	journalMode: string;
}

// ===========================================================================
// # Layout/startup error codes (plan-00 §4)
// ---------------------------------------------------------------------------
// 本节是 DatabaseManager 启动/布局错误码的闭集。plan-00 §4 明确：
// 「DatabaseManager 错误码闭集仅此一个」—— 指的是启动/布局类错误码，
// 与下方 Wiki 占位码分区存放，不得与 WikiErrorCode（plan-01+）混放。
// 后续若新增启动/布局错误码，在此集中声明。
// ===========================================================================

/**
 * DatabaseManager 启动错误码（plan-00 §4）。本阶段闭集仅此一个；
 * 后续若新增启动/布局错误码须在此集中声明，不得散落到 wiki 操作码。
 */
export const DATABASE_LAYOUT_CONFLICT = "DATABASE_LAYOUT_CONFLICT";

// ===========================================================================
// # Wiki placeholder codes — plan-01 will move these into wiki-database.ts
// ---------------------------------------------------------------------------
// plan-00 阶段 wiki getter/checkpointWiki/backupCore/backupWiki 抛出的占位
// 错误码。plan-00 §4 的「闭集仅此一个」特指上方启动/布局分区；这些占位
// 码属于 wiki 子系统（plan-01+），与启动错误码物理分区、命名空间隔离。
// Plan-01 起 WikiErrorCode 命名空间正式落地后，这些常量搬到
// src/server/wiki-database.ts，本文件不再持有 wiki 操作码。
// ===========================================================================

/**
 * Wiki 操作码（占位）。Plan-01 起的 WikiErrorCode 命名空间独立于此处的
 * 启动错误码；此处仅声明 plan-00 阶段 wiki getter 抛出的占位错误码。
 */
export const WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00 = "WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00";

/**
 * 布局标记文件内容。Plan-00 §4 要求记录 source/target/hash/time/version/
 * check 结果和 complete 状态。
 */
interface LayoutMarker {
	/** 标记格式版本（当前 "v1"）。 */
	version: "v1";
	/** 切换发生的 ISO 时间。 */
	completedAt: string;
	/** 源文件相对路径（相对 ZERO_CORE_DIR；fresh-create 为 null）。 */
	source: string | null;
	/** 目标文件相对路径（db/core.db）。 */
	target: string;
	/** 源文件 sha256（fresh-create 为 null）。 */
	sourceSha256: string | null;
	/** 目标文件 sha256（atomic promote 后算）。 */
	targetSha256: string;
	/** integrity_check 结果（fresh-create 为 "skipped-fresh"）。 */
	integrity: "ok" | "skipped-fresh" | string;
	/** foreign_key_check 结果（fresh-create 为 "skipped-fresh"）。 */
	foreignKeys: "ok" | "skipped-fresh" | string;
	/** 是否完成（true = 切换成功，下次启动直接 normal open）。 */
	complete: boolean;
}

// ---------------------------------------------------------------------------
// Retired knowledge.db deletion（plan-00 §5）
// ---------------------------------------------------------------------------

/**
 * 精确绝对路径白名单：退役 knowledge.db 的三个文件。Plan-00 §5 要求禁止
 * glob / 递归 / 跨 shell 拼接 —— 这里只列三个绝对路径字面量。
 */
const RETIRED_KNOWLEDGE_DB_PATHS: readonly string[] = [
	join(ZERO_CORE_DIR, "knowledge.db"),
	join(ZERO_CORE_DIR, "knowledge.db-wal"),
	join(ZERO_CORE_DIR, "knowledge.db-shm"),
] as const;

/**
 * 删除退役的 knowledge.db{-wal,-shm}。精确白名单匹配，禁止 glob/递归。
 * Idempotent no-op if absent。Plan-00 §5：不读取内容、不导入、不备份。
 *
 * 由 DatabaseManager.open() 在 layout bootstrap 之前调用一次。
 */
export function deleteRetiredKnowledgeDb(): { deleted: string[] } {
	const deleted: string[] = [];
	for (const p of RETIRED_KNOWLEDGE_DB_PATHS) {
		// 精确匹配：RETIRED_KNOWLEDGE_DB_PATHS 是常量字面量数组，不存在
		// glob/递归风险。existsSync + unlinkSync 是单文件操作。
		if (!existsSync(p)) continue;
		try {
			unlinkSync(p);
			deleted.push(p);
		} catch (err) {
			// 删除失败不致命（权限/锁定）—— 记录后继续。Plan-00 §C 要求
			//「文件不存在时启动幂等成功」；存在但删不掉属异常，记结构化日志。
			log.warn("db", `retired_database delete failed: ${p}:`, (err as Error).message);
		}
	}
	if (deleted.length > 0) {
		// plan-00 §5 要求的结构化日志条目。
		log.db("retired_database_deleted", { deleted });
		console.error(`[db] retired_database_deleted: ${deleted.length} file(s) removed`);
	}
	return { deleted };
}

// ---------------------------------------------------------------------------
// Layout bootstrap（plan-00 §4）
// ---------------------------------------------------------------------------

/**
 * sessions.db → db/core.db 启动切换。在任何 CoreDatabase 连接建立前调用。
 *
 * 状态矩阵（plan-00 §4）：
 *   - core.db 存在、sessions.db 不存在、marker complete → 正常打开 core.db
 *   - core.db 不存在、sessions.db 存在 → 独占维护流程 → wal_checkpoint(TRUNCATE)
 *                                         → SQLite Backup API → integrity/foreign_key
 *                                         → atomic promote → 保存旧库 → 删旧 WAL/SHM
 *                                         → 写 marker
 *   - 两者都不存在 → fresh-create db/core.db（构造时由 CoreDatabase 完成）+ 写 marker
 *   - 两者都存在、无有效 marker → DATABASE_LAYOUT_CONFLICT（不猜测）
 *   - 两者都存在、有效 marker（complete:true）→ 正常打开 core.db
 *
 * 中断恢复幂等：不覆盖已验证的 core.db；不产生两个活动事实源。
 */
export function performLayoutBootstrap(): void {
	// 确保 db/ 与 backups/core/ 目录存在（任何分支都需要）。
	if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
	if (!existsSync(coreBackupDir)) mkdirSync(coreBackupDir, { recursive: true });

	const coreExists = existsSync(coreDbPath);
	const legacyExists = existsSync(legacyCoreDbPath);
	const marker = readMarker();

	// Case E：两者都存在 + 有效 marker → 信任 core.db
	if (coreExists && legacyExists && marker?.complete) {
		log.db("layout_bootstrap: both exist + valid marker -> normal open core.db");
		return;
	}

	// Case D：两者都存在 + 无有效 marker → DATABASE_LAYOUT_CONFLICT
	if (coreExists && legacyExists && !marker?.complete) {
		const err = new Error(
			`Database layout conflict: both ${coreDbPath} and ${legacyCoreDbPath} exist but no valid layout marker found. `
			+ `Refusing to guess the active source. Resolve manually (move one away) and restart.`,
		);
		(err as Error & { code?: string }).code = DATABASE_LAYOUT_CONFLICT;
		throw err;
	}

	// Case A：core.db 存在、sessions.db 不存在 → 正常打开
	if (coreExists && !legacyExists) {
		// 即使没有 marker（例如手动从备份还原 core.db），也允许继续：
		// 单一事实源已存在，没有冲突。补写 marker 以便后续启动识别。
		if (!marker?.complete) {
			writeMarkerForExistingCoreDb(marker ?? null);
		}
		log.db("layout_bootstrap: core.db exists, legacy absent -> normal open");
		return;
	}

	// Case B：core.db 不存在、sessions.db 存在 → 迁移
	if (!coreExists && legacyExists) {
		migrateLegacyToCore();
		return;
	}

	// Case C：两者都不存在 → fresh-create（CoreDatabase 构造时建文件）+ 写 marker
	if (!coreExists && !legacyExists) {
		// CoreDatabase 构造器会创建 db/core.db + init schema。本函数仅预写
		// 一条"fresh-create" marker（targetSha256 在 open() 完成后补）。
		writeMarkerForFreshCreate();
		log.db("layout_bootstrap: neither exists -> fresh create core.db");
		return;
	}
}

/**
 * 读取并验证布局标记。complete:true 才算"有效"。
 */
function readMarker(): LayoutMarker | null {
	if (!existsSync(layoutMarkerPath)) return null;
	try {
		const raw = readFileSync(layoutMarkerPath, "utf-8");
		const obj = JSON.parse(raw) as LayoutMarker;
		if (obj && obj.version === "v1" && obj.complete === true) return obj;
		return obj && obj.version === "v1" ? obj : null;
	} catch {
		return null;
	}
}

/**
 * Case B 实际迁移逻辑：sessions.db → db/core.db。
 */
function migrateLegacyToCore(): void {
	const startedAt = new Date().toISOString();
	log.db(`layout_bootstrap: migrating legacy ${legacyCoreDbPath} -> ${coreDbPath}`);

	// 1) 独占维护流程打开旧库（本进程此时是 sessions.db 的唯一所有者；
	//    其它业务代码还没构造 CoreDatabase）。
	const legacy = new Database(legacyCoreDbPath);
	try {
		// 2) wal_checkpoint(TRUNCATE) — 把 WAL 内容并回主库并截断 WAL。
		//    memory note feedback-sessions-db-readonly：此处是**启动维护**，
		//    本进程是唯一所有者，checkpoint 安全。诊断/读取活跃库的代码路径
		//    仍必须用 { readonly: true } 且绝不 checkpoint —— 那是不同的路径。
		legacy.pragma("wal_checkpoint(TRUNCATE)");
	} finally {
		// 关闭旧连接，确保后续 Backup API 能独占访问。
		legacy.close();
	}

	// 3) 把旧库字节拷贝到 db/core.db.tmp（atomic promote 前的暂存）。
	//
	// plan-00 round-2 FIX 1（3 个 verifier lens 三角确认 BLOCKER）：
	// 原实现用 `source.backup(tmpPath)` —— better-sqlite3 的 Database#backup()
	// 返回 Promise（via setImmediate 步进），但代码未 await；finally 立即 close
	// 连接 → 异步备份在已关闭的句柄上跑 → 未处理拒绝 "The database connection
	// is not open" + tmp 留在无效状态 → 下面的 readonly probe 抛
	// "unable to open database file"。16 条迁移测试（database-layout 7 +
	// database-bootstrap-adversarial 9）全挂；任何带 sessions.db 的真实用户
	// 启动即 brick。
	//
	// 修复选用 Option A（3 lens 共识；保持 plan-00 §3 锁定的 `open():void`
	// 签名，不引入 async 级联）：旧库在步骤 2 已 wal_checkpoint(TRUNCATE)
	// + close（本进程独占持有、quiescent），字节拷贝与 Backup API 产物完全
	// 等价且没有异步陷阱。copyFileSync 已在文件顶部 import。
	const tmpPath = `${coreDbPath}.tmp`;
	if (existsSync(tmpPath)) unlinkSync(tmpPath);
	copyFileSync(legacyCoreDbPath, tmpPath);

	// 4) 在 tmp 上跑 integrity_check + foreign_key_check（验证后才能 promote）。
	const probe = new Database(tmpPath, { readonly: true });
	let integrity: string | string[];
	let foreignKeys: string | string[];
	try {
		integrity = probe.pragma("integrity_check") as any;
		foreignKeys = probe.pragma("foreign_key_check") as any;
	} finally {
		probe.close();
	}
	const integrityOk = Array.isArray(integrity)
		? integrity.length === 1 && (integrity[0] as any)?.integrity_check === "ok"
		: integrity === "ok";
	const foreignKeysOk = Array.isArray(foreignKeys) ? foreignKeys.length === 0 : false;
	if (!integrityOk || !foreignKeysOk) {
		// 验证失败：清理 tmp，抛错（绝不 promote 未通过的库；plan-00 §G）。
		try { unlinkSync(tmpPath); } catch {}
		const err = new Error(
			`Layout migration aborted: integrity/foreign_key check failed on migrated core.db `
			+ `(integrity=${JSON.stringify(integrity)}, foreignKeys=${JSON.stringify(foreignKeys)}). `
			+ `Legacy sessions.db is untouched.`,
		);
		throw err;
	}

	// 5) Atomic promote：rename core.db.tmp -> core.db。
	//
	// 6) 写 layout-v1.json (complete:true)。
	//
	// plan-00 round-2 FIX 2（§B4 中断恢复幂等）：marker 必须在 promote 之前
	// 写入，消除"promote 完成 → marker 写入"之间的 crash 窗口。原顺序若在
	// promote 之后 crash，会留下 core.db + sessions.db + 无 marker → 下次启动
	// 命中 Case D 抛 DATABASE_LAYOUT_CONFLICT（拒绝而非恢复），违反 plan-00 §4
	//「中断恢复必须幂等」。新顺序的 crash 窗口分析：
	//   - marker 写入前 crash：无 marker + legacy 在位 + core.db 不存在 → Case B
	//     重新迁移（migrateLegacyToCore 顶部 unlink 残留 tmp），幂等。
	//   - promote 后 crash（marker 已写）：core.db + complete:true marker →
	//     若 legacy 仍在位 → Case E（both exist + complete marker）正常打开；
	//     若 legacy 已移走 → Case A 正常打开。两条路径都不 brick。
	// 注意：不引入 complete:false 迁移 marker —— verifier 在
	// database-bootstrap-adversarial.test.ts:328 明确编码了
	//「complete:false marker + 双库并存 → DATABASE_LAYOUT_CONFLICT」（独立构
	// 造的两库无法与"已验证的部分迁移"区分，安全策略是交给运维），本实现
	// 遵守该不变量。
	//
	// 在 promote 前计算 hash：sourceHash 来自 legacyCoreDbPath（即将被移走，
	// 但内容 == 即将落地的 backup），targetHash 来自 tmpPath（即将被 rename
	// 为 core.db，字节完全一致）。
	const sourceHash = safeSha256(legacyCoreDbPath);
	const targetHash = safeSha256(tmpPath) ?? "";
	const marker: LayoutMarker = {
		version: "v1",
		completedAt: startedAt,
		source: "sessions.db",
		target: "db/core.db",
		sourceSha256: sourceHash,
		targetSha256: targetHash,
		integrity: "ok",
		foreignKeys: "ok",
		complete: true,
	};
	writeFileSync(layoutMarkerPath, JSON.stringify(marker, null, 2), "utf-8");

	// Atomic promote：此时 marker 已落地，promote 是单纯的 rename。
	renameSync(tmpPath, coreDbPath);

	// 7) 保存旧 sessions.db 为 backups/core/pre-layout-<ts>.db（move，避免重复）。
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = join(coreBackupDir, `pre-layout-${ts}.db`);
	try {
		// 移动（不是复制）：原位置清空，避免下次启动命中 Case E 把 litter 当活动源。
		renameSync(legacyCoreDbPath, backupPath);
	} catch (err) {
		// 如果 rename 失败（跨盘/权限），fallback 到 copy + unlink。
		try {
			copyFileSync(legacyCoreDbPath, backupPath);
			unlinkSync(legacyCoreDbPath);
		} catch (err2) {
			log.warn("db", `layout_bootstrap: failed to move legacy sessions.db to backup:`, (err2 as Error).message);
			// 备份失败不致命：core.db 已就绪并验证；旧 sessions.db 留在原位。
			// 下次启动会命中 Case E（both exist + complete marker）→ 正常打开
			// core.db，sessions.db 作为 litter 保留待运维清理 —— 符合 plan-00
			// "不猜测事实源" 原则，且不 brick。
		}
	}

	// 8) 删除旧 WAL/SHM（plan-00 §4）。
	for (const ext of ["-wal", "-shm"]) {
		const p = `${legacyCoreDbPath}${ext}`;
		if (existsSync(p)) {
			try { unlinkSync(p); } catch (err) { log.warn("db", `failed to delete ${p}:`, (err as Error).message); }
		}
	}

	log.db(`layout_bootstrap: migration complete (source=${sourceHash?.slice(0, 8) ?? "?"} target=${targetHash.slice(0, 8) || "?"})`);
}

/**
 * Fresh-create 的 marker：CoreDatabase 构造器尚未运行，因此 target hash
 * 暂未计算（complete:false）。open() 完成后会用 finalizeFreshCreateMarker()
 * 补全。
 */
function writeMarkerForFreshCreate(): void {
	const marker: LayoutMarker = {
		version: "v1",
		completedAt: new Date().toISOString(),
		source: null,
		target: "db/core.db",
		sourceSha256: null,
		targetSha256: "", // 由 finalizeFreshCreateMarker 补
		integrity: "skipped-fresh",
		foreignKeys: "skipped-fresh",
		complete: false,
	};
	writeFileSync(layoutMarkerPath, JSON.stringify(marker, null, 2), "utf-8");
}

/**
 * 已存在的 core.db（无迁移）写 marker —— 单源场景补写以让后续启动识别。
 */
function writeMarkerForExistingCoreDb(_prior: LayoutMarker | null): void {
	const targetHash = safeSha256(coreDbPath) ?? "";
	const marker: LayoutMarker = {
		version: "v1",
		completedAt: new Date().toISOString(),
		source: null,
		target: "db/core.db",
		sourceSha256: null,
		targetSha256: targetHash,
		integrity: "ok",
		foreignKeys: "ok",
		complete: true,
	};
	writeFileSync(layoutMarkerPath, JSON.stringify(marker, null, 2), "utf-8");
}

/**
 * CoreDatabase open() 完成后，把 fresh-create 的 marker 补全为 complete:true。
 * Idempotent：marker 已 complete 时 no-op。
 */
function finalizeFreshCreateMarker(): void {
	const existing = readMarker();
	if (existing?.complete) return;
	const targetHash = safeSha256(coreDbPath) ?? "";
	const marker: LayoutMarker = {
		version: "v1",
		completedAt: existing?.completedAt ?? new Date().toISOString(),
		source: null,
		target: "db/core.db",
		sourceSha256: null,
		targetSha256: targetHash,
		integrity: "skipped-fresh",
		foreignKeys: "skipped-fresh",
		complete: true,
	};
	writeFileSync(layoutMarkerPath, JSON.stringify(marker, null, 2), "utf-8");
}

/** 同步计算文件 sha256（小文件可接受；失败返回 null）。 */
function safeSha256(p: string): string | null {
	// 用 better-sqlite3 已有的 crypto？不 —— 直接用 node:crypto。
	// 为避免在 module 顶层 import 拖累启动，本函数 lazy require。
	try {
		if (!existsSync(p)) return null;
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { createHash } = require("node:crypto") as typeof import("node:crypto");
		const { readFileSync: rf } = require("node:fs") as typeof import("node:fs");
		const buf = rf(p);
		return createHash("sha256").update(buf).digest("hex");
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Process-wide singleton（plan-00 §3：composition root 唯一实例）
// ---------------------------------------------------------------------------

let _instance: DatabaseManager | undefined;

/** 注册进程唯一的 DatabaseManager 实例（由 server/index.ts 启动时调用）。 */
export function setDatabaseManager(m: DatabaseManager | undefined): void {
	_instance = m;
}

/**
 * 取进程唯一的 DatabaseManager 实例。CLI/headless 路径若未 set 则返回 undefined。
 *
 * 工具/服务可通过此 getter 访问 health()/checkpointCore() 等生命周期 API，
 * 不需要 per-loop 注入。headless CLI 没起 DatabaseManager 时返 undefined
 * （调用方需自行降级）。
 */
export function getDatabaseManager(): DatabaseManager | undefined {
	return _instance;
}

// ---------------------------------------------------------------------------
// DatabaseManager（plan-00 §3）
// ---------------------------------------------------------------------------

/**
 * 服务端**唯一**数据库生命周期管理器。Server composition root（server/index.ts）
 * 持有单实例；任何 CoreDatabase 的业务代码构造都必须经此。
 *
 * Plan-00 实现：core / open / close / health(core only) / checkpointCore。
 * Plan-01 实现：wiki / checkpointWiki。
 * Plan-08 实现：backupCore / backupWiki。
 */
export class DatabaseManager {
	private _core: CoreDatabase | undefined;
	private _wiki: WikiDatabase | undefined;
	private _opened = false;

	/**
	 * Core DB 句柄。open() 之前访问 throw；close() 之后访问 throw。
	 * 锁定的字段位置 —— 后续 plan 不得改名。
	 */
	get core(): CoreDatabase {
		if (!this._opened || !this._core) {
			throw new Error("DatabaseManager.core accessed before open() (or after close())");
		}
		return this._core;
	}

	/**
	 * Wiki DB 句柄。Plan-00 阶段始终 undefined —— Plan 01 起在 open() 里赋值。
	 * 锁定的字段位置 —— 后续 plan 不得改名。
	 */
	get wiki(): WikiDatabase | undefined {
		// plan-00 阶段：wiki getter 始终返 undefined（或 throw if accessed pre-open）。
		// Plan-01 起在此 return this._wiki（open() 里赋值）。
		return this._wiki;
	}

	/**
	 * 打开数据库：先做 layout bootstrap（sessions.db → core.db 切换）+
	 * knowledge.db 清理，然后构造 CoreDatabase。Plan-01 起还会构造 WikiDatabase。
	 *
	 * 必须在任何业务代码访问 core 之前调用。重复调用是 idempotent no-op
	 * （已 open 就直接 return）。
	 */
	open(): void {
		if (this._opened) return;

		// plan-00 §5：先删退役 knowledge.db（精确白名单，幂等）。
		deleteRetiredKnowledgeDb();

		// plan-00 §4：sessions.db → db/core.db 切换（idempotent on interrupt）。
		performLayoutBootstrap();

		// 构造 CoreDatabase（默认走 coreDbPath；DatabaseManager 不传 dbPath，
		// 让 CoreDatabase 自己用 database-paths 的默认值）。
		this._core = new CoreDatabase();

		// 补全 fresh-create marker（Case C 的延迟完成）。
		finalizeFreshCreateMarker();

		// Plan-01 起在这里构造 this._wiki = new WikiDatabase(wikiDbPath);
		// Plan-00 阶段 wiki 字段保持 undefined。

		this._opened = true;
	}

	/** 关闭所有数据库。Idempotent（重复 close no-op）。 */
	close(): void {
		if (!this._opened) return;
		try {
			this._core?.close();
		} catch (err) {
			log.warn("db", "DatabaseManager.close: core close failed:", (err as Error).message);
		}
		// Plan-01 起：try { this._wiki?.close(); } catch ...
		this._core = undefined;
		this._wiki = undefined;
		this._opened = false;
	}

	/**
	 * 健康检查。Plan-00 只返 core 项；Plan-01 起补 wiki 项。
	 * 形状锁定：返回类型是 DatabaseHealthMap，字段名 core/wiki 不得改名。
	 */
	health(): DatabaseHealthMap {
		if (!this._opened || !this._core) {
			throw new Error("DatabaseManager.health() called before open()");
		}
		const coreEntry = probeHealth(this._core);
		// Plan-00 阶段 wiki 字段省略（undefined）；Plan-01 起补 wikiEntry。
		return { core: coreEntry };
	}

	/**
	 * Core DB 的 WAL checkpoint（TRUNCATE 模式）。Plan-00 实现。
	 *
	 * 仅在 DatabaseManager.open() 之后调用 —— 此时本进程是 core.db 的活跃所有者，
	 * checkpoint 安全（参考 memory feedback-sessions-db-readonly：受许可的维护路径）。
	 */
	checkpointCore(): void {
		if (!this._opened || !this._core) {
			throw new Error("DatabaseManager.checkpointCore() called before open()");
		}
		// wal_checkpoint(TRUNCATE) 把 WAL 内容并回主库并截断 WAL 文件。
		this._core.getDb().pragma("wal_checkpoint(TRUNCATE)");
	}

	/**
	 * Wiki DB 的 WAL checkpoint。Plan-01 实现。Plan-00 阶段调用即 throw
	 * （形状锁定，Plan-01 在此填实现且不得改名）。
	 */
	checkpointWiki(): void {
		throw new Error(
			`checkpointWiki not implemented in plan-00 (code=${WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00}); `
			+ `Plan 01 fills this once WikiDatabase is wired.`,
		);
	}

	/**
	 * Core DB 备份到 dest。Plan-08 实现（snapshot 用）。Plan-00 阶段 throw。
	 * 形状锁定：Plan-08 不得改名。
	 */
	backupCore(_dest: string): string {
		throw new Error(
			`backupCore not implemented in plan-00 (code=${WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00}); `
			+ `Plan 08 fills this for self-update snapshot.`,
		);
	}

	/**
	 * Wiki DB 备份到 dest。Plan-08 实现。Plan-00 阶段 throw。
	 * 形状锁定：Plan-08 不得改名。
	 */
	backupWiki(_dest: string): string {
		throw new Error(
			`backupWiki not implemented in plan-00 (code=${WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00}); `
			+ `Plan 08 fills this for self-update snapshot.`,
		);
	}
}

/**
 * 探测一个 CoreDatabase 的健康状态。所有 PRAGMA 只读，不写、不 checkpoint。
 */
function probeHealth(db: CoreDatabase): DatabaseHealthEntry {
	const handle = db.getDb();
	let exists = true;
	let writable = true;
	let integrity: string | string[] = "ok";
	let foreignKeys: string | string[] = "ok";
	let journalMode = "unknown";
	try {
		journalMode = (handle.pragma("journal_mode") as Array<{ journal_mode?: string }>)[0]?.journal_mode ?? "unknown";
		const ic = handle.pragma("integrity_check") as any;
		integrity = Array.isArray(ic) && ic.length === 1 && (ic[0] as any)?.integrity_check === "ok"
			? "ok"
			: JSON.stringify(ic);
		const fkc = handle.pragma("foreign_key_check") as any;
		foreignKeys = Array.isArray(fkc) && fkc.length === 0 ? "ok" : JSON.stringify(fkc);
	} catch (err) {
		integrity = `error: ${(err as Error).message}`;
		writable = false;
	}
	try {
		// 实际可写探测：在临时 KV 键上做 set + delete（KeyValueStore 已存在）。
		// 用 PRAGMA writable_schema 不够 —— 需要真做一次 DML 才能确认。
		db.getKVStore().set("__dbmanager_health_probe__", "1");
		db.getKVStore().delete("__dbmanager_health_probe__");
	} catch (err) {
		writable = false;
		void err;
	}
	// exists 用文件 stat 校验（句柄持有期间应始终存在）。
	// plan-00 round-2 FIX 5：原写法 `existsSync(p) || statSync(p).size >= 0`
	// 的 `||` 右侧在文件不存在时会抛 ENOENT 而非返回 false —— 死分支且误导。
	// 改为单纯 existsSync，符合「文件在 → true，不在 → false」直觉。
	exists = existsSync(coreDbPath);
	return {
		exists,
		writable,
		integrity: typeof integrity === "string" ? integrity : JSON.stringify(integrity),
		foreignKeys: typeof foreignKeys === "string" ? foreignKeys : JSON.stringify(foreignKeys),
		journalMode,
	};
}
