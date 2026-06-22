// Wiki FS path guard (v0.8 P1 §10.1)
//
// # 文件说明书
//
// ## 核心功能
// agent FS 工具(Shell/Read/Grep/Glob/Write/Edit)在执行前拦截一切会落在
// `~/.zero-core/wiki/` 下的路径访问。wiki 正文只能通过 `Wiki` action 工具
// (expand/search 读,upsert 写)以 nodeId 操作;agent 永远拿不到正文文件的真实路径。
//
// ## 输入
// - 单条 path 字符串(如 Read/Write 的 file_path)
// - 一段 shell 命令文本(如 Shell 的 command)
// - 多路径(grep/glob 的 path 参数)
//
// ## 输出
// - rejectMessage: string | null  —— 非空 = 拒绝原因,工具直接返回该错误;
//   null = 放行,继续执行
//
// ## 定位
// runtime 工具层共用 helper,被六个 FS 工具的 execute() 入口调用。
//
// ## 依赖
// - node:path (resolve/normalize)
// - ../../server/wiki-node-store (WIKI_DISK_ROOT 常量复用)
//
// ## 维护规则
// - 路径判定必须 canonicalize(resolve+normalize+小写 on win32),否则
//   `../` 跨越 / 盘符变体能绕过
// - 误伤防护:wiki 根只匹配 `~/.zero-core/wiki`,不匹配 workspaceDir
//   下同名子目录(workspaceDir 不在 ~/.zero-core/wiki 下,正常不冲突,
//   acceptance-P1 "workspaceDir 读取不受影响")
//

import { resolve, normalize, isAbsolute } from "node:path";
import { WIKI_DISK_ROOT } from "../../server/wiki-node-store.js";

/**
 * Canonicalize a path string the way the FS tools do before checking. Accepts
 * relative paths (resolved against the optional workingDir) and returns the
 * absolute, normalized form. Returns null for inputs that don't look like a
 * path (empty / undefined).
 */
function canonicalize(p: string, workingDir?: string): string | null {
	if (!p || typeof p !== "string") return null;
	let s = p.trim();
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		s = s.slice(1, -1);
	}
	if (!s) return null;
	const base = workingDir ?? process.cwd();
	const abs = isAbsolute(s) ? s : resolve(base, s);
	const norm = normalize(abs);
	// win32: drive letter casing + forward-slash normalization. resolve() on
	// win32 already lowercases the drive, but be defensive.
	return process.platform === "win32" ? norm.replace(/\\/g, "/").toLowerCase() : norm;
}

/** Canonicalized wiki disk root, matching the canonicalize() transform above. */
const WIKI_DISK_ROOT_CANON = process.platform === "win32"
	? WIKI_DISK_ROOT.replace(/\\/g, "/").toLowerCase()
	: WIKI_DISK_ROOT;

/**
 * Returns true if the resolved path lives inside the wiki disk root. The
 * trailing slash avoids matching sibling directories that merely share a
 * prefix (e.g. ~/.zero-core/wiki-backup).
 */
export function isWikiDiskPath(p: string, workingDir?: string): boolean {
	const canon = canonicalize(p, workingDir);
	if (!canon) return false;
	const root = WIKI_DISK_ROOT_CANON.endsWith("/")
		? WIKI_DISK_ROOT_CANON
		: WIKI_DISK_ROOT_CANON + "/";
	return canon === WIKI_DISK_ROOT_CANON || canon.startsWith(root);
}

/**
 * Standard reject message returned to the agent when a path is blocked.
 * Actionable (tells the agent to use the wiki tool instead) so the model can
 * self-correct.
 */
export function wikiPathRejectMessage(p: string): string {
	return (
		`Access denied: '${p}' is inside the wiki memory store (~/.zero-core/wiki/), ` +
		`which is read/write only through the Wiki tool. ` +
		`Use Wiki { action:'search', query } to find a node, ` +
		`{ action:'expand', nodeId } to read a node + its children, ` +
		`{ action:'docRead', nodeId|path } to read a node's body, ` +
		`{ action:'create'/'update'/'delete' } to edit the tree, or ` +
		`{ action:'docWrite'/'docEdit' } to edit a node's body — never access ` +
		`the wiki directory directly via Read/Grep/Shell/Write/Edit. (P1 §10.1)`
	);
}

/**
 * Inspect a shell command for paths that would land inside the wiki disk root.
 * This is best-effort: shell commands are arbitrary text, so we tokenize on
 * whitespace and check every token that looks like a path (absolute, or
 * starting with `./` / `../` / `~`). We do NOT try to parse redirects or
// complex shell constructs — false negatives are possible but false positives
// (blocking legitimate commands) are minimized by only flagging clear paths.
 *
 * Returns the first blocked path string, or null to allow.
 */
export function findWikiPathInShellCommand(command: string, workingDir?: string): string | null {
	if (!command) return null;
	// Quick reject: the literal wiki root substring appears verbatim. Catches
	// `cat ~/.zero-core/wiki/foo.md` regardless of tokenization.
	const directMatch = command.includes(".zero-core/wiki/") || command.includes(".zero-core\\wiki\\");
	if (!directMatch) return null;
	// Tokenize and check each path-like token.
	const tokens = command.split(/\s+|["'`;<>|(){}]/).filter(Boolean);
	for (const tok of tokens) {
		// Skip obvious flags/options.
		if (tok.startsWith("-")) continue;
		if (isWikiDiskPath(tok, workingDir)) return tok;
		// Also handle `~`-prefixed paths.
		if (tok.startsWith("~")) {
			const expanded = tok.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? "");
			if (isWikiDiskPath(expanded, workingDir)) return tok;
		}
	}
	// Direct substring match but no token-level resolution: still reject to
	// be safe — the agent clearly intended to touch the wiki dir. Use the
	// substring as the "path" for the error message.
	return command.match(/(\S*\.zero-core[/\\]wiki[/\\]\S*)/)?.[1] ?? ".zero-core/wiki/";
}
