// Sub-1 adversarial verification: Wiki 注入默认根调整
//
// # 文件说明书
//
// ## 核心功能
// 验收 compression-archive-simplify/acceptance-1.md items #1-#6:
//   #1 memory-root 默认 inject=system(不再是 context)
//   #2 zero(无 projectId)global-root inject=system(不再是 off)+ 实际渲染非空
//   #3 有 projectId 的 agent:project-root inject=system;memory-root 也进 system
//   #4 冻结快照:wiki-system-anchors section cacheBreak=false;mid-session
//      wiki 内容写不触发重渲染(只 wikiAnchors patch / resetSession 触发)
//   #5 free wikiAnchors:per-anchor inject:system|context|off 原样保留
//   #6 renderAnchorOutline(via renderSystemAnchors)格式:
//      根 title + #shortid + (doc N) header 行 + 可选根 doc 行 +
//      子节点 `- title — summary (doc N) #id ▾N|leaf`
//
// ## 设计
// 真 WikiStore + 临时 SessionDB(同 p1-anchor-injection.test.ts 风格);
// 冻结测试用 SystemPromptAssembler + 复刻 agent-loop.ts L218-229 的 section
// 闭包(捕获 anchors + wikiStoreGlobal),验证 cache 命中语义。
//
// ## 关键文件
//   - src/runtime/wiki-anchor-injection.ts (resolveAnchors/renderSystemAnchors)
//   - src/runtime/prompt-sections.ts (SystemPromptAssembler cacheBreak 语义)
//   - src/runtime/agent-loop.ts L218-229 (wiki-system-anchors section 闭包)
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
} from "../../src/runtime/wiki-anchor-injection.js";
import { SystemPromptAssembler } from "../../src/runtime/prompt-sections.js";
import type {
	AgentRecord,
	SessionContextBundle,
	WikiNode,
} from "../../src/shared/types.js";

let tmpDir: string;
let sessionDB: SessionDB;
let wiki: WikiStore;
let projectStore: ProjectStore;
const createdNodeIds: string[] = [];

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-sub1-"));
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

/** Build the same wiki-system-anchors section closure that agent-loop.ts
 *  registers (L218-229). Captures the resolved anchors + wiki store; computes
 *  by merging renderSystemAnchors + renderContextAnchors. cacheBreak:false. */
function makeWikiSystemAnchorsSection(
	wikiRef: WikiStore,
	anchorsRef: { anchors: ReturnType<typeof resolveAnchors> },
) {
	return {
		name: "wiki-system-anchors",
		compute: () => {
			const sys = renderSystemAnchors({ wiki: wikiRef, anchors: anchorsRef.anchors });
			const ctx = renderContextAnchors({ wiki: wikiRef, anchors: anchorsRef.anchors });
			if (!sys && !ctx) return "";
			if (!ctx) return sys;
			if (!sys) return ctx;
			return sys + "\n\n" + ctx;
		},
		cacheBreak: false as const,
	};
}

describe("sub-1 acceptance-1: Wiki 注入默认根调整", () => {
	// ─── #1 memory-root 默认 inject=system ──────────────────────────

	test("#1 resolveAnchors (no project): memory anchor inject === 'system', NOT 'context'", () => {
		const anchors = resolveAnchors({ wiki, agentId: "a1" });
		const memAnchors = anchors.filter((a) => a.kind === "memory");
		expect(memAnchors.length).toBe(1);
		expect(memAnchors[0].nodeId).toBe(memoryAgentRootId("a1"));
		// Spec: memory anchor moved context → system (compression-archive sub-1).
		expect(memAnchors[0].inject).toBe("system");
		// Adversarial explicit guard — must NOT be the old value.
		expect(memAnchors[0].inject).not.toBe("context");
	});

	// ─── #2 zero global-root: inject=system + 实际渲染 ──────────────

	test("#2 zero (no projectId): global-root inject === 'system' (NOT 'off') + render non-empty", () => {
		// Seed global root with a doc + one child so renderAnchorOutline emits
		// header + root doc + child line.
		wiki.update(WIKI_GLOBAL_ROOT_ID, { detail: "Global root overview doc for zero." } as any);
		track(wiki.create({
			parentId: WIKI_GLOBAL_ROOT_ID,
			type: "structure",
			nodeType: "section",
			path: "structure:zero-child",
			title: "zero-child",
			summary: "A top-level child visible to zero",
		} as Omit<WikiNode, "id" | "createdAt" | "updatedAt">));

		const anchors = resolveAnchors({ wiki, agentId: "zero" });
		const globalRootAnchor = anchors.find((a) => a.nodeId === WIKI_GLOBAL_ROOT_ID);
		expect(globalRootAnchor).toBeDefined();
		// Spec: zero global-root moved off → system (compression-archive sub-1).
		expect(globalRootAnchor!.inject).toBe("system");
		// Adversarial explicit guard.
		expect(globalRootAnchor!.inject).not.toBe("off");

		// Resolve → render path actually emits content (not just resolves).
		const out = renderSystemAnchors({ wiki, anchors });
		expect(out).not.toBe("");
		expect(out).toContain("Global Wiki Memory Root"); // root title
		expect(out).toContain("Global root overview doc for zero."); // root doc (capped)
		expect(out).toContain("zero-child"); // child title
		expect(out).toContain("A top-level child visible to zero"); // child summary
	});

	// ─── #3 有 project 的 agent:project-root + memory-root 都进 system ──

	test("#3 with projectId: project-root inject === 'system' AND memory-root inject === 'system'", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		track(wiki.ensureProjectSubtree(proj.id, "Project P"));
		const anchors = resolveAnchors({
			wiki, agentId: "a1",
			contextBundle: { projectId: proj.id, workspaceDir: join(tmpDir, "p") } as SessionContextBundle,
		});
		const projAnchor = anchors.find((a) => a.nodeId === projectSubtreeRootId(proj.id));
		expect(projAnchor).toBeDefined();
		expect(projAnchor!.inject).toBe("system");
		const memAnchor = anchors.find((a) => a.kind === "memory");
		expect(memAnchor).toBeDefined();
		expect(memAnchor!.nodeId).toBe(memoryAgentRootId("a1"));
		expect(memAnchor!.inject).toBe("system");
	});

	// ─── #4 冻结快照(cacheBreak:false + 内容写不失效)──────────────

	test("#4 wiki-system-anchors section: cacheBreak=false; mid-session wiki content write does NOT invalidate", async () => {
		// Seed a project subtree with a child whose summary we can mutate.
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "Project P"));
		const child = track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "structure", path: "structure:src",
			title: "src/", summary: "ORIGINAL-SUMMARY",
		}));

		// resolveAnchors captures the anchor list at construction time
		// (mirrors agent-loop.ts L203-208).
		const bag = { anchors: resolveAnchors({
			wiki, agentId: "a1",
			contextBundle: { projectId: proj.id, workspaceDir: join(tmpDir, "p") } as SessionContextBundle,
		}) };
		const section = makeWikiSystemAnchorsSection(wiki, bag);
		// Adversarial: cacheBreak REALLY is false (read the registered value).
		expect(section.cacheBreak).toBe(false);

		const assembler = new SystemPromptAssembler([section]);

		// First assemble → compute runs → cache populated.
		const first = await assembler.assemble();
		const firstText = first[0]?.text ?? "";
		expect(firstText).toContain("ORIGINAL-SUMMARY");

		// Mid-session wiki CONTENT write (child summary mutation). This is NOT
		// a wikiAnchors patch — agent-loop.ts L1238 only invalidates on
		// patch.wikiAnchors, NOT on wiki content writes.
		wiki.update(child.id, { summary: "MUTATED-SUMMARY-SHOULD-NOT-APPEAR-FROZEN" } as any);

		// Second assemble → cache HIT → output identical (frozen snapshot).
		const second = await assembler.assemble();
		const secondText = second[0]?.text ?? "";
		expect(secondText).toBe(firstText); // byte-for-byte identical
		expect(secondText).toContain("ORIGINAL-SUMMARY"); // still the old snapshot
		expect(secondText).not.toContain("MUTATED-SUMMARY-SHOULD-NOT-APPEAR-FROZEN");

		// Only an explicit invalidate("wiki-system-anchors") — what
		// patch.wikiAnchors triggers at L1247 — refreshes the snapshot.
		assembler.invalidate("wiki-system-anchors");
		const third = await assembler.assemble();
		const thirdText = third[0]?.text ?? "";
		expect(thirdText).not.toBe(secondText); // changed after invalidate
		expect(thirdText).toContain("MUTATED-SUMMARY-SHOULD-NOT-APPEAR-FROZEN");
	});

	// ─── #5 free wikiAnchors:per-anchor inject 原样保留 ─────────────

	test("#5 free wikiAnchors: per-anchor inject:system|context|off preserved + each routes to the right channel", () => {
		// Use THREE separate project subtrees (none collide with the only auto
		// anchor — the per-agent memory root — so dedupeAnchors does not merge
		// them, and each free inject value is preserved verbatim).
		const proj1 = projectStore.create({ name: "CtxProj", workspaceDir: join(tmpDir, "p1") });
		const proj2 = projectStore.create({ name: "SysProj", workspaceDir: join(tmpDir, "p2") });
		const proj3 = projectStore.create({ name: "OffProj", workspaceDir: join(tmpDir, "p3") });
		const r1 = track(wiki.ensureProjectSubtree(proj1.id, "CtxProj"));
		const r2 = track(wiki.ensureProjectSubtree(proj2.id, "SysProj"));
		const r3 = track(wiki.ensureProjectSubtree(proj3.id, "OffProj"));

		// No projectId in contextBundle → only auto memory anchor exists, and
		// none of the three free target nodes equal it → no dedupe collision.
		const freeAnchors: AgentRecord["wikiAnchors"] = [
			{ nodeId: r1.id, inject: "context" },
			{ nodeId: r2.id, inject: "system" },
			{ nodeId: r3.id, inject: "off" },
		];
		const anchors = resolveAnchors({ wiki, agentId: "a1", wikiAnchors: freeAnchors });
		const byId = new Map(anchors.map((a) => [a.nodeId, a]));
		expect(byId.get(r1.id)?.inject).toBe("context");
		expect(byId.get(r2.id)?.inject).toBe("system");
		expect(byId.get(r3.id)?.inject).toBe("off");

		// Per-anchor inject still routes to the right render channel:
		//   context → only renderContextAnchors
		//   system  → only renderSystemAnchors
		//   off     → neither (silent scope anchor)
		const sys = renderSystemAnchors({ wiki, anchors });
		const ctx = renderContextAnchors({ wiki, anchors });
		expect(sys).toContain("SysProj");
		expect(sys).not.toContain("CtxProj");
		expect(sys).not.toContain("OffProj");
		expect(ctx).toContain("CtxProj");
		expect(ctx).not.toContain("SysProj");
		expect(ctx).not.toContain("OffProj");
	});

	// ─── #6 渲染格式不变:root doc + 一层 children summary ──────────

	test("#6 renderAnchorOutline (via renderSystemAnchors) format: header + root doc + children lines", () => {
		const proj = projectStore.create({ name: "PFmt", workspaceDir: join(tmpDir, "pfmt") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "PFmt"));
		// ensureProjectSubtree prefixes title with "Project: " → "Project: PFmt".
		// Root doc — should be injected (capped).
		wiki.update(root.id, { detail: "ROOT-DOC-CONTENT" } as any);
		// One child WITH a grandchild (▾N marker).
		const mod = track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "structure", path: "structure:src",
			title: "src/", summary: "src-summary",
		}));
		track(wiki.upsertProjectNode(proj.id, {
			parentId: mod.id, type: "header", path: "header:src/a.ts",
			title: "a.ts", summary: "should-not-render-at-depth-1",
		}));
		// One leaf child (no children → leaf marker).
		track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id, type: "header", path: "header:leaf.ts",
			title: "leaf.ts", summary: "leaf-summary",
		}));

		const anchors = resolveAnchors({
			wiki, agentId: "a1",
			wikiAnchors: [{ nodeId: root.id, inject: "system" }],
		});
		const out = renderSystemAnchors({ wiki, anchors });
		expect(out).not.toBe("");

		// Header line: `### <title>  #<shortid> (doc <size>)`.
		// Root has a doc → (doc N) where N > 0.
		expect(out).toMatch(/### Project: PFmt  #[0-9a-f]{8} \(doc [0-9.]+[bkmb]+\)/);
		// Root doc line injected (capped).
		expect(out).toContain("ROOT-DOC-CONTENT");
		// src/ has 1 grandchild → ▾1 marker.
		expect(out).toMatch(/src\/ — src-summary \(no doc\) #[0-9a-f]{8} ▾1/);
		// leaf.ts has no children → leaf marker.
		expect(out).toMatch(/leaf\.ts — leaf-summary \(no doc\) #[0-9a-f]{8} leaf/);
		// Depth-2 grandchild (a.ts) NOT rendered at fixed depth=1.
		expect(out).not.toContain("should-not-render-at-depth-1");
		// Full "wiki-root:" id NEVER leaks (only short handles).
		expect(out).not.toContain("wiki-root:");
	});
});
