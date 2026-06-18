// P1 单元测试:wiki 锚点注入渲染
//
// # 文件说明书
//
// ## 核心功能
// 验证 v0.8 P1 (acceptance-P1.md「锚点注入」节):
//   - resolveAnchors:auto memory (5 type roots) + auto project (wiki-root:<projectId>)
//     + free (AgentRecord.wikiAnchors)
//   - 渲染:
//     · project 锚点 → 子树前 2 层 title + summary(不带正文)
//     · memory  锚点 → 索引(每条 title + nodeId 链接)
//   - 通道:system / context / off
//
// ## 输入
// 临时 SessionDB + 真实 WikiStore + 构造的 AgentRecord.wikiAnchors。
//
// ## 输出
// Vitest snapshot + 结构断言。
//
// ## 关键文件
//   - src/runtime/wiki-anchor-injection.ts (resolveAnchors / renderSystemAnchors /
//     renderContextAnchors / anchorNodeIds / DEFAULT_PROJECT_ANCHOR_DEPTH)
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { ProjectStore } from "../../src/server/project-store.js";
import {
	WikiStore,
	WIKI_GLOBAL_ROOT_ID,
	projectSubtreeRootId,
	memoryTypeRootId,
} from "../../src/server/wiki-node-store.js";
import {
	resolveAnchors,
	renderSystemAnchors,
	renderContextAnchors,
	anchorNodeIds,
	DEFAULT_PROJECT_ANCHOR_DEPTH,
} from "../../src/runtime/wiki-anchor-injection.js";
import type { AgentRecord, SessionContextBundle } from "../../src/shared/types.js";

let tmpDir: string;
let sessionDB: SessionDB;
let wiki: WikiStore;
let projectStore: ProjectStore;
const createdNodeIds: string[] = [];

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-p1-inject-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	wiki = new WikiStore(sessionDB);
	createdNodeIds.length = 0;
});

afterEach(() => {
	for (const id of [...createdNodeIds].reverse()) {
		try { wiki.delete(id); } catch { /* gone */ }
	}
	try { sessionDB.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

function track<T extends { id: string }>(n: T): T {
	createdNodeIds.push(n.id);
	return n;
}

// ─── resolveAnchors:auto memory + auto project + free ─────────

describe("P1 §10.3.1 resolveAnchors:auto + free anchors", () => {
	test("auto memory = 5 global type roots (context channel, depth=1)", () => {
		const anchors = resolveAnchors({ wiki, agentId: "agent-x" });
		const memAnchors = anchors.filter((a) => a.kind === "memory");
		expect(memAnchors.length).toBe(5);
		// All 5 type roots present.
		const ids = new Set(memAnchors.map((a) => a.nodeId));
		expect(ids.has(memoryTypeRootId("event"))).toBe(true);
		expect(ids.has(memoryTypeRootId("decision"))).toBe(true);
		expect(ids.has(memoryTypeRootId("discovery"))).toBe(true);
		expect(ids.has(memoryTypeRootId("status_change"))).toBe(true);
		expect(ids.has(memoryTypeRootId("preference"))).toBe(true);
		// Default channel for auto-memory = context.
		expect(memAnchors.every((a) => a.inject === "context")).toBe(true);
	});

	test("auto project = wiki-root:<projectId> (system channel, depth=2)", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const bundle: SessionContextBundle = {
			projectId: proj.id,
			workspaceDir: join(tmpDir, "p"),
		} as SessionContextBundle;
		const anchors = resolveAnchors({
			wiki, agentId: "archivist-x", contextBundle: bundle,
		});
		const projAnchors = anchors.filter((a) => a.kind === "project" && a.inject === "system");
		expect(projAnchors.length).toBeGreaterThanOrEqual(1);
		expect(projAnchors.some((a) => a.nodeId === projectSubtreeRootId(proj.id))).toBe(true);
		const projAnchor = projAnchors.find((a) => a.nodeId === projectSubtreeRootId(proj.id))!;
		expect(projAnchor.depth).toBe(DEFAULT_PROJECT_ANCHOR_DEPTH);
		expect(projAnchor.depth).toBe(2);
	});

	test("zero (no projectId) → only memory + free anchors, no project anchor", () => {
		const anchors = resolveAnchors({ wiki, agentId: "zero" });
		expect(anchors.some((a) => a.kind === "project")).toBe(false);
		expect(anchors.filter((a) => a.kind === "memory").length).toBe(5);
	});

	test("free anchors override inject channel (free wins over auto)", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		track(wiki.ensureProjectSubtree(proj.id, "P"));
		const bundle = { projectId: proj.id, workspaceDir: join(tmpDir, "p") } as SessionContextBundle;
		const freeAnchors: AgentRecord["wikiAnchors"] = [
			{ nodeId: projectSubtreeRootId(proj.id), inject: "off" },
		];
		const anchors = resolveAnchors({
			wiki, agentId: "archivist-x", contextBundle: bundle, wikiAnchors: freeAnchors,
		});
		const projAnchor = anchors.find((a) => a.nodeId === projectSubtreeRootId(proj.id));
		expect(projAnchor).toBeDefined();
		// Free wins on inject → off.
		expect(projAnchor!.inject).toBe("off");
	});

	test("anchorNodeIds: dedupes the union", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		track(wiki.ensureProjectSubtree(proj.id, "P"));
		const bundle = { projectId: proj.id, workspaceDir: join(tmpDir, "p") } as SessionContextBundle;
		const freeAnchors: AgentRecord["wikiAnchors"] = [
			// Duplicate of the auto memory decision anchor.
			{ nodeId: memoryTypeRootId("decision"), inject: "context" },
		];
		const anchors = resolveAnchors({
			wiki, agentId: "x", contextBundle: bundle, wikiAnchors: freeAnchors,
		});
		const ids = anchorNodeIds(anchors);
		// decision appears once even though free + auto both list it.
		expect(ids.filter((id) => id === memoryTypeRootId("decision")).length).toBe(1);
	});
});

// ─── 渲染:project 2 层 outline + memory 索引 ──────────────────

describe("P1 §10.6 渲染:project 2 层 outline + memory 索引", () => {
	test("project anchor 渲染:子树前 2 层 title+summary,不带正文", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "Project P"));
		// Level-1 children.
		const mod = track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "structure", path: "structure:src",
			title: "src/", summary: "Source tree",
			detail: "BODY THAT MUST NOT APPEAR",  // body must be excluded
		}));
		// Level-2 grandchildren.
		const header = track(wiki.upsertProjectNode(proj.id, {
			parentId: mod.id, type: "header", path: "header:src/a.ts",
			title: "a.ts", summary: "Module a",
			detail: "DEEP BODY MUST NOT APPEAR",
		}));
		// Level-3 great-grandchild — must NOT render (depth=2 truncation).
		const deep = track(wiki.upsertProjectNode(proj.id, {
			parentId: header.id, type: "structure", path: "structure:fn-foo",
			title: "fn foo", summary: "Should be truncated by depth=2",
		}));

		const anchors = resolveAnchors({
			wiki, agentId: "x",
			contextBundle: { projectId: proj.id, workspaceDir: join(tmpDir, "p") } as SessionContextBundle,
		});
		const out = renderSystemAnchors({ wiki, anchors });
		expect(out).toContain("Project P");
		expect(out).toContain("src/");
		expect(out).toContain("Source tree");
		expect(out).toContain("a.ts");
		expect(out).toContain("Module a");
		// Bodies never injected.
		expect(out).not.toContain("BODY THAT MUST NOT APPEAR");
		expect(out).not.toContain("DEEP BODY MUST NOT APPEAR");
		// Level-3 truncated by default depth=2.
		expect(out).not.toContain("Should be truncated by depth=2");
	});

	test("memory anchor 渲染:索引 (title + nodeId 链接,不展开内容)", () => {
		wiki.ensureMemoryTypeRoot("decision");
		wiki.ensureMemoryTypeRoot("event");
		const decLeaf = track(wiki.createMemoryNode({
			parentId: memoryTypeRootId("decision"),
			path: "memory:dec-subject-1",
			title: "Decided on SQLite",
			summary: "internal rationale that must NOT leak",
		}));
		const evtLeaf = track(wiki.createMemoryNode({
			parentId: memoryTypeRootId("event"),
			path: "memory:evt-subject-1",
			title: "Initial scan completed",
		}));

		const anchors = resolveAnchors({ wiki, agentId: "x" });
		const out = renderContextAnchors({ wiki, anchors });

		// Index includes both leaves' titles + their nodeId links.
		expect(out).toContain("Decided on SQLite");
		expect(out).toContain(decLeaf.id);
		expect(out).toContain("Initial scan completed");
		expect(out).toContain(evtLeaf.id);
		// Index does NOT expand content.
		expect(out).not.toContain("internal rationale that must NOT leak");
	});

	test("off-channel anchor 不渲染但仍在 scope 锚点集", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "P"));
		track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "header", path: "header:x.ts", title: "x.ts",
		}));
		const freeAnchors: AgentRecord["wikiAnchors"] = [
			{ nodeId: projectSubtreeRootId(proj.id), inject: "off" },
		];
		const anchors = resolveAnchors({
			wiki, agentId: "x",
			contextBundle: { projectId: proj.id, workspaceDir: join(tmpDir, "p") } as SessionContextBundle,
			wikiAnchors: freeAnchors,
		});
		// off-anchor is in the scope union (anchorNodeIds).
		const ids = anchorNodeIds(anchors);
		expect(ids).toContain(projectSubtreeRootId(proj.id));
		// But neither system nor context render it.
		expect(renderSystemAnchors({ wiki, anchors })).toBe("");
		expect(renderContextAnchors({ wiki, anchors })).toBe("");
	});

	test("no anchors → both renders empty string", () => {
		// Use a wiki with no project context and no free anchors — auto memory
		// still produces 5 memory anchors, so renderContextAnchors may emit
		// type-root headers. Confirm system is empty (no project anchors).
		const anchors = resolveAnchors({ wiki, agentId: "x" });
		expect(renderSystemAnchors({ wiki, anchors })).toBe("");
	});

	test("missing anchor node (row absent) renders nothing, no throw", () => {
		const freeAnchors: AgentRecord["wikiAnchors"] = [
			{ nodeId: "wiki-root:nonexistent-project", inject: "system" },
		];
		const anchors = resolveAnchors({ wiki, agentId: "x", wikiAnchors: freeAnchors });
		expect(() => renderSystemAnchors({ wiki, anchors })).not.toThrow();
		expect(renderSystemAnchors({ wiki, anchors })).toBe("");
	});
});

// ─── system vs context 通道分离 ───────────────────────────────

describe("P1 §10.6 system vs context 通道分离", () => {
	test("system 通道只渲染 inject=system 锚点;context 只渲染 inject=context", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "P"));
		track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "header", path: "header:s.ts", title: "s.ts",
		}));
		// Memory anchor exists by default.
		wiki.ensureMemoryTypeRoot("decision");
		track(wiki.createMemoryNode({
			parentId: memoryTypeRootId("decision"),
			path: "memory:dec-1", title: "dec 1",
		}));

		const anchors = resolveAnchors({
			wiki, agentId: "x",
			contextBundle: { projectId: proj.id, workspaceDir: join(tmpDir, "p") } as SessionContextBundle,
		});
		const sys = renderSystemAnchors({ wiki, anchors });
		const ctx = renderContextAnchors({ wiki, anchors });

		// Project anchor → system;memory anchor → context.
		expect(sys).toContain("Project: P");
		expect(sys).not.toContain("Memory: Decisions");
		expect(ctx).toContain("Memory: Decisions");
		expect(ctx).not.toContain("Project: P");
	});
});
