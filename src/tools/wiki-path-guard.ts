// FS path guard(wiki-system-redesign plan-08 §2 重写)
//
// # 文件说明书
//
// ## 核心功能
// Agent FS 工具(Shell / Read / Write / Edit / Grep / Glob)在执行前拦截一切
// 会落在受保护路径下的访问:
//
//   - 数据库主文件 + WAL/SHM(core.db / wiki.db + -wal / -shm)
//   - 备份目录(backups/core、backups/wiki)
//   - Wiki 运行时目录(wiki/.runtime)
//   - Wiki 磁盘正文根(wiki/)
//
// Agent 永远拿不到这些路径的真实访问能力;通过 Wiki tool(action:expand/read/
// upsert)操作 wiki 节点,通过管理 API 触发 snapshot/restore(不走 Agent shell)。
//
// ## 输入
//   - 单条 path 字符串(如 Read / Write 的 file_path)
//   - 一段 shell 命令文本(如 Shell 的 command)
//   - 多路径(grep / glob 的 path 参数)
//
// ## 输出
//   - rejectMessage: string | null —— 非空 = 拒绝原因,工具直接返回该错误;
//     null = 放行,继续执行
//
// ## 绕过防护(acceptance-08 §B 必须全过)
//   - 相对路径(../db/core.db)—— canonicalize 用 workingDir resolve
//   - 引号("../db/core.db" 或 '...')—— canonicalize 剥引号
//   - 环境变量($ZERO_CORE_DIR/db/core.db)—— shellResolveEnv 展开
//   - 大小写(Win C:/Users/...)—— canonicalize win32 小写
//   - symlink / junction(把 wiki 链到 workspace/wiki-bypass)——
//     isProtectedPathRealpath 走 realpathSync
//   - shell 拼接(cat ~/db/core.db)—— findWikiPathInShellCommand token 化
//
// ## 误伤防护
//   - 合法项目源码(workspaceDir/myproject/*)不在 ZERO_CORE_DIR 下 → 不误拦截
//   - workspaceDir 故意放在 ZERO_CORE_DIR 下(零用户这么做)→ 检测后 warn 但放行
//     项目源码(见 workspaceLeakHint)
//
// ## 依赖
//   - ../../core/protected-paths —— 受保护路径中央表(单源真相)
//
// ## 不做
//   - 不读 / 不写 / 不 stat 受保护路径(只字符串比对)
//   - 不拦截管理备份服务(它不走 Agent shell,直接调 SQLite Backup API)
//

import {
	canonicalize,
	isProtectedPath,
	protectedPathLabel,
} from "../core/protected-paths.js";
import { realpathSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Standard reject message returned to the agent when a path is blocked.
 * Actionable (tells the agent to use the wiki tool instead) so the model can
 * self-correct. Includes the matched protected label so the agent sees what
 * category it tried to touch.
 */
export function wikiPathRejectMessage(p: string): string {
	const label = protectedPathLabel(p) ?? "protected path";
	return (
		`Access denied: '${p}' is inside the ${label}, which is not directly ` +
		`accessible from Agent FS tools. ` +
		`Use Wiki { action:'expand', node } / { action:'read', node } to read wiki ` +
		`content, { action:'search', query } to find a node, ` +
		`{ action:'create'/'update'/'delete' } to edit the tree, or the management ` +
		`API (/api/wiki-admin) for snapshots / addresses / repository binding. ` +
		`Database files (db/core.db, db/wiki.db), WAL/SHM, backups/, and wiki/.runtime ` +
		`are never directly accessible — recovery goes through the management backup ` +
		`service, not through Read/Write/Shell. (plan-08 §2)`
	);
}

/**
 * Back-compat: the historical name was `isWikiDiskPath`. Now checks ALL
 * protected paths (not just wiki/), so the name is misleading — kept as an
 * alias so existing FS tool callers don't need a flag-day rename. New code
 * should call {@link isProtectedPath} directly from `core/protected-paths.ts`.
 */
export function isWikiDiskPath(p: string, workingDir?: string): boolean {
	return isProtectedPath(p, workingDir);
}

/**
 * Symlink/junction-aware variant: resolves the real path via `realpathSync`
 * (which follows links) and ALSO checks the lexical path. Catches the case
 * where an attacker symlinks `workspace/wiki-bypass` → `~/.zero-core/wiki/`
 * (lexical path looks fine, real path is inside the protected root).
 *
 * Two resolution paths:
 *   1. If the leaf EXISTS: `realpathSync(leaf)` follows terminal + in-path
 *      links. Catches read/overwrite of an existing file via a junction.
 *   2. If the leaf does NOT EXIST (Write-create of a new file): walk up to
 *      the deepest existing ancestor dir, resolve THAT via realpathSync
 *      (catches a junction anywhere along the path), then re-append the
 *      non-existent suffix and run the lexical `isProtectedPath` against the
 *      resolved ancestor. Without this branch, planting a new file inside a
 *      directory junction into wiki/ / backups/ / db/ would silently pass —
 *      an integrity-only bypass (fake wiki attachments / backup snapshots /
 *      manifest JSON). plan-08 §2 follow-up; defense-in-depth.
 *
 * The lexical check at the top is a fast path for both cases — if the lexical
 * path already resolves into a protected root (rare for attacks, common for
 * legit workspace files whose ancestors all sit in the workspace), we return
 * early without touching the disk.
 */
export function isProtectedPathRealpath(p: string, workingDir?: string): boolean {
	if (isProtectedPath(p, workingDir)) return true;
	// Try realpath for existing paths (catches symlinks/junctions).
	const canon = canonicalize(p, workingDir);
	if (!canon) return false;
	// canonicalize already lowercases on win32; realpathSync needs the original
	// path form (with backslashes / mixed case), so use the raw input.
	try {
		if (existsSync(p)) {
			const real = realpathSync(p);
			if (isProtectedPath(real, workingDir)) return true;
			return false;
		}
		// Write-create path: leaf does not exist. Walk up to the deepest
		// existing ancestor, resolve the ancestor via realpath (catches a
		// junction sitting at any path segment), then re-append the missing
		// suffix and check the resulting realpath-anchored path. Legit
		// workspace creates have ancestors inside the workspace (realpath
		// stays in the workspace → not protected); junction-into-protected
		// creates resolve into the protected root → blocked.
		const base = workingDir ?? process.cwd();
		const abs = isAbsolute(p) ? p : resolve(base, p);
		let existing = abs;
		let rootReached = false;
		while (!existsSync(existing)) {
			const parent = dirname(existing);
			if (parent === existing) { rootReached = true; break; }
			existing = parent;
		}
		if (rootReached || !existsSync(existing)) return false;
		let realAncestor: string;
		try {
			realAncestor = realpathSync(existing);
		} catch {
			return false;
		}
		// Re-append the non-existent tail. canonicalize (inside
		// isProtectedPath) runs `normalize` + win32 slash/case fold, so
		// mixing the ancestor's OS-native separator with the suffix's
		// original separator is fine.
		const suffix = abs.slice(existing.length);
		const realLeaf = suffix ? realAncestor + suffix : realAncestor;
		if (isProtectedPath(realLeaf, workingDir)) return true;
		return false;
	} catch {
		return false;
	}
}

/**
 * Inspect a shell command for paths that would land inside any protected root.
 * Best-effort: shell commands are arbitrary text, so we tokenize on whitespace
 * and check every token that looks like a path (absolute, or starting with
 * `./` / `../` / `~`). We do NOT try to parse redirects or complex shell
 * constructs — false negatives are possible but false positives (blocking
 * legitimate commands) are minimized by only flagging clear paths.
 *
 * Returns the first blocked path string, or null to allow.
 *
 * Expansion: `$ZERO_CORE_DIR` / `${ZERO_CORE_DIR}` are expanded before
 * tokenizing — without this, an agent could embed the env var to escape
 * lexical matching. `$HOME` / `~` are also expanded.
 */
export function findWikiPathInShellCommand(command: string, workingDir?: string): string | null {
	if (!command) return null;
	// Pre-expand common env-var references that point at ZERO_CORE_DIR / HOME.
	// This catches `$ZERO_CORE_DIR/db/core.db` and `~/.zero-core/wiki`.
	const expanded = expandEnvVars(command);
	// Quick reject: literal substring of any protected path appears verbatim.
	// This catches `cat ~/.zero-core/db/core.db` regardless of tokenization.
	const direct = expanded.match(
		/(\S*(?:\.zero-core[/\\](?:db|wiki|backups)|db[/\\]core\.db(?:-wal|-shm)?|db[/\\]wiki\.db(?:-wal|-shm)?|backups[/\\](?:core|wiki))\S*)/,
	);
	// Tokenize and check each path-like token.
	// round-2 Fix 2b (acceptance-08 §B+H blocker): each token is checked with
	// isProtectedPathRealpath (not the lexical-only isProtectedPath). This
	// catches Windows junction/symlink bypass where the lexical token sits in
	// workspace but the realpath resolves inside db/wiki/backups — e.g. an
	// agent runs `cat workspace/wiki-bypass/core.db` where wiki-bypass is a
	// junction to ~/.zero-core/db. Without the realpath step the lexical
	// check passes and the agent reads core.db directly through the shell.
	const tokens = expanded.split(/\s+|["'`;<>|(){}]/).filter(Boolean);
	for (const tok of tokens) {
		// Skip obvious flags/options.
		if (tok.startsWith("-")) continue;
		if (isProtectedPathRealpath(tok, workingDir)) return tok;
		// Also handle `~`-prefixed paths.
		if (tok.startsWith("~")) {
			const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
			const t = tok.replace(/^~/, home);
			if (isProtectedPathRealpath(t, workingDir)) return tok;
		}
	}
	// Direct substring match but no token-level resolution: still reject to
	// be safe — the agent clearly intended to touch a protected path.
	if (direct) {
		return direct[1];
	}
	return null;
}

/**
 * Expand `$ZERO_CORE_DIR` / `${ZERO_CORE_DIR}` / `$HOME` / `~` in a shell
 * command before tokenizing. Internal helper for {@link findWikiPathInShellCommand}.
 *
 * Does NOT evaluate arbitrary `$VAR` references — only the few that can reach
 * protected paths. (Other env vars don't expand to protected paths, so we
 * don't risk false positives from arbitrary expansion.)
 */
function expandEnvVars(s: string): string {
	const zcDir = process.env.ZERO_CORE_DIR ?? "";
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	let out = s;
	if (zcDir) {
		out = out.replace(/\$\{?ZERO_CORE_DIR\}?/g, zcDir);
	}
	if (home) {
		out = out.replace(/\$\{?HOME\}?/g, home);
		out = out.replace(/(^|\s)~/g, (_, pre) => pre + home);
	}
	return out;
}

/**
 * Workspace leak hint: returns a warning string if the given workspaceDir is
 * INSIDE the protected wiki/db roots. This is a configuration mistake — the
 * agent's project files would be unreachable. Returns null when the workspace
 * is fine.
 *
 * Used by the FS tool wiring to surface the misconfiguration once at startup
 * rather than per-call.
 */
export function workspaceLeakHint(workspaceDir: string): string | null {
	if (!workspaceDir) return null;
	if (isProtectedPath(workspaceDir)) {
		return (
			`Workspace directory '${workspaceDir}' is inside a protected path ` +
			`(wiki/db/backups/.runtime). Agent FS tools would block all access. ` +
			`Move the workspace outside ZERO_CORE_DIR to fix.`
		);
	}
	return null;
}
