// sub2 验收契约断言:WikiTree 懒加载渲染模型
//
// # 文件说明书
//
// ## 核心功能
// 静态扫描 src/renderer/components/wiki/WikiTree.tsx 源码,锁定懒加载模型
// (v0.8:从"整批拉子树 + nodes prop"改为"逐层 getChildren + childrenByNode")
// 的关键不变量,防止回退到旧的 eager 模型:
//   (1) props 不再是 `nodes: WikiNode[]`,而是 childrenByNode / childrenLoaded /
//       loadingChildren / rootId / onExpand —— 逐层懒加载的输入面。
//   (2) 渲染从 rootId 的子节点开始递归(walk(rootId, 0)),不拉整棵树。
//   (3) 展开一个未加载的目录节点 → 调 onExpand(id) 触发拉取,并显示 Loading 行。
//   (4) 空态 fallback 仍在(根子节点还没加载完时)。
//
// 用源码契约而非组件级 RTL 测试:本仓库单元测试池是 node 环境(pool=forks),
// 没有 jsdom / React Testing Library 基建。
//
// ## 维护规则
//   - WikiTree 重构时同步本契约;若改用 RTL/Playwright 运行时断言,此文件可移除。
//
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";

const WIKI_TREE_SRC = readFileSync(
	"src/renderer/components/wiki/WikiTree.tsx",
	"utf-8",
);

describe("WikiTree lazy-render contract (v0.8 lazy model)", () => {
	test("props are the lazy-load surface (childrenByNode/loaded/loading/rootId/onExpand), not a flat `nodes` array", () => {
		// The old eager API must be gone.
		expect(WIKI_TREE_SRC).not.toMatch(/nodes:\s*WikiNode\[\]/);
		// New lazy surface.
		expect(WIKI_TREE_SRC).toContain("childrenByNode:");
		expect(WIKI_TREE_SRC).toContain("childrenLoaded:");
		expect(WIKI_TREE_SRC).toContain("loadingChildren:");
		expect(WIKI_TREE_SRC).toContain("rootId:");
		expect(WIKI_TREE_SRC).toContain("onExpand:");
	});

	test("renders starting from rootId's children, not a precomputed rootNodes bucket", () => {
		// The walk entry point must be the scope root anchor.
		expect(WIKI_TREE_SRC).toMatch(/walk\(\s*rootId\s*,\s*0\s*\)/);
		// And it reads children by parentId from the store map.
		expect(WIKI_TREE_SRC).toContain("childrenByNode[parentId]");
	});

	test("expanding an unloaded directory triggers onExpand + shows a Loading row", () => {
		// The loader placeholder row id prefix.
		expect(WIKI_TREE_SRC).toContain("__loading_");
		// Expanding an unloaded node calls onExpand (the store fetches children).
		expect(WIKI_TREE_SRC).toMatch(/onExpand\(\s*child\.id\s*\)/);
	});

	test("still renders an empty-state fallback when the root has no rows", () => {
		// rows.length === 0 branch + root loading hint.
		expect(WIKI_TREE_SRC).toMatch(/if\s*\(\s*rows\.length\s*===\s*0\s*\)/);
	});
});
