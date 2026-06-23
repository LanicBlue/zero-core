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
	memoryAgentRootId,
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
	test("auto memory = per-agent subtree root (context channel, depth=2)", () => {
		// v0.8 (P2 §11.6): memory anchor is now ONE per-agent subtree root
		// (wiki-root:memory-agent:<agentId>), not the 5 shared type roots.
		// The 5 shared type roots are retired as auto anchors.
		const anchors = resolveAnchors({ wiki, agentId: "agent-x" });
		const memAnchors = anchors.filter((a) => a.kind === "memory");
		expect(memAnchors.length).toBe(1);
		expect(memAnchors[0].nodeId).toBe(memoryAgentRootId("agent-x"));
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

	test("zero (no projectId) → memory anchor + GLOBAL ROOT scope anchor (read=write=whole tree)", () => {
		const anchors = resolveAnchors({ wiki, agentId: "zero" });
		// v0.8 (读写同界): a session with no project anchor gets the GLOBAL ROOT
		// as an inject:"off" scope anchor so its read scope == write scope == the
		// whole tree. Plus one per-agent memory anchor (P2 §11.6).
		expect(anchors.some((a) => a.nodeId === WIKI_GLOBAL_ROOT_ID && a.inject === "off")).toBe(true);
		expect(anchors.filter((a) => a.kind === "memory").length).toBe(1);
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

	test("anchorNodeIds: dedupes the union (free + auto memory)", () => {
		// v0.8 (P2 §11.6): the auto memory anchor is now the per-agent root.
		// A free entry pointing at the same per-agent root dedupes against it.
		const agentId = "x";
		const freeAnchors: AgentRecord["wikiAnchors"] = [
			{ nodeId: memoryAgentRootId(agentId), inject: "context" },
		];
		const anchors = resolveAnchors({ wiki, agentId, wikiAnchors: freeAnchors });
		const ids = anchorNodeIds(anchors);
		// Per-agent root appears once even though free + auto both list it.
		expect(ids.filter((id) => id === memoryAgentRootId(agentId)).length).toBe(1);
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
		// v0.8 (P2 §11.6): memory leaves live under the per-agent subtree
		// root for the resolving agent. We seed leaves under agent "x"'s root.
		const decLeaf = track(wiki.createMemoryNodeForAgent({
			agentId: "x", type: "decision", subject: "dec-subject-1",
			title: "Decided on SQLite",
			summary: "internal rationale that must NOT leak",
		}));
		const evtLeaf = track(wiki.createMemoryNodeForAgent({
			agentId: "x", type: "event", subject: "evt-subject-1",
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
		// v0.8 (P2 §11.6): memory anchor is per-agent. Seed a leaf under agent
		// "x"'s root so renderContextAnchors finds it.
		track(wiki.createMemoryNodeForAgent({
			agentId: "x", type: "decision", subject: "dec-1",
			title: "dec 1",
		}));

		const anchors = resolveAnchors({
			wiki, agentId: "x",
			contextBundle: { projectId: proj.id, workspaceDir: join(tmpDir, "p") } as SessionContextBundle,
		});
		const sys = renderSystemAnchors({ wiki, anchors });
		const ctx = renderContextAnchors({ wiki, anchors });

		// Project anchor → system;memory anchor → context.
		expect(sys).toContain("Project: P");
		expect(sys).not.toContain("Memory: x");
		expect(ctx).toContain("Memory: x");
		expect(ctx).toContain("dec 1");
		expect(ctx).not.toContain("Project: P");
	});
});
