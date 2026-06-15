// 单元测试：MemoryNodeStore 内存节点存储逻辑
//
// # 文件说明书
//
// ## 核心功能
// 由于 better-sqlite3 编译为 Electron ABI 无法在 Node vitest 直接加载，本文件用内存 MockStore 复刻 MemoryNodeStore 的 SQL 行为，测试 node upsert/evolve/batch、getNode/getNodesForSubject/getRecentNodes/deleteNode、searchNodes、subject 计数、createEdge/getRelatedSubjects 等逻辑
//
// ## 输入
// MemoryNodeInput（subject/type/content）序列与 sessionId
//
// ## 输出
// Vitest 测试用例：覆盖 node CRUD、evolution（同 subject+type 更新而非新增）、subject nodeCount 维护、edge 双向查询、search 关键词匹配与 limit
//
// ## 定位
// tests/unit/ — 单元测试套件，验证 MemoryNodeStore 的内存模型行为（SQL 实现在 src/server/memory-node-store.ts）
//
// ## 依赖
// vitest、../../src/server/memory-node-store（MemoryNodeInput、MemoryNode、MemorySubject 类型）
//
// ## 维护规则
// MemoryNodeStore 的 SQL 行为（evolve 规则、排序、subject 聚合）变更需同步更新 MockStore 与对应测试
// 新增节点 type 需更新 validTypes 白名单
// 仅当 MockStore 行为与 SQL 一致时测试才有意义，新增 SQL 行为需先在 MockStore 复刻
//
import { describe, test, expect, beforeEach, vi } from "vitest";
import type { MemoryNodeInput, MemoryNode, MemorySubject } from "../../src/server/memory-node-store.js";

// ---------------------------------------------------------------------------
// In-memory mock that mimics the SQL operations used by MemoryNodeStore
// ---------------------------------------------------------------------------

interface StoredNode {
	id: string;
	session_id: string | null;
	subject: string;
	type: string;
	content: string;
	source_seq: number | null;
	evolved_from: string | null;
	created_at: string;
	updated_at: string;
	rowid: number;
}

interface StoredSubject {
	subject: string;
	kind: string | null;
	node_count: number;
	summary: string | null;
	created_at: string;
	updated_at: string;
}

interface StoredEdge {
	id: string;
	from_subject: string;
	to_subject: string;
	relation: string;
	created_at: string;
}

class MockStore {
	nodes: Map<string, StoredNode> = new Map();
	subjects: Map<string, StoredSubject> = new Map();
	edges: StoredEdge[] = [];
	private nextRowid = 1;
	private nextId = 1;
	private timeOffset = 0;

	private uuid(): string {
		return `mock-${this.nextId++}`;
	}

	private now(): string {
		// Each call returns a slightly later timestamp to ensure ordering
		const d = new Date(Date.now() + this.timeOffset);
		this.timeOffset += 1000;
		return d.toISOString();
	}

	upsertNode(sessionId: string | null, input: MemoryNodeInput): MemoryNode {
		const validTypes = new Set(["event", "decision", "discovery", "status_change", "preference"]);
		if (!validTypes.has(input.type)) {
			throw new Error(`Invalid memory node type: ${input.type}`);
		}

		const now = this.now();

		// Find existing with same subject + type
		let existing: StoredNode | undefined;
		for (const n of this.nodes.values()) {
			if (n.subject === input.subject && n.type === input.type) {
				existing = n;
				break;
			}
		}

		if (existing) {
			// Evolve
			existing.content = input.content;
			existing.evolved_from = existing.id;
			existing.updated_at = now;
			this.refreshSubject(input.subject);
			return this.toNode(existing);
		}

		// Create new
		const id = this.uuid();
		const rowid = this.nextRowid++;
		const stored: StoredNode = {
			id, session_id: sessionId, subject: input.subject, type: input.type,
			content: input.content, source_seq: null, evolved_from: null,
			created_at: now, updated_at: now, rowid,
		};
		this.nodes.set(id, stored);
		this.ensureSubject(input.subject);
		this.refreshSubject(input.subject);
		return this.toNode(stored);
	}

	upsertNodes(sessionId: string | null, inputs: MemoryNodeInput[]): MemoryNode[] {
		return inputs.map(input => this.upsertNode(sessionId, input));
	}

	getNode(id: string): MemoryNode | undefined {
		const stored = this.nodes.get(id);
		return stored ? this.toNode(stored) : undefined;
	}

	getNodesForSubject(subject: string): MemoryNode[] {
		const nodes: StoredNode[] = [];
		for (const n of this.nodes.values()) {
			if (n.subject === subject) nodes.push(n);
		}
		return nodes.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(n => this.toNode(n));
	}

	getRecentNodes(limit: number): MemoryNode[] {
		return [...this.nodes.values()]
			.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
			.slice(0, limit)
			.map(n => this.toNode(n));
	}

	deleteNode(id: string): void {
		const node = this.nodes.get(id);
		if (!node) return;
		this.nodes.delete(id);
		this.refreshSubject(node.subject);
	}

	searchNodes(query: string, limit: number): Array<{ node: MemoryNode; subject: MemorySubject | null }> {
		const q = query.toLowerCase();
		const matches: StoredNode[] = [];
		for (const n of this.nodes.values()) {
			if (n.subject.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)) {
				matches.push(n);
			}
		}
		return matches
			.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
			.slice(0, limit)
			.map(n => ({ node: this.toNode(n), subject: this.getSubject(n.subject) }));
	}

	ensureSubject(subject: string, kind?: string): void {
		if (!this.subjects.has(subject)) {
			this.subjects.set(subject, {
				subject, kind: kind ?? null, node_count: 0, summary: null,
				created_at: this.now(), updated_at: this.now(),
			});
		}
	}

	getSubject(subject: string): MemorySubject | null {
		const s = this.subjects.get(subject);
		return s ? this.toSubject(s) : null;
	}

	refreshSubject(subject: string): void {
		this.ensureSubject(subject);
		const s = this.subjects.get(subject)!;
		let count = 0;
		for (const n of this.nodes.values()) {
			if (n.subject === subject) count++;
		}
		s.node_count = count;
		s.updated_at = this.now();
	}

	createEdge(fromSubject: string, toSubject: string, relation: string): void {
		this.ensureSubject(fromSubject);
		this.ensureSubject(toSubject);
		this.edges.push({
			id: this.uuid(), from_subject: fromSubject, to_subject: toSubject,
			relation, created_at: this.now(),
		});
	}

	getRelatedSubjects(subject: string): Array<{ subject: string; relation: string }> {
		return this.edges
			.filter(e => e.from_subject === subject || e.to_subject === subject)
			.map(e => ({
				subject: e.from_subject === subject ? e.to_subject : e.from_subject,
				relation: e.relation,
			}));
	}

	private toNode(r: StoredNode): MemoryNode {
		return {
			id: r.id, subject: r.subject, type: r.type as any, content: r.content,
			sessionId: r.session_id, sourceSeq: r.source_seq, evolvedFrom: r.evolved_from,
			createdAt: r.created_at, updatedAt: r.updated_at,
		};
	}

	private toSubject(r: StoredSubject): MemorySubject {
		return {
			subject: r.subject, kind: r.kind, nodeCount: r.node_count,
			summary: r.summary, createdAt: r.created_at, updatedAt: r.updated_at,
		};
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryNodeStore logic", () => {
	let store: MockStore;

	beforeEach(() => {
		store = new MockStore();
	});

	// ─── Node CRUD ──────────────────────────────────────

	describe("upsertNode (create)", () => {
		test("creates a new node and returns it with all fields", () => {
			const node = store.upsertNode("sess-1", {
				subject: "ProjectX",
				type: "decision",
				content: "Decided to use SQLite for storage.",
			});

			expect(node.id).toBeTruthy();
			expect(node.subject).toBe("ProjectX");
			expect(node.type).toBe("decision");
			expect(node.content).toBe("Decided to use SQLite for storage.");
			expect(node.sessionId).toBe("sess-1");
			expect(node.evolvedFrom).toBeNull();
			expect(node.createdAt).toBeTruthy();
			expect(node.updatedAt).toBeTruthy();
		});

		test("creates node with null sessionId", () => {
			const node = store.upsertNode(null, {
				subject: "Test",
				type: "event",
				content: "Something happened.",
			});
			expect(node.sessionId).toBeNull();
		});

		test("throws on invalid node type", () => {
			expect(() =>
				store.upsertNode(null, {
					subject: "X",
					type: "invalid_type" as any,
					content: "test",
				}),
			).toThrow(/Invalid memory node type/);
		});
	});

	describe("upsertNode (evolve)", () => {
		test("evolves existing node with same subject + type", () => {
			const original = store.upsertNode(null, {
				subject: "ProjectX",
				type: "decision",
				content: "Decided to use SQLite.",
			});

			const evolved = store.upsertNode(null, {
				subject: "ProjectX",
				type: "decision",
				content: "Updated: decided to use PostgreSQL instead.",
			});

			expect(evolved.id).toBe(original.id);
			expect(evolved.content).toBe("Updated: decided to use PostgreSQL instead.");
			expect(evolved.evolvedFrom).toBe(original.id);
		});

		test("does not evolve when type differs", () => {
			const node1 = store.upsertNode(null, {
				subject: "ProjectX",
				type: "decision",
				content: "Use SQLite.",
			});
			const node2 = store.upsertNode(null, {
				subject: "ProjectX",
				type: "discovery",
				content: "SQLite has limitations.",
			});

			expect(node1.id).not.toBe(node2.id);
			expect(store.getNodesForSubject("ProjectX")).toHaveLength(2);
		});
	});

	describe("upsertNodes (batch)", () => {
		test("creates multiple nodes in a transaction", () => {
			const nodes = store.upsertNodes(null, [
				{ subject: "A", type: "event", content: "Event A" },
				{ subject: "B", type: "decision", content: "Decision B" },
				{ subject: "C", type: "discovery", content: "Discovery C" },
			]);

			expect(nodes).toHaveLength(3);
			expect(nodes[0].subject).toBe("A");
			expect(nodes[1].subject).toBe("B");
			expect(nodes[2].subject).toBe("C");
		});
	});

	describe("getNode", () => {
		test("returns node by ID", () => {
			const created = store.upsertNode(null, {
				subject: "X", type: "event", content: "test",
			});
			const fetched = store.getNode(created.id);
			expect(fetched).toBeDefined();
			expect(fetched!.content).toBe("test");
		});

		test("returns undefined for non-existent ID", () => {
			expect(store.getNode("nonexistent")).toBeUndefined();
		});
	});

	describe("getNodesForSubject", () => {
		test("returns all nodes for a subject ordered by updatedAt desc", () => {
			store.upsertNode(null, { subject: "ProjectX", type: "decision", content: "first" });
			store.upsertNode(null, { subject: "ProjectX", type: "discovery", content: "second" });
			store.upsertNode(null, { subject: "OtherProject", type: "event", content: "other" });

			const nodes = store.getNodesForSubject("ProjectX");
			expect(nodes).toHaveLength(2);
			expect(nodes.every(n => n.subject === "ProjectX")).toBe(true);
		});
	});

	describe("getRecentNodes", () => {
		test("returns nodes ordered by updatedAt desc", () => {
			store.upsertNode(null, { subject: "A", type: "event", content: "first" });
			store.upsertNode(null, { subject: "B", type: "event", content: "second" });
			store.upsertNode(null, { subject: "C", type: "event", content: "third" });

			const recent = store.getRecentNodes(2);
			expect(recent).toHaveLength(2);
			expect(recent[0].subject).toBe("C");
			expect(recent[1].subject).toBe("B");
		});

		test("respects limit parameter", () => {
			for (let i = 0; i < 20; i++) {
				store.upsertNode(null, { subject: `S${i}`, type: "event", content: `node ${i}` });
			}
			expect(store.getRecentNodes(5)).toHaveLength(5);
		});
	});

	describe("deleteNode", () => {
		test("deletes a node by ID", () => {
			const node = store.upsertNode(null, {
				subject: "X", type: "event", content: "to delete",
			});
			store.deleteNode(node.id);
			expect(store.getNode(node.id)).toBeUndefined();
		});

		test("no-ops for non-existent ID", () => {
			expect(() => store.deleteNode("nonexistent")).not.toThrow();
		});

		test("updates subject node count after delete", () => {
			store.upsertNode(null, { subject: "X", type: "event", content: "a" });
			store.upsertNode(null, { subject: "X", type: "decision", content: "b" });
			expect(store.getSubject("X")!.nodeCount).toBe(2);

			const nodes = store.getNodesForSubject("X");
			store.deleteNode(nodes[0].id);
			expect(store.getSubject("X")!.nodeCount).toBe(1);
		});
	});

	// ─── Search ────────────────────────────────────────

	describe("searchNodes", () => {
		beforeEach(() => {
			store.upsertNode(null, { subject: "ProjectAlpha", type: "decision", content: "Decided to use React for frontend." });
			store.upsertNode(null, { subject: "ProjectBeta", type: "discovery", content: "Found that SQLite performs well for small datasets." });
			store.upsertNode(null, { subject: "UserPrefs", type: "preference", content: "Prefers dark mode in IDE." });
		});

		test("finds nodes by keyword in subject", () => {
			const results = store.searchNodes("ProjectAlpha", 5);
			expect(results.length).toBeGreaterThanOrEqual(1);
			expect(results[0].node.subject).toBe("ProjectAlpha");
		});

		test("finds nodes by keyword in content", () => {
			const results = store.searchNodes("React", 5);
			expect(results.length).toBeGreaterThanOrEqual(1);
			expect(results.some(r => r.node.subject === "ProjectAlpha")).toBe(true);
		});

		test("returns empty for no matches", () => {
			const results = store.searchNodes("nonexistent_xyz", 5);
			expect(results).toEqual([]);
		});

		test("respects limit parameter", () => {
			store.upsertNode(null, { subject: "React1", type: "event", content: "React discussion 1" });
			store.upsertNode(null, { subject: "React2", type: "event", content: "React discussion 2" });
			store.upsertNode(null, { subject: "React3", type: "event", content: "React discussion 3" });
			const results = store.searchNodes("React", 2);
			expect(results.length).toBeLessThanOrEqual(2);
		});

		test("includes subject info in results", () => {
			const results = store.searchNodes("ProjectAlpha", 5);
			expect(results[0].subject).not.toBeNull();
			expect(results[0].subject!.subject).toBe("ProjectAlpha");
		});
	});

	// ─── Subject ────────────────────────────────────────

	describe("ensureSubject / getSubject", () => {
		test("creates subject on first upsert", () => {
			store.upsertNode(null, { subject: "NewSubject", type: "event", content: "test" });
			const subject = store.getSubject("NewSubject");
			expect(subject).not.toBeNull();
			expect(subject!.subject).toBe("NewSubject");
			expect(subject!.nodeCount).toBe(1);
		});

		test("returns null for unknown subject", () => {
			expect(store.getSubject("Unknown")).toBeNull();
		});

		test("updates nodeCount when nodes are added/evolved", () => {
			store.upsertNode(null, { subject: "X", type: "event", content: "a" });
			store.upsertNode(null, { subject: "X", type: "decision", content: "b" });
			expect(store.getSubject("X")!.nodeCount).toBe(2);

			// Evolving shouldn't change count
			store.upsertNode(null, { subject: "X", type: "event", content: "a updated" });
			expect(store.getSubject("X")!.nodeCount).toBe(2);
		});
	});

	// ─── Edges ──────────────────────────────────────────

	describe("createEdge / getRelatedSubjects", () => {
		test("creates a relationship between two subjects", () => {
			store.upsertNode(null, { subject: "Alice", type: "event", content: "met Bob" });
			store.upsertNode(null, { subject: "Bob", type: "event", content: "met Alice" });
			store.createEdge("Alice", "Bob", "collaborates_with");

			const edges = store.getRelatedSubjects("Alice");
			expect(edges).toHaveLength(1);
			expect(edges[0].subject).toBe("Bob");
			expect(edges[0].relation).toBe("collaborates_with");
		});

		test("retrieves edges from both directions", () => {
			store.createEdge("A", "B", "depends_on");
			const fromA = store.getRelatedSubjects("A");
			const fromB = store.getRelatedSubjects("B");
			expect(fromA).toHaveLength(1);
			expect(fromB).toHaveLength(1);
		});

		test("auto-creates subjects for edge endpoints", () => {
			store.createEdge("NewA", "NewB", "related");
			expect(store.getSubject("NewA")).not.toBeNull();
			expect(store.getSubject("NewB")).not.toBeNull();
		});
	});
});
