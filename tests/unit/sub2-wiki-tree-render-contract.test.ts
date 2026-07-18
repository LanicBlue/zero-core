// sub2 验收契约断言:WikiTree 懒加载渲染模型
//
// # 文件说明书
//
// ## 核心功能
// 静态扫描 src/renderer/components/wiki/WikiTree.tsx 源码,锁定懒加载模型
// 的关键不变量,防止回退到旧的 eager 模型:
//   (1) props 不再是 `nodes: WikiNode[]`,而是逐层懒加载的输入面
//       (rootAddress + showArchived;组件从 wiki-store 拉
//       childrenByPath / childrenLoaded / loadingChildren / expandPath)。
//   (2) 渲染从 rootAddress 的子节点开始递归(walk(rootAddress, 0)),
//       并通过 childrenByPath[parentId] 拿逐层 children。
//   (3) 展开一个未加载的目录节点 → 触发 expandPath(path) 拉取,
//       并显示 __loading:<path> 占位行。
//   (4) 空态 fallback 仍在(根子节点还没加载完时)。
//
// ## 历史
//   - v0.8 旧模型(childrenByNode/rootId/onExpand)已被 sub-06 重写取代
//     为 canonical-path keyed + 分页(childrenByPath/rootAddress/expandPath/
//     loadMoreChildren)。本契约同步到新模型,继续作为回归守卫。
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

describe("WikiTree lazy-render contract (sub-06 canonical-path model)", () => {
	test("props are the lazy-load surface (rootAddress + showArchived), not a flat `nodes` array", () => {
		// The old eager API must be gone.
		expect(WIKI_TREE_SRC).not.toMatch(/nodes:\s*WikiNode\[\]/);
		// Component reads the lazy surface from the wiki store (sub-06 model).
		expect(WIKI_TREE_SRC).toContain("childrenByPath");
		expect(WIKI_TREE_SRC).toContain("childrenLoaded");
		expect(WIKI_TREE_SRC).toContain("loadingChildren");
		// Props are the scope anchor + visibility flag (no nodes array).
		expect(WIKI_TREE_SRC).toMatch(/rootAddress:\s*string/);
		expect(WIKI_TREE_SRC).toMatch(/showArchived:\s*boolean/);
	});

	test("renders starting from rootAddress's children, not a precomputed rootNodes bucket", () => {
		// The walk entry point must be the scope root anchor.
		expect(WIKI_TREE_SRC).toMatch(/walk\(\s*rootAddress\s*,\s*0\s*\)/);
		// And it reads children by parent path from the store map.
		expect(WIKI_TREE_SRC).toContain("childrenByPath[parent]");
	});

	test("expanding an unloaded directory triggers expandPath + shows a Loading row", () => {
		// The loader placeholder row key prefix (sub-06: __loading:<path>).
		expect(WIKI_TREE_SRC).toContain("__loading:");
		// Expanding an unloaded node calls expandPath (the store fetches children).
		expect(WIKI_TREE_SRC).toMatch(/expandPath\(/);
	});

	test("still renders an empty-state fallback when the root has no rows", () => {
		// rows.length === 0 branch + root loading hint.
		expect(WIKI_TREE_SRC).toMatch(/if\s*\(\s*rows\.length\s*===\s*0\s*\)/);
	});
});
