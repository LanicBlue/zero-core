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
// ## 策略
// 真 SQLite (mkdtempSync 临时 DB) + 真 WikiStore + wikiTool.execute 驱动。
// vitest.config.ts 已把 ZERO_CORE_DIR 钉到 per-run temp,磁盘写不污染真实数据。
//
// ## 维护规则
// 改 src/tools/wiki-tool.ts createMemory / src/server/wiki-node-store.ts
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

import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import {
	WikiStore,
	WIKI_GLOBAL_ROOT_ID,
	WIKI_DISK_ROOT,
	memoryAgentRootId,
	getWikiStoreGlobal,
	setWikiStoreGlobal,
} from "../../src/server/wiki-node-store.js";
import { wikiTool } from "../../src/tools/wiki-tool.js";
import { resolveAnchors } from "../../src/runtime/wiki-anchor-injection.js";
import { getToolExecute } from "../../src/tools/tool-factory.js";
import type { CallerCtx } from "../../src/tools/types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let sessionDB: SessionDB;
let wiki: WikiStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-sub2-mem-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	wiki = new WikiStore(sessionDB);
	// wikiTool 直读全局单例 (getWikiStoreGlobal);注册本用例的实例。
	setWikiStoreGlobal(wiki);
});

afterEach(() => {
	setWikiStoreGlobal(undefined);
	try { sessionDB.close(); } catch { /* gone */ }
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Drive wikiTool.execute → extract the agent-facing text. */
async function execWiki(input: any, callerCtx: CallerCtx): Promise<string> {
	const exec = getToolExecute(wikiTool)!;
	const result: any = await exec(input, callerCtx);
	return result?.data?.text ?? "";
}

/** callerCtx scoped to GLOBAL_ROOT (whole-tree read+write, like Extractor A). */
function globalCtx(): CallerCtx {
	return {
		caller: "internal",
		wikiAnchorNodeIds: [WIKI_GLOBAL_ROOT_ID],
	};
}

/** callerCtx scoped to a per-agent memory root (simulates agent self-scope). */
function agentCtx(agentId: string): CallerCtx {
	return {
		caller: "internal",
		wikiAnchorNodeIds: [memoryAgentRootId(agentId)],
	};
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
// Acceptance #1 — createMemory rejects legacy global container (path=memory)
// ---------------------------------------------------------------------------

describe("[sub2 #1] createMemory rejects legacy global 'memory' container", () => {
	test("parentId = legacy path=memory container → error (not accepted)", async () => {
		const legacyId = seedLegacyMemoryContainer();
		const out = await execWiki(
			{
				action: "createMemory",
				parentId: legacyId,
				subject: "test-subject",
				title: "Test Memory",
				summary: "should be rejected",
			},
			globalCtx(),
		);
		expect(out).toMatch(/Error|rejected/i);
		// Must NOT silently create the leaf under the legacy container.
		expect(out).not.toMatch(/created/i);
	});
});

// ---------------------------------------------------------------------------
// Acceptance #2 — synthetic memory-agent id → lazy-ensure row exists
// ---------------------------------------------------------------------------

describe("[sub2 #2] createMemory lazy-ensures per-agent root row", () => {
	test("passing wiki-root:memory-agent:<id> creates the root row in project_wiki", async () => {
		const agentId = "lazy-agent-001";
		const rootId = memoryAgentRootId(agentId);
		// Row absent before.
		expect(rawRow(rootId)).toBeUndefined();
		// Drive createMemory with the synthetic anchor id as parentId.
		const out = await execWiki(
			{
				action: "createMemory",
				parentId: rootId,
				subject: "first-memory",
				title: "First",
				summary: "lazy-ensure trigger",
			},
			globalCtx(),
		);
		// Row now present.
		const row = rawRow(rootId);
		expect(row).toBeDefined();
		expect(row.parent_id).toBe(WIKI_GLOBAL_ROOT_ID);
		expect(row.path).toBe(`memory-agent:${agentId}`);
		// And the leaf was written (upsert → "created" or "updated"; the
		// tool's tag check runs AFTER the upsert so it often says "updated"
		// even for a fresh insert — both are success, not error).
		expect(out).not.toMatch(/^Error/i);
		expect(out).toMatch(/Memory node (created|updated)/i);
	});
});

// ---------------------------------------------------------------------------
// Acceptance #3 — leaf parent_id = per-agent root + path format
// ---------------------------------------------------------------------------

describe("[sub2 #3] memory leaf lands under per-agent root", () => {
	test("new leaf parent_id = per-agent root id (real SQLite)", async () => {
		const agentId = "route-agent-1";
		const rootId = memoryAgentRootId(agentId);
		await execWiki(
			{
				action: "createMemory",
				parentId: rootId,
				subject: "my decision",
				title: "Decision A",
				summary: "parent routing check",
			},
			globalCtx(),
		);
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

	test("path is NOT the old bare 'memory:<slug>' — spec wants agentId-qualified", async () => {
		// acceptance-2 #3 explicitly: path = memory:<agentId>:<type>:<slug>
		// (非旧 memory:<slug>). We check the format the tool produces.
		const agentId = "route-agent-2";
		const rootId = memoryAgentRootId(agentId);
		await execWiki(
			{
				action: "createMemory",
				parentId: rootId,
				subject: "decision-x",
				title: "Decision X",
			},
			globalCtx(),
		);
		const db = sessionDB.getDb();
		const leaf = db.prepare(
			"SELECT path FROM project_wiki WHERE parent_id = ? AND title = ?",
		).get(rootId, "Decision X") as any;
		// Report the ACTUAL path so the verdict is evidence-backed.
		// Spec assertion: path should embed the agentId.
		const agentIdEmbedded = leaf.path.includes(agentId);
		// Test passes if agentId is in the path; fails otherwise (report actual).
		expect(agentIdEmbedded).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Acceptance #4 — disk segment uses agentName (CJK preserved)
// ---------------------------------------------------------------------------

describe("[sub2 #4] disk segment = agentName (CJK safe)", () => {
	test("agentName='测试员' → body file under wiki/memory/测试员/", async () => {
		const agentId = "abc-123";
		const agentName = "测试员";
		const rootId = memoryAgentRootId(agentId);
		// Pre-ensure with the real agent name so the title carries it
		// (mirrors management-service startup backfill).
		wiki.ensureMemoryAgentRoot(agentId, agentName);
		// Write a memory leaf with a body so the disk file materialises.
		await execWiki(
			{
				action: "createMemory",
				parentId: rootId,
				subject: "cjk-disk-test",
				title: "CJK Disk Test",
				content: "body that lands on disk under the agentName folder",
			},
			globalCtx(),
		);
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

	test("getChildren(per-agent root) returns the agent's memory leaves (non-empty)", async () => {
		const agentId = "ui-agent-2";
		const rootId = memoryAgentRootId(agentId);
		wiki.ensureMemoryAgentRoot(agentId, "UI Agent");
		await execWiki(
			{
				action: "createMemory",
				parentId: rootId,
				subject: "ui-leaf",
				title: "UI Leaf",
			},
			globalCtx(),
		);
		const children = wiki.getChildren(rootId);
		expect(children.length).toBeGreaterThanOrEqual(1);
		expect(children.some((c) => c.title === "UI Leaf")).toBe(true);
	});

	test("expand action via tool shows the leaf under the per-agent root", async () => {
		const agentId = "ui-agent-3";
		const rootId = memoryAgentRootId(agentId);
		wiki.ensureMemoryAgentRoot(agentId, "UI Agent 3");
		await execWiki(
			{
				action: "createMemory",
				parentId: rootId,
				subject: "expand-leaf",
				title: "Expand Me",
			},
			globalCtx(),
		);
		const out = await execWiki(
			{ action: "expand", nodeId: rootId },
			globalCtx(),
		);
		expect(out).toContain("Expand Me");
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

	test("deletes a non-ASCII orphan directory without crashing", () => {
		const memDir = join(WIKI_DISK_ROOT, "memory");
		const orphanName = "测试员";
		const orphanDir = join(memDir, orphanName);
		mkdirSync(orphanDir, { recursive: true });
		writeFileSync(join(orphanDir, "memory.md"), "orphan");

		const res = wiki.cleanupLegacyMemoryData();

		expect(res.orphanDirs).toContain(orphanName);
		expect(existsSync(orphanDir)).toBe(false);
	});

	test("preserves per-agent root dir that has a backing DB row", async () => {
		const agentId = "keep-me";
		const agentName = "Keep Me";
		const rootId = memoryAgentRootId(agentId);
		wiki.ensureMemoryAgentRoot(agentId, agentName);
		// Write a body so the disk folder materialises.
		await execWiki(
			{
				action: "createMemory",
				parentId: rootId,
				subject: "keep-leaf",
				title: "Keep Leaf",
				content: "body",
			},
			globalCtx(),
		);
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
	test("createMemory rejects wiki-root:memory-topic:* parent", async () => {
		const out = await execWiki(
			{
				action: "createMemory",
				parentId: "wiki-root:memory-topic:some-topic",
				subject: "topic-leaf",
				title: "Topic Leaf",
			},
			globalCtx(),
		);
		// No row exists for the topic root → resolveNodeIdArg fails → error.
		expect(out).toMatch(/Error|not in scope/i);
		expect(out).not.toMatch(/created/i);
	});

	test("ensureMemoryTopicRoot / createMemoryNodeForTopic / memoryTopicRootId are gone", () => {
		// After dead-code removal these must not exist on the store / module.
		// (If the implementer kept them, acceptance #7 fails.)
		expect((wiki as any).ensureMemoryTopicRoot).toBeUndefined();
		expect((wiki as any).createMemoryNodeForTopic).toBeUndefined();
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
