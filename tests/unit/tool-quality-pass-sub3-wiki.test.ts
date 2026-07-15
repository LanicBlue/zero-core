// tool-quality-pass sub-3 验收 (verifier-driven, 独立对抗式)
//
// # 文件说明书
//
// ## 核心功能
// 验收 docs/plan/tool-quality-pass/acceptance-3.md 的 16 条:
//   #2 regex (1-5): regex:true 按正则 / 默认子串不回归 / type 过滤叠加 / 非法 regex 不崩 /
//                  大小写不敏感
//   #3 计数  (6-9): 非叶 ▾direct(total) / 叶 leaf / 总数算对 / 基本输出不回归
//   #4 path  (10-14): path 直达深层 / 末段 * 展子层 / path 优先 nodeId / path 定位失败
//                     清晰错误 / 纯 nodeId 不回归
//   通用   (15-16): typecheck + 既有 wiki 测试不回归
//
// 另加对抗式核心检查:resolveNode 重构(委托 walkTitlePath helper)是否破坏了
// doc op 的 path 寻址契约(docRead/docWrite/docEdit 用 path)。
//
// ## 策略
// 真 SQLite (mkdtempSync 临时 DB) + 真 WikiStore + wikiTool.execute 驱动 ——
// 完全照 sub2-memory-routing.test.ts 的 harness(信任既有验证模式,而非 implementer claim)。
// wiki-tool 通过 getWikiStoreGlobal() 直读全局单例,所以用 setWikiStoreGlobal 注册。
//
// ## 维护规则
// 改 src/tools/wiki-tool.ts 的 search / expand / resolveNode / walkTitlePath 时
// 同步本测试。
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import {
	WikiStore,
	WIKI_GLOBAL_ROOT_ID,
	getWikiStoreGlobal,
	setWikiStoreGlobal,
} from "../../src/server/wiki-node-store.js";
import { wikiTool } from "../../src/tools/wiki-tool.js";
import { getToolExecute } from "../../src/tools/tool-factory.js";
import { shortIdOf } from "../../src/runtime/wiki-anchor-injection.js";
import type { CallerCtx } from "../../src/tools/types.js";
import type { WikiNode } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let sessionDB: SessionDB;
let wiki: WikiStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-sub3-verifier-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	wiki = new WikiStore(sessionDB);
	// wiki-tool 直读全局单例 (getWikiStoreGlobal); 注册本用例实例。
	setWikiStoreGlobal(wiki);
});

afterEach(() => {
	setWikiStoreGlobal(undefined);
	try { sessionDB.close(); } catch { /* gone */ }
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Drive wikiTool.execute → extract the agent-facing text (mirrors sub2 harness). */
async function execWiki(input: any, callerCtx: CallerCtx): Promise<string> {
	const exec = getToolExecute(wikiTool)!;
	const result: any = await exec(input, callerCtx);
	return result?.data?.text ?? "";
}

/** callerCtx scoped to GLOBAL_ROOT (whole-tree read+write). */
function globalCtx(): CallerCtx {
	return {
		caller: "internal",
		wikiAnchorNodeIds: [WIKI_GLOBAL_ROOT_ID],
	};
}

/** Direct-create a node bypassing the anchor-scope path (test seed). */
function makeNode(
	parentId: string,
	title: string,
	opts: {
		path?: string;
		summary?: string;
		nodeType?: string;
		projectId?: string;
		flags?: string[];
	} = {},
): WikiNode {
	// path defaults to bare title (no type prefix); nodeType drives deriveTypeFromPosition.
	return wiki.create({
		parentId,
		path: opts.path ?? title,
		title,
		summary: opts.summary,
		nodeType: opts.nodeType,
		projectId: opts.projectId,
		flags: opts.flags,
		lastUpdatedBy: "test",
	} as any);
}

/** Short id (#xxxxxxxx) of a node — what expand/search/anchor outlines show. */
function shortId(id: string): string {
	return `#${shortIdOf(id)}`;
}

// ===========================================================================
// #2 regex
// ===========================================================================

describe("[sub-3 #2 regex]", () => {
	test("#1 regex:true 跨字符匹配 (foo.*bar 命中 'foo-bar' / 'fooXYZbar')", async () => {
		// Two nodes whose titles contain "foo" then later "bar" with various gaps.
		makeNode(WIKI_GLOBAL_ROOT_ID, "alpha-foo-bar-baz", {
			summary: "regex should match this",
			nodeType: "directory",
		});
		makeNode(WIKI_GLOBAL_ROOT_ID, "no-match-here", {
			summary: "nothing relevant",
			nodeType: "directory",
		});
		makeNode(WIKI_GLOBAL_ROOT_ID, "alpha-fooXYZbar-baz", {
			summary: "regex . also matches this",
			nodeType: "directory",
		});

		const out = await execWiki(
			{ action: "search", query: "foo.*bar", regex: true },
			globalCtx(),
		);
		expect(out).toContain("alpha-foo-bar-baz");
		expect(out).toContain("alpha-fooXYZbar-baz");
		expect(out).not.toContain("no-match-here");
	});

	test("#2 默认子串不回归 — `a.b` 字面匹配(`.` 不是任意)", async () => {
		// Literal "a.b" should match; "axb" / "a-b" should NOT (no regex).
		makeNode(WIKI_GLOBAL_ROOT_ID, "literal-a.b-text", { nodeType: "directory" });
		makeNode(WIKI_GLOBAL_ROOT_ID, "literal-axb-text", { nodeType: "directory" });
		makeNode(WIKI_GLOBAL_ROOT_ID, "literal-a-b-text", { nodeType: "directory" });

		const out = await execWiki(
			{ action: "search", query: "a.b" },
			globalCtx(),
		);
		expect(out).toContain("literal-a.b-text");
		// These must NOT appear — confirms `.` is literal in substring mode.
		expect(out).not.toContain("literal-axb-text");
		expect(out).not.toContain("literal-a-b-text");
	});

	test("#2b regex `.` IS any char when regex:true (cross-check)", async () => {
		makeNode(WIKI_GLOBAL_ROOT_ID, "literal-axb-text", { nodeType: "directory" });
		const out = await execWiki(
			{ action: "search", query: "a.b", regex: true },
			globalCtx(),
		);
		// With regex:true, `a.b` matches "axb" — proves regex mode differs from substring.
		expect(out).toContain("literal-axb-text");
	});

	test("#3 type 过滤仍生效 (regex + type 叠加;substring + type 叠加)", async () => {
		// Create one header + one structure node, both containing "alpha".
		makeNode(WIKI_GLOBAL_ROOT_ID, "alpha-header", {
			nodeType: "file", // → deriveTypeFromPosition returns "header"
			path: "header:src/foo.ts",
		});
		makeNode(WIKI_GLOBAL_ROOT_ID, "alpha-structure", {
			nodeType: "directory", // → "structure"
			path: "struct:bar",
		});

		// substring + type filter
		const sub = await execWiki(
			{ action: "search", query: "alpha", type: "header" },
			globalCtx(),
		);
		expect(sub).toContain("alpha-header");
		expect(sub).not.toContain("alpha-structure");

		// regex + type filter (regex:true combined with type)
		const rx = await execWiki(
			{ action: "search", query: "alph.", regex: true, type: "structure" },
			globalCtx(),
		);
		expect(rx).toContain("alpha-structure");
		expect(rx).not.toContain("alpha-header");
	});

	test("#4 非法 regex → 友好错误(不抛崩)", async () => {
		// Invalid regex must NOT throw — execute must return a friendly error string.
		let out: string;
		try {
			out = await execWiki(
				{ action: "search", query: "(unclosed", regex: true },
				globalCtx(),
			);
		} catch (err) {
			throw new Error(`regex search THREW instead of returning friendly error: ${(err as Error).message}`);
		}
		expect(out).toMatch(/^Error: Invalid regex: /);
		expect(out).toContain("(unclosed");
	});

	test("#5 大小写不敏感 — regex 与子串都忽略大小写", async () => {
		makeNode(WIKI_GLOBAL_ROOT_ID, "UPPERCASE-TITLE", {
			summary: "MixedCaseSummary",
			nodeType: "directory",
		});
		// substring: lowercase query matches uppercase title.
		const sub = await execWiki(
			{ action: "search", query: "uppercase-title" },
			globalCtx(),
		);
		expect(sub).toContain("UPPERCASE-TITLE");
		// regex: lowercase query matches uppercase title (regex i flag).
		const rx = await execWiki(
			{ action: "search", query: "uppercase.title", regex: true },
			globalCtx(),
		);
		expect(rx).toContain("UPPERCASE-TITLE");

		// And query UPPERCASE matches lowercase title.
		makeNode(WIKI_GLOBAL_ROOT_ID, "lowercase-title", { nodeType: "directory" });
		const sub2 = await execWiki(
			{ action: "search", query: "LOWERCASE-TITLE" },
			globalCtx(),
		);
		expect(sub2).toContain("lowercase-title");
	});
});

// ===========================================================================
// #3 计数 (▾direct(total) / leaf)
// ===========================================================================

describe("[sub-3 #3 计数 ▾direct(total)]", () => {
	// Tree for counting tests:
	//   marker-root
	//     middle             (direct=2: l1, l2;  total=8: 2 + 3 + 3)
	//       l1               (direct=3: gc1,gc2,gc3;  total=3)
	//         gc1,gc2,gc3    (leaves)
	//       l2               (direct=3: gc4,gc5,gc6;  total=3)
	//         gc4,gc5,gc6    (leaves)
	let markerRoot: WikiNode;
	let middle: WikiNode;
	let l1: WikiNode;
	let l2: WikiNode;

	beforeEach(() => {
		markerRoot = makeNode(WIKI_GLOBAL_ROOT_ID, "marker-root", { nodeType: "directory" });
		middle = makeNode(markerRoot.id, "middle", { nodeType: "directory" });
		l1 = makeNode(middle.id, "l1", { nodeType: "directory" });
		l2 = makeNode(middle.id, "l2", { nodeType: "directory" });
		for (const t of ["gc1", "gc2", "gc3"]) makeNode(l1.id, t, { nodeType: "directory" });
		for (const t of ["gc4", "gc5", "gc6"]) makeNode(l2.id, t, { nodeType: "directory" });
	});

	test("#6 非叶节点行含 ▾direct(total)", async () => {
		// expand markerRoot depth=2 → renders `middle` (non-leaf) line.
		const out = await execWiki(
			{ action: "expand", nodeId: markerRoot.id, depth: 2 },
			globalCtx(),
		);
		// `middle` line must contain ▾2(8) — direct=2, total descendants=8.
		expect(out).toMatch(/▾2\(8\)/);
		// sanity: l1 / l2 lines contain ▾3(3) — direct=3 each, no deeper leaves below them in depth=2 view.
		// (depth=2 from markerRoot means levels 1 (middle) + 2 (l1,l2); gc* are at level 3 → not rendered
		// but counted in `middle` total.)
		expect(out).toMatch(/▾3\(3\)/);
	});

	test("#7 叶节点显 leaf (无括号)", async () => {
		// Expand l1 → its children gc1/gc2/gc3 are leaves. Each must show `leaf`.
		const out = await execWiki(
			{ action: "expand", nodeId: l1.id, depth: 1 },
			globalCtx(),
		);
		// Match lines ending with ` leaf` (the literal marker — no parentheses).
		expect(out).toMatch(/ leaf$/m);
		expect(out).toMatch(/- .*gc1 .* leaf$/m);
		// Leaves must NOT carry ▾ markers.
		expect(out).not.toMatch(/gc1.*▾/);
	});

	test("#8 总数算对 — middle total=2+3+3=8 显 ▾2(8)", async () => {
		// Adversarial: counter-example where the implementer might compute
		// "total = direct only" (would render ▾2(2)) or "total = direct + direct
		// of children" (would render ▾2(8) coincidentally for THIS shape but
		// fail other shapes). Add an asymmetric grandchild to break coincidence.
		//
		// Reset the tree to an asymmetric shape:
		//   middle
		//     l1 (3 leaves)
		//     l2 (3 leaves)
		//     l3 (0 leaves — leaf itself)
		// → middle direct=3, total=3 (l1,l2,l3) + 3 + 3 + 0 = 9.
		const asymRoot = makeNode(WIKI_GLOBAL_ROOT_ID, "asym-root", { nodeType: "directory" });
		const m = makeNode(asymRoot.id, "M", { nodeType: "directory" });
		const c1 = makeNode(m.id, "C1", { nodeType: "directory" });
		const c2 = makeNode(m.id, "C2", { nodeType: "directory" });
		const c3 = makeNode(m.id, "C3", { nodeType: "directory" }); // leaf among direct children
		for (const t of ["g1a", "g1b", "g1c"]) makeNode(c1.id, t, { nodeType: "directory" });
		for (const t of ["g2a", "g2b", "g2c"]) makeNode(c2.id, t, { nodeType: "directory" });
		// c3 has no children — leaf.

		const out = await execWiki(
			{ action: "expand", nodeId: asymRoot.id, depth: 2 },
			globalCtx(),
		);
		// M must render with ▾3(9): direct=3 (C1,C2,C3), total = 3 + 3 + 3 + 0 = 9.
		expect(out).toMatch(/▾3\(9\)/);
		// C3 (leaf) rendered as `leaf`, NOT ▾0(0).
		expect(out).toMatch(/C3.* leaf$/m);
		expect(out).not.toMatch(/C3.*▾/);
		// C1 / C2 non-leaf → ▾3(3).
		expect(out).toMatch(/C1.*▾3\(3\)/);
		expect(out).toMatch(/C2.*▾3\(3\)/);
	});

	test("#9 不回归 expand 基本输出 (nodeId/Title/Type/Summary/Body/Source file)", async () => {
		// Node with a header: path → Source file line present.
		const hdr = makeNode(
			WIKI_GLOBAL_ROOT_ID,
			"hdr-node",
			{ nodeType: "file", path: "header:src/runtime/agent-loop.ts", summary: "the loop" },
		);
		makeNode(hdr.id, "child-a", { nodeType: "file", summary: "first child" });

		const out = await execWiki(
			{ action: "expand", nodeId: hdr.id, depth: 1 },
			globalCtx(),
		);
		// Required header lines.
		expect(out).toMatch(/^nodeId: /m);
		expect(out).toMatch(/^Title: hdr-node$/m);
		expect(out).toMatch(/^Type: /m);
		expect(out).toMatch(/^Summary: the loop$/m);
		expect(out).toMatch(/^Body: /m);
		// Source file: header:src/runtime/agent-loop.ts → src/runtime/agent-loop.ts
		expect(out).toMatch(/^Source file: src\/runtime\/agent-loop\.ts$/m);
		// Subtree heading present.
		expect(out).toMatch(/^Subtree/m);
	});
});

// ===========================================================================
// #4 path 跳层
// ===========================================================================

describe("[sub-3 #4 path 跳层]", () => {
	// Tree:
	//   A (parentId: GLOBAL_ROOT)
	//     B
	//       C
	//         leaf1, leaf2
	//   unrelated-top-level (sibling of A — must NOT pollute path walks)
	let nodeA: WikiNode;
	let nodeB: WikiNode;
	let nodeC: WikiNode;

	beforeEach(() => {
		nodeA = makeNode(WIKI_GLOBAL_ROOT_ID, "A", { nodeType: "directory" });
		nodeB = makeNode(nodeA.id, "B", { nodeType: "directory" });
		nodeC = makeNode(nodeB.id, "C", { nodeType: "directory" });
		makeNode(nodeC.id, "leaf1", { nodeType: "directory" });
		makeNode(nodeC.id, "leaf2", { nodeType: "directory" });
		// Sibling of A (proves walkTitlePath starts from anchors, not arbitrary roots).
		makeNode(WIKI_GLOBAL_ROOT_ID, "unrelated-top-level", { nodeType: "directory" });
	});

	test("#10 path 直达深层 — expand A/B/C 定位到 C 并展其子", async () => {
		const out = await execWiki(
			{ action: "expand", path: "A/B/C", depth: 1 },
			globalCtx(),
		);
		// Must locate C (Title: C), not B or A.
		expect(out).toMatch(/^Title: C$/m);
		// And expand C's children (leaf1, leaf2).
		expect(out).toContain("leaf1");
		expect(out).toContain("leaf2");
		// 'unrelated-top-level' must NOT leak in.
		expect(out).not.toContain("unrelated-top-level");
	});

	test("#11 末段 /* 展父级直接子 — expand A/B/* 定位 B, depth=1", async () => {
		const out = await execWiki(
			{ action: "expand", path: "A/B/*" },
			globalCtx(),
		);
		// Wildcard strips /* → walks A/B → locates B → forces depth=1 → shows
		// B's DIRECT children only. B's only direct child is C.
		expect(out).toMatch(/^Title: B$/m);
		expect(out).toContain("C");
		// C's children (leaf1, leaf2) are depth=2 from B → must NOT appear
		// (proves depth=1 was forced, not the default 1 nor unbounded).
		// Wait — default depth is also 1; the wildcard's POINT is to force
		// depth=1 even if caller passed a higher depth. Verify depth=1 explicitly:
		expect(out).not.toMatch(/leaf1/);
		expect(out).not.toMatch(/leaf2/);
	});

	test("#11b 末段 /* 强制 depth=1 即便 caller 传 depth=5", async () => {
		const out = await execWiki(
			{ action: "expand", path: "A/B/*", depth: 5 },
			globalCtx(),
		);
		// depth=5 from caller but `/*` must override to depth=1 → only C shown.
		expect(out).toMatch(/^Title: B$/m);
		expect(out).toContain("C");
		expect(out).not.toMatch(/leaf1/);
		expect(out).not.toMatch(/leaf2/);
	});

	test("#12 path 优先于 nodeId — expand { path:'A/B', nodeId:'<wrong>', depth:2 } 用 path", async () => {
		// nodeId is INTENTIONALLY a real but DIFFERENT node (C). path A/B must win.
		const out = await execWiki(
			{ action: "expand", path: "A/B", nodeId: nodeC.id, depth: 2 },
			globalCtx(),
		);
		// Must locate B (per path), NOT C (per nodeId).
		expect(out).toMatch(/^Title: B$/m);
		expect(out).not.toMatch(/^Title: C$/m);
		// depth=2 from B means C + leaf1/leaf2 visible.
		expect(out).toContain("C");
		expect(out).toContain("leaf1");
		expect(out).toContain("leaf2");
	});

	test("#12b path with bogus nodeId — bogus nodeId ignored, path resolves", async () => {
		const out = await execWiki(
			{ action: "expand", path: "A/B", nodeId: "totally-bogus-nonexistent-id" },
			globalCtx(),
		);
		expect(out).toMatch(/^Title: B$/m);
	});

	test("#13 path 定位失败 → 清晰错误(指出哪段没匹配)", async () => {
		const out = await execWiki(
			{ action: "expand", path: "A/does-not-exist" },
			globalCtx(),
		);
		expect(out).toMatch(/^Error: /);
		// Must identify WHICH segment failed (segment 2 = "does-not-exist").
		expect(out).toContain("does-not-exist");
		// And identify the parent under which it failed (segment 1 = "A").
		// walkTitlePath surfaces `path segment 2 "..." not found under "A"`.
		expect(out).toMatch(/segment 2/);
		// And hint at available siblings.
		expect(out).toContain("available");
	});

	test("#13b deeply-nested path failure — segment 3 missing surfaces correctly", async () => {
		const out = await execWiki(
			{ action: "expand", path: "A/B/missing-deep" },
			globalCtx(),
		);
		expect(out).toMatch(/^Error: /);
		expect(out).toContain("missing-deep");
		expect(out).toMatch(/segment 3/);
	});

	test("#14 纯 nodeId 不回归 — expand { nodeId } 行为与改前一致", async () => {
		// No path → uses nodeId directly (back-compat).
		const out = await execWiki(
			{ action: "expand", nodeId: nodeC.id, depth: 1 },
			globalCtx(),
		);
		expect(out).toMatch(/^Title: C$/m);
		expect(out).toContain("leaf1");
		expect(out).toContain("leaf2");
		// Adversarial: nodeId alone (no path) — must NOT surface "nodeId or path required" error.
		expect(out).not.toMatch(/nodeId or path required/);
	});

	test("#14b 短 id (#xxxxxxxx) 不回归", async () => {
		// Same as #14 but using short-id form.
		const out = await execWiki(
			{ action: "expand", nodeId: shortId(nodeC.id), depth: 1 },
			globalCtx(),
		);
		expect(out).toMatch(/^Title: C$/m);
		expect(out).toContain("leaf1");
	});

	test("#14c neither nodeId nor path → friendly error", async () => {
		const out = await execWiki(
			{ action: "expand" },
			globalCtx(),
		);
		expect(out).toMatch(/^Error: nodeId or path required/);
	});
});

// ===========================================================================
// resolveNode / doc-op regression (ADVERSARIAL CORE — verification of
// implementer's claim that the walkTitlePath refactor preserves doc op semantics)
// ===========================================================================

describe("[sub-3 doc-op path regression — resolveNode refactor preserves contract]", () => {
	// Tree:
	//   docRoot (parentId: GLOBAL_ROOT)
	//     mid
	//       leafA
	let docRoot: WikiNode;
	let mid: WikiNode;
	let leafA: WikiNode;

	beforeEach(() => {
		docRoot = makeNode(WIKI_GLOBAL_ROOT_ID, "docRoot", { nodeType: "directory" });
		mid = makeNode(docRoot.id, "mid", { nodeType: "directory" });
		leafA = makeNode(mid.id, "leafA", { nodeType: "directory" });
		// Seed an initial body so docEdit has something to replace.
		wiki.writeNodeDetail(leafA.id, "Hello world from leafA.");
	});

	test("docRead via path (deep) — resolves to target, reads existing body", async () => {
		const out = await execWiki(
			{ action: "docRead", path: "docRoot/mid/leafA" },
			globalCtx(),
		);
		expect(out).toBe("Hello world from leafA.");
	});

	test("docRead via path (mid) — resolves to mid, reads its (empty) body", async () => {
		const out = await execWiki(
			{ action: "docRead", path: "docRoot/mid" },
			globalCtx(),
		);
		// `mid` has no body yet → friendly "no body" message.
		expect(out).toMatch(/no body document yet|^\(node/);
	});

	test("docRead via path that doesn't resolve → friendly 'node not found'", async () => {
		const out = await execWiki(
			{ action: "docRead", path: "docRoot/nonexistent" },
			globalCtx(),
		);
		// resolveNode returns undefined → tool surfaces 'Error: node not found (...)'.
		// Must NOT throw, must NOT silently return empty.
		expect(out).toMatch(/^Error: node not found/);
		expect(out).toContain("docRoot/nonexistent");
	});

	test("docRead via path partial (stops mid-walk) → friendly 'node not found'", async () => {
		// path with extra segment that doesn't exist past leafA.
		const out = await execWiki(
			{ action: "docRead", path: "docRoot/mid/leafA/too-deep" },
			globalCtx(),
		);
		expect(out).toMatch(/^Error: node not found/);
	});

	test("docWrite via path — writes body to resolved node", async () => {
		// Pre-existing body must be clobbered with overwrite:true.
		const out = await execWiki(
			{
				action: "docWrite",
				path: "docRoot/mid/leafA",
				content: "New body via path.",
				overwrite: true,
			},
			globalCtx(),
		);
		expect(out).toMatch(/^Document written: /);
		expect(out).toContain("leafA");
		// Verify via direct store read (truth source — not the tool's own output).
		const body = wiki.readNodeDetail(leafA.id);
		expect(body).toBe("New body via path.");
	});

	test("docWrite via path on fresh node (no existing body) — no overwrite needed", async () => {
		const out = await execWiki(
			{
				action: "docWrite",
				path: "docRoot/mid", // mid has no body
				content: "Body for mid.",
			},
			globalCtx(),
		);
		expect(out).toMatch(/^Document written: /);
		expect(wiki.readNodeDetail(mid.id)).toBe("Body for mid.");
	});

	test("docWrite via path that doesn't resolve → friendly 'node not found'", async () => {
		const out = await execWiki(
			{
				action: "docWrite",
				path: "docRoot/nonexistent",
				content: "x",
			},
			globalCtx(),
		);
		expect(out).toMatch(/^Error: node not found/);
		expect(out).toContain("docRoot/nonexistent");
	});

	test("docEdit via path — exact-string replace on resolved node's body", async () => {
		const out = await execWiki(
			{
				action: "docEdit",
				path: "docRoot/mid/leafA",
				oldString: "Hello world",
				newString: "Goodbye universe",
			},
			globalCtx(),
		);
		expect(out).toMatch(/^Document edited: /);
		// Verify via direct store read.
		expect(wiki.readNodeDetail(leafA.id)).toBe("Goodbye universe from leafA.");
	});

	test("docEdit via path — oldString not in body → friendly 'not found' error", async () => {
		const out = await execWiki(
			{
				action: "docEdit",
				path: "docRoot/mid/leafA",
				oldString: "this string is not in the body",
				newString: "x",
			},
			globalCtx(),
		);
		expect(out).toMatch(/oldString not found/);
		// Body must NOT have changed.
		expect(wiki.readNodeDetail(leafA.id)).toBe("Hello world from leafA.");
	});

	test("docEdit via path that doesn't resolve → friendly 'node not found'", async () => {
		const out = await execWiki(
			{
				action: "docEdit",
				path: "docRoot/nope",
				oldString: "x",
				newString: "y",
			},
			globalCtx(),
		);
		expect(out).toMatch(/^Error: node not found/);
	});

	test("docRead by nodeId STILL works (resolveNode's nodeId branch not broken)", async () => {
		const out = await execWiki(
			{ action: "docRead", nodeId: leafA.id },
			globalCtx(),
		);
		expect(out).toBe("Hello world from leafA.");
	});

	test("docRead by short-id STILL works", async () => {
		const out = await execWiki(
			{ action: "docRead", nodeId: shortId(leafA.id) },
			globalCtx(),
		);
		expect(out).toBe("Hello world from leafA.");
	});

	test("docRead with neither nodeId nor path → friendly 'required' error", async () => {
		const out = await execWiki(
			{ action: "docRead" },
			globalCtx(),
		);
		expect(out).toMatch(/^Error: nodeId or path required/);
	});

	test("resolveNode prefers nodeId when BOTH nodeId and path given (doc op)", async () => {
		// docWrite with both → nodeId wins (matches existing doc-op behavior;
		// NOTE: this differs from expand where path wins. resolveNode checks
		// target.nodeId first).
		const out = await execWiki(
			{
				action: "docRead",
				nodeId: leafA.id,           // → leafA
				path: "docRoot/mid",        // → mid (DIFFERENT node)
			},
			globalCtx(),
		);
		// Per resolveNode: target.nodeId first → reads leafA's body.
		expect(out).toBe("Hello world from leafA.");
	});

	test("path with whitespace around segments still resolves (trim)", async () => {
		// walkTitlePath trims each segment; useful when LLM emits ' / ' separators.
		const out = await execWiki(
			{ action: "docRead", path: "  docRoot /  mid / leafA  " },
			globalCtx(),
		);
		expect(out).toBe("Hello world from leafA.");
	});
});

// ===========================================================================
// Cross-checks / paranoid
// ===========================================================================

describe("[sub-3 paranoid cross-checks]", () => {
	test("regex search still excludes synthetic wiki-root:* containers", async () => {
		// The synthetic project subtree root wiki-root:projects has title
		// "Projects" (or similar) — it must NOT show up in search results
		// (the tool filters n.id.startsWith('wiki-root:')).
		makeNode(WIKI_GLOBAL_ROOT_ID, "alpha-real", { nodeType: "directory" });
		const out = await execWiki(
			{ action: "search", query: ".", regex: true },
			globalCtx(),
		);
		// Every line is `<shortId> | <type> | <title> ...` — none should have
		// a title of "Projects" or "Global" (synthetic root titles).
		expect(out).not.toMatch(/\| Global\b/);
	});

	test("expand path with regex-special chars in title (e.g. '.') still matches literally", async () => {
		// walkTitlePath uses === on titles (literal), NOT regex. A title with
		// a literal `.` must match by exact equality.
		const dot = makeNode(WIKI_GLOBAL_ROOT_ID, "config.json", { nodeType: "directory" });
		makeNode(dot.id, "inner", { nodeType: "directory" });
		const out = await execWiki(
			{ action: "expand", path: "config.json" },
			globalCtx(),
		);
		expect(out).toMatch(/^Title: config\.json$/m);
		expect(out).toContain("inner");
	});

	test("expand path resolves first segment against ANY anchor in the set", async () => {
		// callerCtx scoped to a non-root anchor: path's first segment must be a
		// child of THAT anchor (not GLOBAL_ROOT).
		const sub = makeNode(WIKI_GLOBAL_ROOT_ID, "sub-anchor-root", { nodeType: "directory" });
		const inner = makeNode(sub.id, "inner-child", { nodeType: "directory" });
		makeNode(inner.id, "deep-leaf", { nodeType: "directory" });

		const out = await execWiki(
			{ action: "expand", path: "inner-child/deep-leaf" },
			{ caller: "internal", wikiAnchorNodeIds: [sub.id] },
		);
		expect(out).toMatch(/^Title: deep-leaf$/m);
	});
});
