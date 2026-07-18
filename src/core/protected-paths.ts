// 受保护路径中央表(wiki-system-redesign plan-08 §2)
//
// # 文件说明书
//
// ## 核心功能
// 唯一权威列出 zero-core 运行时中**绝对不能被 Agent FS 工具(Shell / Read /
// Write / Edit / Grep / Glob)直接接触**的物理路径。涵盖:
//
//   - 数据库主文件 + WAL/SHM
//   - 备份目录(core / wiki)
//   - Wiki 运行时目录(锁/临时文件)
//   - Wiki 磁盘正文目录(已有的 WIKI_DISK_ROOT 保护)
//
// ## 为什么集中
// plan-08 §2 要求"重写 Wiki path guard":原 guard 只覆盖 wiki/ 正文树,无法
// 阻止 Agent 用 Read 读 core.db / wiki.db(可读出 wiki grants / prompt cache
// 里的敏感正文 / sessions 全量对话)或用 Write 写 wal/shm(可破坏数据库完整
// 性)。集中后,新增 DB 或备份目录只需改这一处,所有 FS 工具自动覆盖。
//
// ## 设计约束
//   - **唯一例外**:管理备份服务(不在 Agent shell 内)。其它任何 caller
//     走 FS 工具时都必须先调 `assertNotProtectedPath` 或 `isProtectedPath`。
//   - 不复制活跃 wiki.db(plan-08 §3 备份规则)。备份路径只供管理 API 写,
//     Agent 永远只读不写。
//   - readonly 诊断绝不对活跃 DB 执行 checkpoint/VACUUM/migration(memory
//     feedback-sessions-db-readonly)。Agent 即使能读 DB 文件,也绝不写。
//
// ## 绕过防护
// guard 必须能挡:相对路径 / 引号 / 环境变量 / 大小写 / symlink / junction /
// shell 拼接(plan-08 §2 + acceptance-08 §B)。`canonicalize` 统一处理。
//
// ## 维护规则
//   - 新增 DB / 备份目录:在 PROTECTED_PATHS 加一行,所有 FS 工具自动覆盖。
//   - 不要在 FS 工具里 hardcode 路径前缀,都通过此模块。
//

import { resolve, normalize, isAbsolute } from "node:path";
import { ZERO_CORE_DIR } from "./config.js";
import { DB_DIR, coreDbPath, wikiDbPath, coreBackupDir, wikiBackupDir } from "./database-paths.js";

/**
 * Wiki 磁盘正文根(`${ZERO_CORE_DIR}/wiki`)。叶子正文 + memory area + 项目
 * 镜像目录都挂在这下面。Agent 永远通过 Wiki tool(expand/read/upsert)操作,
 * 不能直接 Read/Write 这里的文件。
 */
export const WIKI_DISK_ROOT = ZERO_CORE_DIR.endsWith("/") || ZERO_CORE_DIR.endsWith("\\")
	? ZERO_CORE_DIR + "wiki"
	: ZERO_CORE_DIR + "/wiki";

/**
 * Wiki 运行时目录(锁/临时文件/indexer 状态)。Agent 不可读/写。
 *
 * plan-08 §2:wiki/.runtime 是 indexer / 备份服务的私有 scratch 目录。
 */
export const WIKI_RUNTIME_DIR = WIKI_DISK_ROOT + "/.runtime";

/**
 * 受保护路径列表。每条 = { abs: 绝对规范路径(用于 startsWith 匹配),
 * label: 拒绝消息里的人类可读说明 }。
 *
 * 数据库三件套(.db / .db-wal / .db-shm)各自独立,因为 Agent 可能尝试只读
 * WAL/SHM 绕过 .db 主文件的检查。备份目录按 core/wiki 分别列出,新增其它
 * 备份目录(如 manifest 备份)需在此添加。
 */
interface ProtectedPath {
	readonly abs: string;
	readonly label: string;
}

const RAW_PROTECTED: ReadonlyArray<ProtectedPath> = [
	{ abs: coreDbPath, label: "core database (db/core.db)" },
	{ abs: coreDbPath + "-wal", label: "core database WAL (db/core.db-wal)" },
	{ abs: coreDbPath + "-shm", label: "core database SHM (db/core.db-shm)" },
	{ abs: wikiDbPath, label: "wiki database (db/wiki.db)" },
	{ abs: wikiDbPath + "-wal", label: "wiki database WAL (db/wiki.db-wal)" },
	{ abs: wikiDbPath + "-shm", label: "wiki database SHM (db/wiki.db-shm)" },
	{ abs: coreBackupDir, label: "core backup directory (backups/core)" },
	{ abs: wikiBackupDir, label: "wiki backup directory (backups/wiki)" },
	{ abs: WIKI_RUNTIME_DIR, label: "wiki runtime directory (wiki/.runtime)" },
	{ abs: WIKI_DISK_ROOT, label: "wiki disk store (wiki)" },
];

/**
 * Canonicalize a path string the way the FS tools do before checking. Accepts
 * relative paths (resolved against the optional workingDir) and returns the
 * absolute, normalized form. Returns null for inputs that don't look like a
 * path (empty / undefined).
 *
 * Implementation notes:
 *   - Strips surrounding quotes (handles `"foo"` / `'foo'`).
 *   - win32: lowercases drive letter + forward-slash normalize. resolve() on
 *     win32 already lowercases the drive, but be defensive.
 *   - DOES NOT resolve symlinks/junctions via realPathSync — see
 *     {@link resolveProtectedRealpath} for the symlink-aware variant. Callers
 *     that need symlink hardening use that helper after canonicalize.
 */
export function canonicalize(p: string, workingDir?: string): string | null {
	if (!p || typeof p !== "string") return null;
	let s = p.trim();
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		s = s.slice(1, -1);
	}
	if (!s) return null;
	const base = workingDir ?? process.cwd();
	const abs = isAbsolute(s) ? s : resolve(base, s);
	const norm = normalize(abs);
	return process.platform === "win32" ? norm.replace(/\\/g, "/").toLowerCase() : norm;
}

/** Canonicalize an internal protected path constant (always already absolute). */
function canonAbs(p: string): string {
	const norm = normalize(p);
	return process.platform === "win32" ? norm.replace(/\\/g, "/").toLowerCase() : norm;
}

/** Internal: lazily-computed canonical form of {@link RAW_PROTECTED}. */
const CANON_PROTECTED: ReadonlyArray<ProtectedPath> = RAW_PROTECTED.map((p) => ({
	abs: canonAbs(p.abs),
	label: p.label,
}));

/**
 * Returns true if the resolved path lives inside ANY protected root.
 *
 * Trailing-slash safe: `startsWith(root + "/")` and exact equality both match.
 * Matches on the lexical canonical path (post resolve+normalize+lowercase on
 * win32); does NOT follow symlinks. Symlink-aware variant:
 * {@link isProtectedPathRealpath}.
 */
export function isProtectedPath(p: string, workingDir?: string): boolean {
	const canon = canonicalize(p, workingDir);
	if (!canon) return false;
	for (const prot of CANON_PROTECTED) {
		if (canon === prot.abs || canon.startsWith(prot.abs + "/")) {
			return true;
		}
	}
	return false;
}

/**
 * Label for the first protected root that matches a path (for the reject
 * message). null if not protected.
 */
export function protectedPathLabel(p: string, workingDir?: string): string | null {
	const canon = canonicalize(p, workingDir);
	if (!canon) return null;
	for (const prot of CANON_PROTECTED) {
		if (canon === prot.abs || canon.startsWith(prot.abs + "/")) {
			return prot.label;
		}
	}
	return null;
}

/**
 * Snapshot of the protected-path list for diagnostics / tests. Returns
 * canonical absolute paths. Each entry is the canonical form (win32 lowercased
 * + forward slashes).
 */
export function listProtectedPaths(): ReadonlyArray<string> {
	return CANON_PROTECTED.map((p) => p.abs);
}

/**
 * DB_DIR (parent of core.db + wiki.db) — exposed for guards that want to
 * block *any* write into the db/ directory (covers future .db-journal too).
 *
 * Note: the per-file entries in {@link RAW_PROTECTED} are tighter; this helper
 * is for additional defense-in-depth (e.g. rejecting `db/*` glob).
 */
export const PROTECTED_DB_DIR = canonAbs(DB_DIR);

/**
 * Wiki disk root, canonicalized (win32 lowercased + forward slashes). Exported
 * so legacy helpers / wiki content stores share the same canonical form as the
 * guard.
 */
export const WIKI_DISK_ROOT_CANON = canonAbs(WIKI_DISK_ROOT);
