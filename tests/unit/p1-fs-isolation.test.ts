// P1 单元测试:wiki FS 隔离 (agent-loop 拦截)
//
// # 文件说明书
//
// ## 核心功能
// 验证 v0.8 P1 (acceptance-P1.md「FS 隔离」节):
//   - 6 个 FS 工具(Shell/Read/Grep/Glob/Write/Edit)的 path guard 模块
//     (wiki-path-guard.ts)正确拦截 ~/.zero-core/wiki/ 路径访问
//   - canonicalize 防御:相对路径 / `../` 跨越 / 盘符变体 / 引号包裹
//   - workspaceDir 同名子目录不误拦(workspaceDir 不在 ~/.zero-core/wiki 下)
//   - shell command scan 抓 .zero-core/wiki/ 字面引用 + token-level 解析
//
// ## 输入
// 直接调用 wiki-path-guard 的导出函数(无需 SessionDB)。
//
// ## 输出
// Vitest 用例。
//
// ## 关键文件
//   - src/runtime/tools/wiki-path-guard.ts (isWikiDiskPath /
//    wikiPathRejectMessage / findWikiPathInShellCommand)
//   - WIKI_DISK_ROOT 常量复用 (src/server/wiki-node-store.ts)
//
// ## 维护规则
//   - 不真启动 agent-loop / 6 个 FS 工具;只验 guard 函数本身(单元粒度)。
//     端到端工具集成由 e2e 测试覆盖。
//   - 路径判定必须 canonicalize,加测试覆盖 `../` / 引号 / 大小写(win32)。
//

import { describe, test, expect } from "vitest";
import {
	isWikiDiskPath,
	wikiPathRejectMessage,
	findWikiPathInShellCommand,
} from "../../src/runtime/tools/wiki-path-guard.js";
import { WIKI_DISK_ROOT } from "../../src/server/wiki-node-store.js";
import { join, normalize, resolve } from "node:path";

// Canonical form of WIKI_DISK_ROOT matching how isWikiDiskPath canonicalizes.
const WIKI_DISK_ROOT_CANON = process.platform === "win32"
	? WIKI_DISK_ROOT.replace(/\\/g, "/").toLowerCase()
	: WIKI_DISK_ROOT;

// ─── isWikiDiskPath:path 类输入拦截 ──────────────────────────

describe("P1 §10.1 FS 隔离:isWikiDiskPath", () => {
	test("绝对 wiki 路径被识别", () => {
		const p = join(WIKI_DISK_ROOT, "projects", "p1", "foo.md");
		expect(isWikiDiskPath(p)).toBe(true);
		// wiki root itself.
		expect(isWikiDiskPath(WIKI_DISK_ROOT)).toBe(true);
	});

	test("wiki 根下的 nested 路径被识别", () => {
		expect(isWikiDiskPath(join(WIKI_DISK_ROOT, "memory", "_legacy", "x.md"))).toBe(true);
		expect(isWikiDiskPath(join(WIKI_DISK_ROOT, "knowledge", "y.md"))).toBe(true);
	});

	test("workspaceDir 同名 wiki 子目录不误拦(在 workspaceDir 内)", () => {
		// A workspace like /tmp/myws/wiki/foo.md must NOT be flagged — it lives
		// in the workspace, not in ~/.zero-core/wiki/.
		const ws = process.platform === "win32" ? "C:/tmp/myws" : "/tmp/myws";
		const inside = join(ws, "wiki", "foo.md");
		expect(isWikiDiskPath(inside)).toBe(false);
	});

	test("sibling 目录(.zero-core/wiki-backup)不误拦", () => {
		// Trailing-slash rule: wiki-backup shares prefix but is a sibling.
		const sibling = WIKI_DISK_ROOT + "-backup";
		expect(isWikiDiskPath(sibling)).toBe(false);
	});

	test("相对路径靠 workingDir 解析后命中 wiki 根", () => {
		// workingDir inside wiki → relative `./x.md` resolves into wiki.
		const ws = join(WIKI_DISK_ROOT, "projects", "p1");
		expect(isWikiDiskPath("./x.md", ws)).toBe(true);
	});

	test("../ 跨越仍命中 wiki 根(无 escape)", () => {
		// From inside wiki, `../../../` doesn't escape the wiki-ness check —
		// canonicalize+normalize still lands inside wiki when the start did.
		const ws = join(WIKI_DISK_ROOT, "projects", "p1");
		// Going up out of wiki → outside, should NOT match (correctly).
		const escaped = isWikiDiskPath("../../../../etc/passwd", ws);
		expect(escaped).toBe(false);
		// Going up but then back into wiki → matches.
		const reEntry = isWikiDiskPath("../../projects/p2/x.md", ws);
		expect(reEntry).toBe(true);
	});

	test("引号包裹的路径被剥离后再判定", () => {
		const quoted = `"${join(WIKI_DISK_ROOT, "x.md")}"`;
		expect(isWikiDiskPath(quoted)).toBe(true);
		const single = `'${join(WIKI_DISK_ROOT, "y.md")}'`;
		expect(isWikiDiskPath(single)).toBe(true);
	});

	test("win32:盘符大小写不敏感(防御)", () => {
		if (process.platform !== "win32") return; // skip on non-win32
		// WIKI_DISK_ROOT typically lives under C:\Users\...\~\.zero-core.
		// Build an uppercase-drive variant and confirm match.
		const upper = WIKI_DISK_ROOT.replace(/^([a-zA-Z]):/, (_, d) => d.toUpperCase() + ":");
		expect(isWikiDiskPath(join(upper, "z.md"))).toBe(true);
	});

	test("empty / undefined / null 输入不误报", () => {
		expect(isWikiDiskPath("")).toBe(false);
		expect(isWikiDiskPath("   ")).toBe(false);
		// @ts-expect-error — runtime defensive
		expect(isWikiDiskPath(undefined)).toBe(false);
		// @ts-expect-error — runtime defensive
		expect(isWikiDiskPath(null)).toBe(false);
	});
});

// ─── wikiPathRejectMessage:错误文本 ───────────────────────────

describe("P1 §10.1 FS 隔离:wikiPathRejectMessage", () => {
	test("错误文本引导 agent 改用 wiki 工具(ExpandNode/UpdateWikiNode)", () => {
		const msg = wikiPathRejectMessage("/some/path/foo.md");
		expect(msg).toMatch(/Access denied/i);
		expect(msg).toContain("ExpandNode");
		expect(msg).toContain("UpdateWikiNode");
		expect(msg).toContain("nodeId");
		// Must reference P1 spec anchor for traceability.
		expect(msg).toContain("P1 §10.1");
	});
});

// ─── findWikiPathInShellCommand:Shell 拦截 ───────────────────

describe("P1 §10.1 FS 隔离:findWikiPathInShellCommand (Shell 拦截)", () => {
	test("literal .zero-core/wiki/ 引用命中", () => {
		// Both forward-slash and backslash variants.
		expect(findWikiPathInShellCommand(`cat ~/.zero-core/wiki/foo.md`)).not.toBeNull();
		if (process.platform === "win32") {
			expect(findWikiPathInShellCommand(`type %USERPROFILE%\\.zero-core\\wiki\\foo.md`)).not.toBeNull();
		}
	});

	test("无 wiki 引用的命令放行", () => {
		expect(findWikiPathInShellCommand(`ls -la /tmp/`)).toBeNull();
		expect(findWikiPathInShellCommand(`git log --oneline -5`)).toBeNull();
		expect(findWikiPathInShellCommand(`npm run build`)).toBeNull();
		expect(findWikiPathInShellCommand(`echo hello world`)).toBeNull();
	});

	test("token 级路径解析(workspaceDir 内 .zero-core/wiki 不误伤)", () => {
		// A workspace dir legitimately named "wiki" inside a project workspace
		// — the literal substring `.zero-core/wiki/` is NOT present, so it
		// must NOT match.
		expect(findWikiPathInShellCommand(`cat ./wiki/foo.md`, "/tmp/myws")).toBeNull();
	});

	test("空命令 / undefined 放行", () => {
		expect(findWikiPathInShellCommand("")).toBeNull();
		// @ts-expect-error — runtime defensive
		expect(findWikiPathInShellCommand(undefined)).toBeNull();
	});

	test("复杂命令(multiple args + redirects)仍命中 wiki 引用", () => {
		expect(findWikiPathInShellCommand(
			`grep -r "foo" ~/.zero-core/wiki/ > /tmp/out.txt`,
		)).not.toBeNull();
	});
});
