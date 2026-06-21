// sub2 验收契约断言:WikiTree 根节点渲染 + 自动展开回归
//
// # 文件说明书
//
// ## 核心功能
// 静态扫描 src/renderer/components/wiki/WikiTree.tsx 源码,锁定两个 v0.8 dev
// 修复不会回退:
//   (1) childrenByParent 用 `n.parentId ?? undefined` 归一化:null(后端 DB
//       wiki_root:global 的 parentId 列存 NULL)与 undefined 共享同一 Map key,
//       否则根节点桶永远是空,整树渲染空白。
//   (2) 全局根 wiki-root:global 在节点池首次出现时通过 useEffect 自动展开;
//       早期 useState 初始化器在 nodes=[] 时跑,把根漏加到 expanded,导致刷新
//       后骨架子树(knowledge/projects/memory/software-dev)折叠不可见。
//
// 用源码契约而非组件级 RTL 测试:本仓库单元测试池是 node 环境(pool=forks),
// 没有 jsdom / React Testing Library 基建,拉起整套 renderer harness 成本远
// 高于收益。契约断言能直接挡住“改回去”的回归。
//
// ## 输入
// fs.readFileSync 读取 WikiTree.tsx 源码字符串。
//
// ## 输出
// Vitest 用例。
//
// ## 定位
// tests/unit/ — 静态契约,纯字符串/正则断言。
//
// ## 维护规则
//   - WikiTree 重构时同步本契约;若组件结构大改(改用 RTL/Playwright),此文件
//     可移除,改为运行时断言。
//   - 新增 BUG FIX 注释涉及的修复点建议补一条对应断言。
//
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";

const WIKI_TREE_SRC = readFileSync(
	"src/renderer/components/wiki/WikiTree.tsx",
	"utf-8",
);

describe("WikiTree root render contract (v0.8 dev fix)", () => {
	test("normalizes null parentId → undefined so root nodes key into childrenByParent", () => {
		// The childrenByParent builder must use `n.parentId ?? undefined`.
		// Backend rowToWikiNode passes DB NULL through as null; the
		// WikiNode type declares `parentId: string | undefined`. Without
		// normalization the root lands under key `null` while
		// rootNodes reads `undefined` → mismatch → empty tree.
		expect(WIKI_TREE_SRC).toContain("n.parentId ?? undefined");
		// And rootNodes must read the undefined bucket, not null.
		expect(WIKI_TREE_SRC).toContain("childrenByParent.get(undefined)");
		expect(WIKI_TREE_SRC).not.toContain("childrenByParent.get(null)");
	});

	test("auto-expands wiki-root:global via useEffect on first appearance", () => {
		// useState initializer runs once with nodes=[] → rootNodes=[] → root
		// never lands in expanded. The useEffect must re-check on every
		// `nodes` change and add the global root when it shows up.
		expect(WIKI_TREE_SRC).toMatch(/useEffect\(/);
		// The effect must reference the global root id and setExpanded.
		expect(WIKI_TREE_SRC).toContain('"wiki-root:global"');
		expect(WIKI_TREE_SRC).toMatch(/hasGlobalRoot\s*=\s*rootNodes\.some/);
		expect(WIKI_TREE_SRC).toMatch(/setExpanded\(\(prev\)\s*=>\s*new Set\(prev\)\.add\("wiki-root:global"\)\)/);
		// Dependency array must include rootNodes (so it re-runs when the
		// refresh completes), not just run once on mount.
		expect(WIKI_TREE_SRC).toMatch(/\[\s*rootNodes\s*,\s*expanded\s*\]/);
	});

	test("still renders an empty-state fallback when nodes is empty", () => {
		// Regression guard: the auto-expand effect must not have removed
		// the explicit "no nodes" empty state.
		expect(WIKI_TREE_SRC).toMatch(/if\s*\(\s*nodes\.length\s*===\s*0\s*\)/);
	});
});
