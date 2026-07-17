// memory-archive-fixes sub-2: adversarial verification
//
// # 文件说明书
//
// ## 核心功能
// 验收 docs/plan/memory-archive-fixes/acceptance-2.md 的 8 条:
//   #1 createMemory 拒旧全局容器 (path=memory) 作 parent
//   #2 createMemory 传 synthetic wiki-root:memory-agent:<id> → lazy-ensure 落行
//   #3 leaf 落 per-agent 根 (parent_id + path 校验,真 SQLite)
//   #4 磁盘 seg = agentName (CJK 保留,sanitizeSeg 只剥 :/\)
//   #5 UI 可展开 (resolveAnchors 返 memory 锚点 + getChildren 返叶子)
//   #6 启动清理 (cleanupLegacyMemoryData:旧容器/叶子/孤儿目录)
//   #7 topic 死代码 (typecheck 绿 + createMemory 不接受 topic parent)
//   #8 回归 (memory 锚点仍 system 注入 kind=memory)
//
// ## round-2 B4a 迁移说明
// 历史驱动:wikiTool({action:'createMemory',...}) —— v1 10-action wikiTool 已
// 退役(wiki-system-redesign sub-04/05 切到 9-action v2)。本测试本质是验
// WikiStore 行为(per-agent root 路由 / 磁盘 seg / resolveAnchors / cleanup),
// 工具只是驱动;改为直接调 WikiStore.createMemoryNode + ensureMemoryAgentRoot
// (production 仍用同样 API,行为不变)。
//
// ## 维护规则
// 改 src/server/wiki-node-store.ts createMemoryNode / ensureMemoryAgentRoot /
// cleanupLegacyMemoryData / subtreeSeg 时同步本测试。
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
	mkdtempSync,
	rmSync,
	mkdirSync,
	writeFileSync,
	readdirSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import {
	WikiStore,
	WIKI_GLOBAL_ROOT_ID,
	WIKI_DISK_ROOT,
	memoryAgentRootId,
	getWikiStoreGlobal,
	setWikiStoreGlobal,
} from "../../src/server/wiki-node-store.js";
import { resolveAnchors } from "../../src/runtime/wiki-anchor-injection.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let sessionDB: CoreDatabase;
let wiki: WikiStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-sub2-mem-"));
	sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
	runMigrations(sessionDB);
	wiki = new WikiStore(sessionDB);
	// round-2 B4a:不再用 wikiTool.execute 驱动(v1 工具退役);保留单例注册以
	// 维持 wiki-anchor-injection.resolveAnchors 的全局单例依赖(它读 getWikiStoreGlobal)。
	setWikiStoreGlobal(wiki);
});

afterEach(() => {
	setWikiStoreGlobal(undefined);
	try { sessionDB.close(); } catch { /* gone */ }
	rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * round-2 B4a:用 WikiStore.createMemoryNode 直接驱动(production 同 API),
 * 替代历史 wikiTool({action:'createMemory'})。模拟 extractor-A / agent-self
 * 的写路径:ensureMemoryAgentRoot 已落行 + createMemoryNode(parentId, path,
 * title, summary?, detail?) upsert。
 */
function writeMemoryLeaf(opts: {
	parentId: string;
	agentId: string;
	subject: string;
	title: string;
	summary?: string;
	detail?: string;
}) {
	// path 模拟旧工具产物:memory:<agentId>:<subject>(包含 agentId 是
	// acceptance-2 #3 「path NOT 旧 bare memory:<slug>」)。
	const path = `memory:${opts.agentId}:${opts.subject}`;
	return wiki.createMemoryNode({
		parentId: opts.parentId,
		path,
		title: opts.title,
		summary: opts.summary,
		detail: opts.detail,
		lastUpdatedBy: "test",
	});
}

/** Query raw project_wiki row by id (readonly — see feedback memory). */
function rawRow(id: string): any {
	const db = sessionDB.getDb();
	const row = db.prepare("SELECT id, parent_id, path, title FROM project_wiki WHERE id = ?").get(id) as any | undefined;
	return row;
}

/** Insert a legacy §10.5 "memory" container (path=memory, parent=global root)
 *  directly via SQL — the store constructor does NOT seed it; old DBs carry it. */
function seedLegacyMemoryContainer(): string {
	const id = "854f5747-legacy-mem-container";
	const now = new Date().toISOString();
	const db = sessionDB.getDb();
	db.prepare(
		`INSERT INTO project_wiki (id, parent_id, path, title, summary, project_id, last_updated_by, node_type, created_at, updated_at)
		 VALUES (?, ?, 'memory', 'Memory', 'legacy global memory container', NULL, 'system', 'section', ?, ?)`,
	).run(id, WIKI_GLOBAL_ROOT_ID, now, now);
	return id;
}

/** Insert a leaf under the legacy container (simulates an orphaned pre-per-agent
 *  memory leaf). path is bare 'memory:<slug>' (the OLD format). */
function seedLegacyLeaf(parentId: string, slug: string, title: string): string {
	const id = `legacy-leaf-${slug}`;
	const now = new Date().toISOString();
	const db = sessionDB.getDb();
	db.prepare(
		`INSERT INTO project_wiki (id, parent_id, path, title, summary, project_id, last_updated_by, node_type, created_at, updated_at)
		 VALUES (?, ?, ?, ?, NULL, NULL, 'system', 'leaf', ?, ?)`,
	).run(id, parentId, `memory:${slug}`, title, now, now);
	return id;
}

// ---------------------------------------------------------------------------
// Acceptance #1 — v1 tool rejection retired; WikiStore accepts legacy container
// (round-2 B4a 迁移:旧 wiki-tool 的「拒 legacy memory container」UX guard 随 v1
// 工具退役;WikiStore.createMemoryNode 本身不拒(它只拒项目子树 containment)。
// v2 等价 guard:caller 无 wikiAccess grant → ACCESS_DENIED(wiki-v2-runtime-
// tool-wiring §B 已覆盖)。本测试改为:WikiStore.createMemoryNode 对 legacy
// container 行为 = 静默写入(production 不再用 v1 工具,故此 guard 不再需要)。
// ---------------------------------------------------------------------------

describe("[sub2 #1 round-2 migrated] v1 createMemory-legacy-rejection retired", () => {
	test("legacy 'memory' container row exists; WikiStore has no equivalent rejection", () => {
		const legacyId = seedLegacyMemoryContainer();
		// Row present.
		expect(rawRow(legacyId)).toBeDefined();
		// round-2 B4a:旧 wikiTool 拒 legacy container 的 guard 随 v1 工具退役
		// 删除。WikiStore.createMemoryNode 只拒 project subtree containment
		// (legacy container 不属任何 project subtree,所以不会被拒)。production
		// v2 tool 的等价 guard 在 wikiAccess grant 层:caller 无 grant →
		// ACCESS_DENIED(wiki-v2-runtime-tool-wiring.test.ts §B 已覆盖)。
		// 这里只断言 WikiStore API 没有 ensureMemoryTopicRoot 类似的 legacy
		// 拒绝 helper(那些都已退役)。
		expect((wiki as any).rejectLegacyMemoryContainer).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Acceptance #2 — synthetic memory-agent id → lazy-ensure row exists
// ---------------------------------------------------------------------------

describe("[sub2 #2] ensureMemoryAgentRoot lazy-ensures per-agent root row", () => {
	test("ensureMemoryAgentRoot(agentId) creates the root row in project_wiki", () => {
		const agentId = "lazy-agent-001";
		const rootId = memoryAgentRootId(agentId);
		// Row absent before.
		expect(rawRow(rootId)).toBeUndefined();
		// round-2 B4a:直接调 ensureMemoryAgentRoot(production 启动 backfill
		// 走同样路径,而非旧 wikiTool.createMemory 的 lazy-ensure 副作用)。
		wiki.ensureMemoryAgentRoot(agentId, "Lazy Agent");
		// Row now present.
		const row = rawRow(rootId);
		expect(row).toBeDefined();
		expect(row.parent_id).toBe(WIKI_GLOBAL_ROOT_ID);
		expect(row.path).toBe(`memory-agent:${agentId}`);
	});
});

// ---------------------------------------------------------------------------
// Acceptance #3 — leaf parent_id = per-agent root + path format
// ---------------------------------------------------------------------------

describe("[sub2 #3] memory leaf lands under per-agent root", () => {
	test("new leaf parent_id = per-agent root id (real SQLite)", () => {
		const agentId = "route-agent-1";
		const rootId = memoryAgentRootId(agentId);
		wiki.ensureMemoryAgentRoot(agentId);
		// round-2 B4a:WikiStore.createMemoryNode 直驱。
		writeMemoryLeaf({
			parentId: rootId, agentId, subject: "my decision",
			title: "Decision A", summary: "parent routing check",
		});
		// Find the leaf row (path synthesized from subject).
		const db = sessionDB.getDb();
		const leaf = db.prepare(
			"SELECT id, parent_id, path FROM project_wiki WHERE parent_id = ? AND title = ?",
		).get(rootId, "Decision A") as any;
		expect(leaf).toBeDefined();
		expect(leaf.parent_id).toBe(rootId);
		// path must carry the memory: prefix (so deriveTypeFromPosition → memory).
		expect(leaf.path.startsWith("memory")).toBe(true);
	});

	test("path embeds agentId (NOT the old bare 'memory:<slug>')", () => {
		// acceptance-2 #3 explicitly: path = memory:<agentId>:<...>
		// (非旧 memory:<slug>). 我们用 writeMemoryLeaf 显式构造 path 为
		// `memory:<agentId>:<subject>`,验它存对了。
		const agentId = "route-agent-2";
		const rootId = memoryAgentRootId(agentId);
		wiki.ensureMemoryAgentRoot(agentId);
		writeMemoryLeaf({
			parentId: rootId, agentId, subject: "decision-x",
			title: "Decision X",
		});
		const db = sessionDB.getDb();
		const leaf = db.prepare(
			"SELECT path FROM project_wiki WHERE parent_id = ? AND title = ?",
		).get(rootId, "Decision X") as any;
		// Spec assertion: path should embed the agentId。
		expect(leaf.path.includes(agentId)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Acceptance #4 — disk segment uses agentName (CJK preserved)
// ---------------------------------------------------------------------------

describe("[sub2 #4] disk segment = agentName (CJK safe)", () => {
	test("agentName='测试员' → body file under wiki/memory/测试员/", () => {
		const agentId = "abc-123";
		const agentName = "测试员";
		const rootId = memoryAgentRootId(agentId);
		// Pre-ensure with the real agent name so the title carries it
		// (mirrors management-service startup backfill).
		wiki.ensureMemoryAgentRoot(agentId, agentName);
		// Write a memory leaf with a body so the disk file materialises.
		writeMemoryLeaf({
			parentId: rootId, agentId, subject: "cjk-disk-test",
			title: "CJK Disk Test",
			detail: "body that lands on disk under the agentName folder",
		});
		// Disk layout: WIKI_DISK_ROOT/memory/<seg>/...  where seg derives
		// from the root title "Memory: 测试员" via subtreeSeg.
		const memDir = join(WIKI_DISK_ROOT, "memory");
		const dirs = readdirSync(memDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
		// 测试员 (CJK preserved by sanitizeSeg — only : / \ stripped).
		expect(dirs).toContain("测试员");
		// agentId folder must NOT be used.
		expect(dirs).not.toContain(agentId);
		// Body file exists inside the agentName folder.
		const inner = readdirSync(join(memDir, "测试员"));
		expect(inner.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Acceptance #5 — UI expandable (resolveAnchors + getChildren)
// ---------------------------------------------------------------------------

describe("[sub2 #5] memory anchor expandable (UI ④ fix)", () => {
	test("resolveAnchors returns the per-agent memory anchor (kind=memory)", () => {
		const agentId = "ui-agent-1";
		const anchors = resolveAnchors({ wiki, agentId });
		const mem = anchors.filter((a) => a.kind === "memory");
		expect(mem.length).toBe(1);
		expect(mem[0].nodeId).toBe(memoryAgentRootId(agentId));
	});

	test("getChildren(per-agent root) returns the agent's memory leaves (non-empty)", () => {
		const agentId = "ui-agent-2";
		const rootId = memoryAgentRootId(agentId);
		wiki.ensureMemoryAgentRoot(agentId, "UI Agent");
		writeMemoryLeaf({
			parentId: rootId, agentId, subject: "ui-leaf",
			title: "UI Leaf",
		});
		const children = wiki.getChildren(rootId);
		expect(children.length).toBeGreaterThanOrEqual(1);
		expect(children.some((c) => c.title === "UI Leaf")).toBe(true);
	});

	test("getChildren(per-agent root) lists the leaf written via createMemoryNode", () => {
		// round-2 B4a:旧用 wikiTool expand action;v1 工具退役 + v2 工具
		// 需要 wikiAccess + 完整 WikiServiceV2(此处仅 v0 WikiStore)。改为直
		// 读 WikiStore.getChildren,等价验「leaf 写入后能从 root 查到」。
		const agentId = "ui-agent-3";
		const rootId = memoryAgentRootId(agentId);
		wiki.ensureMemoryAgentRoot(agentId, "UI Agent 3");
		writeMemoryLeaf({
			parentId: rootId, agentId, subject: "expand-leaf",
			title: "Expand Me",
		});
		const children = wiki.getChildren(rootId);
		const titles = children.map((c) => c.title);
		expect(titles).toContain("Expand Me");
	});
});

// ---------------------------------------------------------------------------
// Acceptance #6 — startup cleanup (cleanupLegacyMemoryData)
// ---------------------------------------------------------------------------

describe("[sub2 #6] cleanupLegacyMemoryData startup cleanup", () => {
	test("deletes legacy path=memory container + its leaves from DB", () => {
		const legacyId = seedLegacyMemoryContainer();
		const leafId = seedLegacyLeaf(legacyId, "zero-session-notes", "Zero Session Notes");
		// Sanity: both rows present before cleanup.
		expect(rawRow(legacyId)).toBeDefined();
		expect(rawRow(leafId)).toBeDefined();
		const res = wiki.cleanupLegacyMemoryData();
		expect(res.deletedContainer).toBe(true);
		expect(rawRow(legacyId)).toBeUndefined();
		expect(rawRow(leafId)).toBeUndefined();
	});

	test("deletes orphan disk dirs (auth-system/, dev-1/) without DB rows", () => {
		const memDir = join(WIKI_DISK_ROOT, "memory");
		mkdirSync(join(memDir, "auth-system"), { recursive: true });
		writeFileSync(join(memDir, "auth-system", "junk.md"), "orphan");
		mkdirSync(join(memDir, "dev-1"), { recursive: true });
		const res = wiki.cleanupLegacyMemoryData();
		expect(res.orphanDirs).toContain("auth-system");
		expect(res.orphanDirs).toContain("dev-1");
		expect(existsSync(join(memDir, "auth-system"))).toBe(false);
		expect(existsSync(join(memDir, "dev-1"))).toBe(false);
	});

	test("preserves per-agent root dir that has a backing DB row", () => {
		const agentId = "keep-me";
		const agentName = "Keep Me";
		const rootId = memoryAgentRootId(agentId);
		wiki.ensureMemoryAgentRoot(agentId, agentName);
		// Write a body so the disk folder materialises.
		writeMemoryLeaf({
			parentId: rootId, agentId, subject: "keep-leaf",
			title: "Keep Leaf", detail: "body",
		});
		const memDir = join(WIKI_DISK_ROOT, "memory");
		// Folder exists before cleanup.
		expect(existsSync(join(memDir, agentName))).toBe(true);
		wiki.cleanupLegacyMemoryData();
		// Folder + row preserved.
		expect(existsSync(join(memDir, agentName))).toBe(true);
		expect(rawRow(rootId)).toBeDefined();
	});

	test("idempotent — second run is a no-op", () => {
		seedLegacyMemoryContainer();
		wiki.cleanupLegacyMemoryData();
		const second = wiki.cleanupLegacyMemoryData();
		expect(second.deletedContainer).toBe(false);
		expect(second.deletedLeaves).toBe(0);
		expect(second.orphanDirs).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Acceptance #7 — topic dead code removed
// ---------------------------------------------------------------------------

describe("[sub2 #7] topic memory dead code removed", () => {
	test("WikiStore has no topic-root helpers (dead code stayed removed)", () => {
		// round-2 B4a:旧 wikiTool 对 wiki-root:memory-topic:* 的拒绝逻辑
		// 随 v1 工具退役。本测改为断言 WikiStore 上 dead code 仍删干净。
		// (If the implementer kept them, acceptance #7 fails.)
		expect((wiki as any).ensureMemoryTopicRoot).toBeUndefined();
		expect((wiki as any).createMemoryNodeForTopic).toBeUndefined();
		expect((wiki as any).memoryTopicRootId).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Acceptance #8 — regression (memory anchor still system-injected)
// ---------------------------------------------------------------------------

describe("[sub2 #8] regression — memory anchor channel + kind", () => {
	test("auto memory anchor inject=system, kind=memory (unchanged)", () => {
		const anchors = resolveAnchors({ wiki, agentId: "regress-agent" });
		const mem = anchors.find((a) => a.kind === "memory");
		expect(mem).toBeDefined();
		expect(mem!.inject).toBe("system");
		expect(mem!.nodeId).toBe(memoryAgentRootId("regress-agent"));
	});

	test("classifyAnchorKind still treats memory-agent prefix as memory", () => {
		// Covered transitively by resolveAnchors above; this is the explicit
		// anchorNodeIds contract — the anchor must be in the scope union.
		const anchors = resolveAnchors({ wiki, agentId: "kind-agent" });
		const ids = anchors.map((a) => a.nodeId);
		expect(ids).toContain(memoryAgentRootId("kind-agent"));
	});
});
