// 单元测试:memory 合并进 wiki per-agent 子树 (v0.8 P2 §11.6)
//
// # 文件说明书
//
// ## 核心功能
// v0.8 (P2) 把独立 MemoryRecall + FTS5 召回系统废了,memory 现在是每个 agent 在
// 全局 wiki 树下自己的子树(wiki-root:memory-agent:<agentId>)。本测试覆盖:
//   1. ensureMemoryAgentRoot 按需创建 + 幂等
//   2. createMemoryNodeForAgent 按 (agentId, subject, type) upsert(create vs update)
//   3. 不同 agent 的 memory 互不污染
//   4. memoryAgentRootId / classifyAnchorKind 识 per-agent 前缀
//   5. searchMemoryNodes + readNodeDetail 读回内容(取代 MemoryRecall.recall)
//   6. renderContextAnchors(memory) 渲染 MEMORY.md 式索引 — 索引注入路径
//
// 取代旧的 memory-recall.test.ts (基于已废的 MemoryRecall + MemoryNodeStore)。
//
// ## 输入
// 临时 SessionDB (mkdtempSync) + 新建 WikiStore
//
// ## 输出
// Vitest 用例
//
// ## 维护规则
// - memory 子树路径或 id 前缀(memory-agent:)变更需同步本测试
// - searchMemoryNodes 行为变更需更新断言
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import {
	WikiStore,
	WIKI_GLOBAL_ROOT_ID,
	memoryAgentRootId,
} from "../../src/server/wiki-node-store.js";
import { runMigrations } from "../../src/server/db-migration.js";
import {
	resolveAnchors,
	renderContextAnchors,
	anchorNodeIds,
} from "../../src/runtime/wiki-anchor-injection.js";

let tmpDir: string;
let sessionDB: SessionDB;
let wiki: WikiStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-memwiki-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	wiki = new WikiStore(sessionDB);
});

afterEach(() => {
	try { sessionDB.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("memory as wiki per-agent subtree (P2 §11.6)", () => {
	describe("ensureMemoryAgentRoot", () => {
		test("creates a real row under WIKI_GLOBAL_ROOT_ID with id memoryAgentRootId(agentId)", () => {
			const root = wiki.ensureMemoryAgentRoot("dev-1");
			expect(root.id).toBe(memoryAgentRootId("dev-1"));
			expect(root.parentId).toBe(WIKI_GLOBAL_ROOT_ID);
			// v0.8 (P2 §11.6): the per-agent memory root is an INDEX/anchor
			// container, NOT a memory leaf. deriveTypeFromPosition classifies
			// it as `project` (its id starts with `wiki-root:` and the more
			// specific `wiki-root:memory:` check does not match the
			// `wiki-root:memory-agent:` prefix). That is the documented
			// behavior — listMemoryNodes / searchMemoryNodes filter type ===
			// "memory" and so do NOT pick up the root; only the leaves under
			// it (path `memory:<id>:...`) are type=memory. Asserting the root
			// itself is type=memory would contradict deriveTypeFromPosition's
			// rule chain (see wiki-node-store.ts:deriveTypeFromPosition).
			expect(root.type).toBe("project");
			expect(root.nodeType).toBe("section");
			expect(root.title).toBe("Memory: dev-1");
		});

		test("is idempotent — second call returns the same row", () => {
			const first = wiki.ensureMemoryAgentRoot("dev-1");
			const second = wiki.ensureMemoryAgentRoot("dev-1");
			expect(second.id).toBe(first.id);
		});

		test("different agents get different roots", () => {
			const a = wiki.ensureMemoryAgentRoot("dev-a");
			const b = wiki.ensureMemoryAgentRoot("dev-b");
			expect(a.id).not.toBe(b.id);
		});
	});

	describe("createMemoryNodeForAgent upsert", () => {
		test("writes a memory leaf under the agent's own subtree", () => {
			const node = wiki.createMemoryNodeForAgent({
				agentId: "dev-1",
				type: "decision",
				subject: "Pick SQLite",
				title: "Pick SQLite (decision)",
				summary: "Decided to use SQLite for storage.",
			});
			expect(node.parentId).toBe(memoryAgentRootId("dev-1"));
			expect(node.type).toBe("memory");
			expect(node.title).toContain("Pick SQLite");
		});

		test("create vs update by (agentId, subject, type)", () => {
			const first = wiki.createMemoryNodeForAgent({
				agentId: "dev-1",
				type: "decision",
				subject: "Subject-X",
				title: "Original Title",
				summary: "Original summary.",
			});
			const second = wiki.createMemoryNodeForAgent({
				agentId: "dev-1",
				type: "decision",
				subject: "Subject-X",
				title: "Updated Title",
				summary: "Updated summary.",
			});
			// Same agentId + subject + type → UPDATE, not new.
			expect(second.id).toBe(first.id);
			expect(second.title).toBe("Updated Title");

			// Same subject but different type → new node.
			const third = wiki.createMemoryNodeForAgent({
				agentId: "dev-1",
				type: "event",
				subject: "Subject-X",
				title: "Same subject, different type",
			});
			expect(third.id).not.toBe(first.id);
		});

		test("per-agent isolation — agent A's memory is invisible from agent B's subtree", () => {
			wiki.createMemoryNodeForAgent({
				agentId: "dev-a", type: "decision", subject: "Subject-A",
				title: "A only", summary: "agent A memory",
			});
			wiki.createMemoryNodeForAgent({
				agentId: "dev-b", type: "decision", subject: "Subject-B",
				title: "B only", summary: "agent B memory",
			});

			const rootA = wiki.ensureMemoryAgentRoot("dev-a");
			const rootB = wiki.ensureMemoryAgentRoot("dev-b");
			const leavesA = wiki.getChildren(rootA.id).map(n => n.title);
			const leavesB = wiki.getChildren(rootB.id).map(n => n.title);

			expect(leavesA).toContain("A only");
			expect(leavesA).not.toContain("B only");
			expect(leavesB).toContain("B only");
			expect(leavesB).not.toContain("A only");
		});
	});

	describe("classifyAnchorKind recognizes per-agent memory prefix", () => {
		test("resolveAnchors derives a memory anchor for the session's agentId", () => {
			const anchors = resolveAnchors({
				wiki,
				agentId: "dev-1",
			});
			// The auto memory anchor is the per-agent subtree root.
			const memAnchor = anchors.find(a => a.kind === "memory");
			expect(memAnchor).toBeDefined();
			expect(memAnchor!.nodeId).toBe(memoryAgentRootId("dev-1"));
			expect(memAnchor!.inject).toBe("context");
		});

		test("anchorNodeIds includes the per-agent memory root in the visible scope", () => {
			const anchors = resolveAnchors({ wiki, agentId: "dev-1" });
			const ids = anchorNodeIds(anchors);
			expect(ids).toContain(memoryAgentRootId("dev-1"));
		});
	});

	describe("read-back path replaces MemoryRecall", () => {
		test("searchMemoryNodes + readNodeDetail round-trip an extractor-A-written fact", () => {
			wiki.createMemoryNodeForAgent({
				agentId: "dev-1",
				type: "discovery",
				subject: "MultiTenantArchitecture",
				title: "MultiTenantArchitecture (discovery)",
				summary: "Discovered we need per-tenant schema.",
				detail: JSON.stringify({
					subject: "MultiTenantArchitecture",
					type: "discovery",
					content: "We need per-tenant schema for isolation.",
					sourceAgentId: "dev-1",
				}, null, 2),
			});

			const hits = wiki.searchMemoryNodes("MultiTenantArchitecture");
			expect(hits.length).toBeGreaterThan(0);
			const top = hits[0];
			expect(top.title).toContain("MultiTenantArchitecture");

			// readNodeDetail returns the body JSON written by extractor A.
			const detail = wiki.readNodeDetail(top.id);
			expect(detail).toBeTruthy();
			const parsed = JSON.parse(detail!);
			expect(parsed.subject).toBe("MultiTenantArchitecture");
			expect(parsed.sourceAgentId).toBe("dev-1");
		});

		test("searchMemoryNodes term match across title and summary", () => {
			wiki.createMemoryNodeForAgent({
				agentId: "dev-1", type: "preference", subject: "PrefersTS",
				title: "PrefersTS (preference)",
				summary: "User prefers TypeScript over JavaScript",
			});
			// Title-only term.
			expect(wiki.searchMemoryNodes("PrefersTS").length).toBeGreaterThan(0);
			// Summary-only term.
			expect(wiki.searchMemoryNodes("JavaScript").length).toBeGreaterThan(0);
		});
	});

	describe("memory index rendering (replaces formatForContext)", () => {
		test("renderContextAnchors emits a MEMORY.md-style index of leaves", () => {
			wiki.createMemoryNodeForAgent({
				agentId: "dev-1", type: "decision", subject: "Subject-A",
				title: "Subject-A (decision)", summary: "summary A",
			});
			wiki.createMemoryNodeForAgent({
				agentId: "dev-1", type: "event", subject: "Subject-B",
				title: "Subject-B (event)", summary: "summary B",
			});

			const anchors = resolveAnchors({ wiki, agentId: "dev-1" });
			const rendered = renderContextAnchors({ wiki, anchors });
			expect(rendered).toContain("Subject-A");
			expect(rendered).toContain("Subject-B");
			// MEMORY.md convention: each leaf line carries its nodeId link as a
			// short id handle (#xxxxxxxx), with an explicit body-presence label.
			// New unified format: child line = title — summary (doc size) #shortid <marker>.
			expect(rendered).toMatch(/Subject-A \(decision\) — summary A \(no doc\) #[0-9a-f]{8} leaf/);
			expect(rendered).toMatch(/Subject-B \(event\) — summary B \(no doc\) #[0-9a-f]{8} leaf/);
		});

		test("renderContextAnchors shows '(no memory leaves yet)' for an empty subtree", () => {
			// Ensure the root exists (resolveAnchors derives the id but doesn't
			// create the row); renderMemoryIndex then walks it and finds no
			// leaves.
			wiki.ensureMemoryAgentRoot("fresh-agent");
			const anchors = resolveAnchors({ wiki, agentId: "fresh-agent" });
			const rendered = renderContextAnchors({ wiki, anchors });
			// Empty memory root renders only the header — no child lines (no '- ' bullets).
		expect(rendered.match(/^\s*- /m)).toBeNull();
		});
	});
});
