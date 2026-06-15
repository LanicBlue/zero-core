// 单元测试：MemoryRecall 记忆召回与格式化
//
// # 文件说明书
//
// ## 核心功能
// 测试 MemoryRecall.recall（基于 mock MemoryNodeStore.searchNodes 召回节点、subject 去重、过滤 null subject）和 formatForContext（将节点列表格式化为 markdown「- **Subject** (type): content. [date]」列表，空列表返回 null）
//
// ## 输入
// 通过 vi.fn 模拟的 MemoryNodeStore 与构造的 MemoryNode/MemorySubject 数据
//
// ## 输出
// Vitest 测试用例：覆盖空召回返回 null、匹配节点、subject 去重、null subject 过滤、markdown 格式化与日期截取
//
// ## 定位
// tests/unit/ — 单元测试套件，验证 runtime 记忆召回与上下文格式化逻辑
//
// ## 依赖
// vitest、../../src/runtime/memory-recall（MemoryRecall）、../../src/server/memory-node-store（类型）
//
// ## 维护规则
// recall 去重或过滤策略变更需同步更新测试
// formatForContext 输出格式（日期、加粗、列表项）变更需更新断言
//
import { describe, test, expect, beforeEach, vi } from "vitest";
import { MemoryRecall } from "../../src/runtime/memory-recall.js";
import type { MemoryNodeStore, MemoryNode, MemorySubject } from "../../src/server/memory-node-store.js";

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
	return {
		id: "mock-id",
		subject: "TestSubject",
		type: "event",
		content: "test content",
		sessionId: null,
		sourceSeq: null,
		evolvedFrom: null,
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
		...overrides,
	};
}

function makeSubject(overrides: Partial<MemorySubject> = {}): MemorySubject {
	return {
		subject: "TestSubject",
		kind: null,
		nodeCount: 1,
		summary: null,
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
		...overrides,
	};
}

function mockStore(searchResults: Array<{ node: MemoryNode; subject: MemorySubject | null }> = []): MemoryNodeStore {
	return {
		searchNodes: vi.fn().mockReturnValue(searchResults),
	} as unknown as MemoryNodeStore;
}

describe("MemoryRecall", () => {
	describe("recall", () => {
		test("returns null when no nodes match", async () => {
			const store = mockStore();
			const recall = new MemoryRecall(store);
			const result = await recall.recall("anything");
			expect(result).toBeNull();
		});

		test("returns matching nodes", async () => {
			const node = makeNode({ subject: "ProjectX", content: "Use SQLite." });
			const store = mockStore([{ node, subject: makeSubject({ subject: "ProjectX" }) }]);
			const recall = new MemoryRecall(store);

			const result = await recall.recall("SQLite");
			expect(result).not.toBeNull();
			expect(result!.nodes).toHaveLength(1);
			expect(result!.nodes[0].subject).toBe("ProjectX");
		});

		test("deduplicates subjects", async () => {
			const n1 = makeNode({ subject: "ProjectX", type: "decision" });
			const n2 = makeNode({ subject: "ProjectX", type: "event" });
			const store = mockStore([
				{ node: n1, subject: makeSubject({ subject: "ProjectX", nodeCount: 2 }) },
				{ node: n2, subject: makeSubject({ subject: "ProjectX", nodeCount: 2 }) },
			]);
			const recall = new MemoryRecall(store);

			const result = await recall.recall("ProjectX");
			expect(result!.subjects).toHaveLength(1);
			expect(result!.subjects[0].subject).toBe("ProjectX");
			expect(result!.subjects[0].nodeCount).toBe(2);
		});

		test("returns null when store.searchNodes returns empty array", async () => {
			const store = mockStore([]);
			const recall = new MemoryRecall(store);
			const result = await recall.recall("nothing");
			expect(result).toBeNull();
		});

		test("filters out null subjects in results", async () => {
			const node = makeNode({ subject: "X" });
			const store = mockStore([{ node, subject: null }]);
			const recall = new MemoryRecall(store);

			const result = await recall.recall("X");
			expect(result).not.toBeNull();
			expect(result!.nodes).toHaveLength(1);
			expect(result!.subjects).toHaveLength(0); // null subject filtered out
		});
	});

	describe("formatForContext", () => {
		test("returns null for empty nodes", () => {
			const recall = new MemoryRecall({} as MemoryNodeStore);
			expect(recall.formatForContext({ nodes: [], subjects: [] })).toBeNull();
		});

		test("formats nodes as markdown list", () => {
			const recall = new MemoryRecall({} as MemoryNodeStore);
			const result = recall.formatForContext({
				nodes: [
					{ subject: "ProjectX", type: "decision", content: "Use SQLite.", updatedAt: "2026-06-01T00:00:00.000Z" },
					{ subject: "User", type: "preference", content: "Prefers TypeScript.", updatedAt: "2026-05-20T00:00:00.000Z" },
				],
				subjects: [],
			});

			expect(result).toContain("**ProjectX**");
			expect(result).toContain("decision");
			expect(result).toContain("Use SQLite.");
			expect(result).toContain("[2026-06-01]");
			expect(result).toContain("**User**");
			expect(result).toContain("preference");
			expect(result).toContain("Prefers TypeScript.");
		});

		test("formats single node correctly", () => {
			const recall = new MemoryRecall({} as MemoryNodeStore);
			const result = recall.formatForContext({
				nodes: [
					{ subject: "Alpha", type: "discovery", content: "Found something.", updatedAt: "2026-03-15T12:00:00.000Z" },
				],
				subjects: [],
			});

			expect(result).toBe("- **Alpha** (discovery): Found something. [2026-03-15]");
		});
	});
});
