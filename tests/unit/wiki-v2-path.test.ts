// wiki-system-redesign sub-01 acceptance — 规约 (spec-compliance) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-01 §A items 6, 7, 8(plan-01 §3 + design.md §4.2)的
// canonical path 规约:
//   - normalizeWikiPath 对合法路径产生唯一 canonical form(去重复 `/`、末尾 `/`、
//     首尾空白)。
//   - 拒绝:`.` / `..` / 反斜线 / 控制字符(U+0000-001F, U+007F) / 逻辑地址 scheme
//     (memory:// / project:// / runtime://) / 越界长度(name>256 或 path>32 segments)。
//   - isSameOrDescendant 段基匹配:`("wiki-root/a","wiki-root/ab") === false`。
//   - 大小写保留(Git 路径大小写,不依赖 Windows FS 行为)。
//   - joinWikiPath / parentWikiPath / validateWikiName 边界。
//
// ## 输入
//   纯函数(不读文件系统、不查 DB),不需要 temp DB / ZERO_CORE_DIR 隔离。
//
// ## 输出
// Vitest 用例,每个用例断言真实行为(失败实现会 fail)。
//
// ## 维护规则
//   - 仅 import 路径模块;绝不触碰实现源。
//   - 控制字符用 String.fromCharCode 构造,避免源文件中嵌入不可见字符。

import { describe, test, expect } from "vitest";

import {
	normalizeWikiPath,
	joinWikiPath,
	parentWikiPath,
	isSameOrDescendant,
	validateWikiName,
	splitWikiPath,
	lastSegmentOfWikiPath,
	isWikiRoot,
	WIKI_ROOT_PATH,
	WIKI_NAME_MAX_LENGTH,
	WIKI_PATH_MAX_SEGMENTS,
} from "../../src/server/wiki/wiki-path.js";

/** 构造含控制字符的字符串(避免源文件嵌入不可见字符)。 */
function ctrl(code: number): string {
	return String.fromCharCode(code);
}

/** 从抛出的 Error 中提取 code 字段(实现用 err.code 携带 WikiErrorCode)。 */
function errCode(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (e) {
		return (e as Error & { code?: string }).code;
	}
	return undefined;
}

describe("wiki-v2 canonical path [spec-compliance lens]", () => {
	// -----------------------------------------------------------------------
	// §A item 6: 合法路径产生唯一 canonical form
	// -----------------------------------------------------------------------

	describe("§A.6 normalizeWikiPath canonical form", () => {
		test("root canonicalizes to 'wiki-root'", () => {
			expect(normalizeWikiPath("wiki-root")).toBe("wiki-root");
		});

		test("trailing slash removed", () => {
			expect(normalizeWikiPath("wiki-root/knowledge/")).toBe("wiki-root/knowledge");
		});

		test("duplicate slashes collapsed", () => {
			expect(normalizeWikiPath("wiki-root//knowledge///topic")).toBe("wiki-root/knowledge/topic");
		});

		test("surrounding whitespace trimmed", () => {
			expect(normalizeWikiPath("   wiki-root/knowledge\t")).toBe("wiki-root/knowledge");
		});

		test("multiple surface forms of the same logical path collapse to ONE canonical string", () => {
			const forms = [
				"wiki-root/knowledge/topic",
				"wiki-root/knowledge/topic/",
				"wiki-root//knowledge//topic",
				"  wiki-root/knowledge/topic  ",
				"wiki-root/knowledge///topic",
			];
			const canonical = forms.map((f) => normalizeWikiPath(f));
			expect(new Set(canonical).size).toBe(1);
			expect(canonical[0]).toBe("wiki-root/knowledge/topic");
		});

		test("deep legal path passes (boundary: exactly MAX_SEGMENTS allowed)", () => {
			// wiki-root + (MAX-1) children = MAX segments total (within WIKI_PATH_MAX_SEGMENTS)
			const segs = ["wiki-root"];
			for (let i = 0; i < WIKI_PATH_MAX_SEGMENTS - 1; i++) segs.push(`s${i}`);
			expect(normalizeWikiPath(segs.join("/"))).toBe(segs.join("/"));
		});
	});

	// -----------------------------------------------------------------------
	// §A item 7: rejections
	// -----------------------------------------------------------------------

	describe("§A.7 normalizeWikiPath rejects illegal input", () => {
		test("empty string rejected with INVALID_PATH", () => {
			expect(errCode(() => normalizeWikiPath(""))).toBe("INVALID_PATH");
		});

		test("whitespace-only rejected with INVALID_PATH", () => {
			expect(errCode(() => normalizeWikiPath("   "))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath("\t\t"))).toBe("INVALID_PATH");
		});

		test("path whose first segment is not 'wiki-root' rejected", () => {
			expect(errCode(() => normalizeWikiPath("knowledge/topic"))).toBe("INVALID_PATH");
			// 大小写敏感:Wiki-Root ≠ wiki-root
			expect(errCode(() => normalizeWikiPath("Wiki-Root/knowledge"))).toBe("INVALID_PATH");
		});

		test("'.' segment rejected", () => {
			expect(errCode(() => normalizeWikiPath("wiki-root/./knowledge"))).toBe("INVALID_PATH");
		});

		test("'..' segment rejected", () => {
			expect(errCode(() => normalizeWikiPath("wiki-root/knowledge/.."))).toBe("INVALID_PATH");
		});

		test("backslash rejected with INVALID_PATH", () => {
			expect(errCode(() => normalizeWikiPath("wiki-root\\knowledge"))).toBe("INVALID_PATH");
			expect(errCode(() => normalizeWikiPath("wiki-root/knowledge\\topic"))).toBe("INVALID_PATH");
		});

		test("control char anywhere in path rejected (NUL \\u0000, TAB \\u0009, LF \\u000A, DEL \\u007F)", () => {
			// 实现先 trim 整体,再逐字符扫描 trimmed 检测控制字符。
			expect(errCode(() => normalizeWikiPath(`wiki-root/know${ctrl(0x0000)}ledge`))).toBe(
				"INVALID_PATH",
			);
			expect(errCode(() => normalizeWikiPath(`wiki-root/know${ctrl(0x0009)}ledge`))).toBe(
				"INVALID_PATH",
			);
			expect(errCode(() => normalizeWikiPath(`wiki-root/know${ctrl(0x000a)}ledge`))).toBe(
				"INVALID_PATH",
			);
			expect(errCode(() => normalizeWikiPath(`wiki-root/know${ctrl(0x007f)}ledge`))).toBe(
				"INVALID_PATH",
			);
			// 边界:0x1f 是控制,0x20 (space) 不是(但 space 在段内由 validateWikiName 处理)。
			expect(errCode(() => normalizeWikiPath(`wiki-root/a${ctrl(0x001f)}b`))).toBe("INVALID_PATH");
		});

		test("memory:// scheme rejected", () => {
			expect(errCode(() => normalizeWikiPath("memory://agent-1"))).toBe("INVALID_PATH");
		});

		test("project:// scheme rejected", () => {
			expect(errCode(() => normalizeWikiPath("project://zero-core"))).toBe("INVALID_PATH");
		});

		test("runtime:// scheme rejected", () => {
			expect(errCode(() => normalizeWikiPath("runtime://rules/global"))).toBe("INVALID_PATH");
		});

		test("name exceeding WIKI_NAME_MAX_LENGTH rejected (validateWikiName fires INVALID_NAME)", () => {
			const tooLong = "a".repeat(WIKI_NAME_MAX_LENGTH + 1);
			// 实现对每个非根段调用 validateWikiName,所以越界名报 INVALID_NAME
			//(路径级整体越深才报 INVALID_PATH)。
			expect(errCode(() => normalizeWikiPath(`wiki-root/${tooLong}`))).toBe("INVALID_NAME");
		});

		test("path exceeding WIKI_PATH_MAX_SEGMENTS rejected", () => {
			const segs = ["wiki-root"];
			for (let i = 0; i < WIKI_PATH_MAX_SEGMENTS; i++) segs.push(`s${i}`); // 总 = MAX+1 > MAX
			expect(errCode(() => normalizeWikiPath(segs.join("/"))).startsWith("INVALID_")).toBe(true);
		});

		test("name with leading whitespace (mid-path) rejected via validateWikiName", () => {
			// 整体无首尾空白,不会被整体 trim 吃掉;段 " abc" 由 validateWikiName 拒。
			expect(errCode(() => normalizeWikiPath("wiki-root/ abc/def")).startsWith("INVALID_")).toBe(
				true,
			);
		});

		test("name with trailing whitespace (mid-path) rejected via validateWikiName", () => {
			// 段 "abc " 含尾空白,validateWikiName 拒。
			expect(errCode(() => normalizeWikiPath("wiki-root/abc /def")).startsWith("INVALID_")).toBe(
				true,
			);
		});
	});

	// -----------------------------------------------------------------------
	// §A item 7: validateWikiName (name-level rejections)
	// -----------------------------------------------------------------------

	describe("§A.7 validateWikiName", () => {
		test("legal names pass", () => {
			expect(() => validateWikiName("knowledge")).not.toThrow();
			expect(() => validateWikiName("topic-1")).not.toThrow();
			expect(() => validateWikiName("zero_core")).not.toThrow();
			expect(() => validateWikiName("a.b.c")).not.toThrow();
			// 256-char name 是合法上限
			expect(() => validateWikiName("a".repeat(WIKI_NAME_MAX_LENGTH))).not.toThrow();
		});

		test("empty rejected with INVALID_NAME", () => {
			expect(errCode(() => validateWikiName(""))).toBe("INVALID_NAME");
		});

		test("whitespace-only rejected (trim-length mismatch)", () => {
			expect(errCode(() => validateWikiName(" "))).toBe("INVALID_NAME");
			expect(errCode(() => validateWikiName("   "))).toBe("INVALID_NAME");
		});

		test("containing slash rejected", () => {
			expect(errCode(() => validateWikiName("a/b"))).toBe("INVALID_NAME");
		});

		test("containing backslash rejected", () => {
			expect(errCode(() => validateWikiName("a\\b"))).toBe("INVALID_NAME");
		});

		test("'.' and '..' rejected", () => {
			expect(errCode(() => validateWikiName("."))).toBe("INVALID_NAME");
			expect(errCode(() => validateWikiName(".."))).toBe("INVALID_NAME");
		});

		test("control char rejected", () => {
			expect(errCode(() => validateWikiName(`a${ctrl(0x0001)}b`))).toBe("INVALID_NAME");
			expect(errCode(() => validateWikiName(`a${ctrl(0x007f)}b`))).toBe("INVALID_NAME");
		});

		test("over-length rejected", () => {
			expect(errCode(() => validateWikiName("a".repeat(WIKI_NAME_MAX_LENGTH + 1)))).toBe(
				"INVALID_NAME",
			);
		});

		test("scheme prefix rejected", () => {
			expect(errCode(() => validateWikiName("memory://x"))).toBe("INVALID_NAME");
			expect(errCode(() => validateWikiName("project://x"))).toBe("INVALID_NAME");
		});
	});

	// -----------------------------------------------------------------------
	// §A item 8: segment-exact matching
	// -----------------------------------------------------------------------

	describe("§A.8 isSameOrDescendant (segment-exact, case-sensitive)", () => {
		test("KEY: 'wiki-root/a' vs 'wiki-root/ab' is FALSE (segment-exact)", () => {
			expect(isSameOrDescendant("wiki-root/a", "wiki-root/ab")).toBe(false);
			expect(isSameOrDescendant("wiki-root/ab", "wiki-root/a")).toBe(false);
		});

		test("self → true", () => {
			expect(isSameOrDescendant("wiki-root/a", "wiki-root/a")).toBe(true);
			expect(isSameOrDescendant("wiki-root", "wiki-root")).toBe(true);
		});

		test("descendant → true", () => {
			expect(isSameOrDescendant("wiki-root/a", "wiki-root/a/b")).toBe(true);
			expect(isSameOrDescendant("wiki-root", "wiki-root/a/b/c")).toBe(true);
		});

		test("sibling (not descendant) → false", () => {
			expect(isSameOrDescendant("wiki-root/a", "wiki-root/b")).toBe(false);
		});

		test("parent (shallower than scope) → false", () => {
			expect(isSameOrDescendant("wiki-root/a/b", "wiki-root/a")).toBe(false);
		});

		test("longer prefix overlap still false: 'wiki-root/ab' vs 'wiki-root/abc/d'", () => {
			expect(isSameOrDescendant("wiki-root/ab", "wiki-root/abc/d")).toBe(false);
		});

		test("case-sensitive: 'wiki-root/A' vs 'wiki-root/a/b' → false", () => {
			expect(isSameOrDescendant("wiki-root/A", "wiki-root/a/b")).toBe(false);
			expect(isSameOrDescendant("wiki-root/A", "wiki-root/A/B")).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// case preservation
	// -----------------------------------------------------------------------

	describe("case preservation (Git path case, FS-independent)", () => {
		test("normalizeWikiPath preserves mixed-case segments", () => {
			expect(normalizeWikiPath("wiki-root/Knowledge/MyTopic")).toBe("wiki-root/Knowledge/MyTopic");
		});

		test("'Wiki-Root' is NOT auto-corrected to 'wiki-root' (rejected — must be exactly wiki-root)", () => {
			// 首段必须精确等于 'wiki-root'(小写)。'Wiki-Root' 不被接受。
			expect(errCode(() => normalizeWikiPath("Wiki-Root/knowledge"))).toBe("INVALID_PATH");
		});
	});

	// -----------------------------------------------------------------------
	// joinWikiPath / parentWikiPath / helpers
	// -----------------------------------------------------------------------

	describe("joinWikiPath", () => {
		test("parent + name → child path", () => {
			expect(joinWikiPath("wiki-root/knowledge", "topic")).toBe("wiki-root/knowledge/topic");
		});

		test("parent is normalized first", () => {
			expect(joinWikiPath("wiki-root//knowledge/", "topic")).toBe("wiki-root/knowledge/topic");
		});

		test("invalid name rejected", () => {
			expect(() => joinWikiPath("wiki-root", "")).toThrow();
			expect(() => joinWikiPath("wiki-root", "a/b")).toThrow();
		});

		test("invalid parent rejected", () => {
			expect(() => joinWikiPath("memory://x", "y")).toThrow();
		});

		test("joining onto root works", () => {
			expect(joinWikiPath("wiki-root", "knowledge")).toBe("wiki-root/knowledge");
		});
	});

	describe("parentWikiPath", () => {
		test("root has no parent → null", () => {
			expect(parentWikiPath("wiki-root")).toBeNull();
		});

		test("depth-1 child → root", () => {
			expect(parentWikiPath("wiki-root/knowledge")).toBe("wiki-root");
		});

		test("deep child → immediate parent", () => {
			expect(parentWikiPath("wiki-root/knowledge/topic")).toBe("wiki-root/knowledge");
		});

		test("normalizes input first", () => {
			expect(parentWikiPath("wiki-root//knowledge/topic/")).toBe("wiki-root/knowledge");
		});

		test("rejects illegal input", () => {
			expect(() => parentWikiPath("memory://x")).toThrow();
		});
	});

	describe("splitWikiPath / lastSegmentOfWikiPath / isWikiRoot", () => {
		test("splitWikiPath returns normalized segments", () => {
			expect(splitWikiPath("wiki-root//knowledge/topic/")).toEqual([
				"wiki-root",
				"knowledge",
				"topic",
			]);
		});

		test("lastSegmentOfWikiPath returns the final segment", () => {
			expect(lastSegmentOfWikiPath("wiki-root/knowledge/topic")).toBe("topic");
			expect(lastSegmentOfWikiPath("wiki-root")).toBe(WIKI_ROOT_PATH);
		});

		test("isWikiRoot true only for the canonical root; rejects non-wiki-root input", () => {
			expect(isWikiRoot("wiki-root")).toBe(true);
			expect(isWikiRoot("wiki-root/")).toBe(true); // normalizes to root
			expect(isWikiRoot("wiki-root/knowledge")).toBe(false);
			// 非法输入(Wiki-Root 大小写错)走 normalizeWikiPath → 抛 INVALID_PATH。
			// 这是合理行为:isWikiRoot 不静默吞非法路径。
			expect(errCode(() => isWikiRoot("Wiki-Root"))).toBe("INVALID_PATH");
		});
	});
});
