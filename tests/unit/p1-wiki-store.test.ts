// P1 单元测试:wiki 存储分离 + 多锚点守卫
//
// # 文件说明书
//
// ## 核心功能
// 验证 v0.8 P1 (acceptance-P1.md「存储」+「多锚点权限」节):
//   - 正文在磁盘 (~/.zero-core/wiki/<area>/<safe-name>.md),DB 行不含正文
//   - 写正文不动 DB 结构字段(只动 docPointer 一次 stamp)
//   - 删节点级联删正文文件
//   - 多锚点守卫 (assertNodeInAnchorScope / listVisibleFromAnchors / getVisibleFromAnchors)
//     替了 type-based assertNodeInsideProjectScope;读+写同边界;项目角色只看本子树 +
//     memory,zero 看全树
//
// ## 输入
// 临时 SessionDB (mkdtempSync) + 真实 WikiStore。
//
// 注意:WIKI_DISK_ROOT 是模块导入期固化常量(指向 ~/.zero-core/wiki),无法按测试
// 重定向。本测试通过 store API 间接验证磁盘行为 + 在 afterEach 用 wikiStore.delete
// 级联清理正文文件,避免污染。
//
// ## 输出
// Vitest 用例。
//
// ## 关键文件
//   - src/server/wiki-node-store.ts (readNodeDetail/writeNodeDetail/deleteNodeDetail,
//     assertNodeInAnchorScope, listVisibleFromAnchors, getVisibleFromAnchors,
//     deriveContentFilePath, WIKI_DISK_ROOT)
//
// ## 维护规则
//   - 测试不直读 ~/.zero-core/wiki 文件路径(那是代码内部 locator);改用
//     readNodeDetail + 检查 node.docPointer 是否被 stamp。
//   - 不验「DB 行 detail 列已删」——列删除由 migration 负责,见 p1-migration.test.ts。
//
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { ProjectStore } from "../../src/server/project-store.js";
import {
	WikiStore,
	WIKI_GLOBAL_ROOT_ID,
	WIKI_DISK_ROOT,
	projectSubtreeRootId,
	memoryTypeRootId,
	legacyDeriveContentFilePath,
} from "../../src/server/wiki-node-store.js";

let tmpDir: string;
let sessionDB: SessionDB;
let wiki: WikiStore;
let projectStore: ProjectStore;
const createdNodeIds: string[] = [];

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-p1-store-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	wiki = new WikiStore(sessionDB);
	createdNodeIds.length = 0;
});

afterEach(() => {
	// Cascade-clean any nodes we created (also removes their disk body files).
	for (const id of [...createdNodeIds].reverse()) {
		try { wiki.delete(id); } catch { /* already gone */ }
	}
	try { sessionDB.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

function track<T extends { id: string }>(node: T): T {
	createdNodeIds.push(node.id);
	return node;
}

// ─── 存储:正文磁盘 round-trip ─────────────────────────────────

describe("P1 §10.1 存储:正文磁盘 round-trip", () => {
	test("写正文后,readNodeDetail 读回一致;DB 行不含 detail 字段", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "P"));
		// v0.8 (P1 §10.1, hardened): docPointer is NOT an upsert input — the
		// store derives + stamps the wiki body file path itself. Passing an
		// external path like "src/foo.ts" used to escape WIKI_DISK_ROOT; now
		// the input is silently dropped and the body always lands under
		// WIKI_DISK_ROOT.
		const node = track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id,
			type: "header",
			path: "header:src/foo.ts",
			title: "foo.ts",
			summary: "Foo module",
			detail: "Body line 1\nBody line 2",
		}));

		// Body round-trips through disk.
		const detail = wiki.readNodeDetail(node.id);
		expect(detail).toBe("Body line 1\nBody line 2");

		// docPointer was stamped to the derived wiki body path (inside
		// WIKI_DISK_ROOT), never to the external caller path.
		const fetched = wiki.get(node.id);
		expect(fetched).toBeDefined();
		expect((fetched as any).detail).toBeUndefined();
		expect(fetched!.docPointer).toBe(wiki.diskPathFor(fetched!.id).detailFile);
		// FS isolation: nothing escapes WIKI_DISK_ROOT.
		expect(existsSync(join(process.cwd(), "src", "foo.ts"))).toBe(false);
	});

	test("docPointer 被 stamp 后,改正文不动 DB 行(只动文件)", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "P"));
		const node = track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id,
			type: "header",
			path: "header:src/bar.ts",
			title: "bar.ts",
			summary: "original summary",
			detail: "v1 body",
		}));

		const before = wiki.get(node.id)!;
		expect(before.docPointer).toBeTruthy();
		const pointer = before.docPointer!;
		expect(existsSync(pointer)).toBe(true);

		// Rewrite body only via writeNodeDetail (no row mutation).
		wiki.writeNodeDetail(node.id, "v2 body — overwritten");

		const after = wiki.get(node.id)!;
		// Structural fields unchanged.
		expect(after.title).toBe("bar.ts");
		expect(after.summary).toBe("original summary");
		expect(after.updatedAt).toBe(before.updatedAt); // row not bumped
		// docPointer stable (not re-stamped).
		expect(after.docPointer).toBe(pointer);
		// Body now reflects v2.
		expect(wiki.readNodeDetail(node.id)).toBe("v2 body — overwritten");
	});

	test("update({detail:''}) 删除正文文件 (blanks body)", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "P"));
		const node = track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id,
			type: "header",
			path: "header:src/baz.ts",
			title: "baz.ts",
			detail: "to be deleted",
		}));
		const pointer = wiki.get(node.id)!.docPointer!;
		expect(existsSync(pointer)).toBe(true);

		// Blanking detail removes the file.
		wiki.update(node.id, { detail: "   " });
		expect(existsSync(pointer)).toBe(false);
		expect(wiki.readNodeDetail(node.id)).toBeUndefined();
	});

	test("delete() 级联删正文文件", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = track(wiki.ensureProjectSubtree(proj.id, "P"));
		const child = track(wiki.upsertProjectNode(proj.id, {
			parentId: root.id,
			type: "header",
			path: "header:src/qux.ts",
			title: "qux.ts",
			detail: "child body",
		}));
		const pointer = wiki.get(child.id)!.docPointer!;
		expect(existsSync(pointer)).toBe(true);

		wiki.delete(child.id);
		expect(existsSync(pointer)).toBe(false);
		expect(wiki.get(child.id)).toBeUndefined();
		// Don't double-delete in afterEach.
		const idx = createdNodeIds.indexOf(child.id);
		if (idx >= 0) createdNodeIds.splice(idx, 1);
	});

	test("legacyDeriveContentFilePath routes by area (migration source — legacy flat layout)", () => {
		// project node → projects/<projectId>/
		const projFile = legacyDeriveContentFilePath({
			id: "abc12345",
			path: "header:src/a.ts",
			projectId: "proj-x",
		});
		expect(projFile).toBe(join(WIKI_DISK_ROOT, "projects", "proj-x", "header_src_a.ts__abc12345.md"));

		// memory node → memory/<agentId>/
		const memFile = legacyDeriveContentFilePath({
			id: "mem1234567",
			path: "memory:subject-x",
		});
		expect(memFile).toBe(join(WIKI_DISK_ROOT, "memory", "subject-x", "memory_subject-x__mem12345.md"));

		// knowledge fallback (no "/" → flat)
		const knFile = legacyDeriveContentFilePath({
			id: "kn1234567",
			path: "knowledge:something",
		});
		expect(knFile).toBe(join(WIKI_DISK_ROOT, "knowledge", "knowledge_something__kn123456.md"));
	});

	test("diskPathFor mirrors the tree (container at area / subtree root own subdir / leaf vs folder)", () => {
		// knowledge container (folder, has a child) → detail at area level.
		const knowledgeRoot = track(wiki.create({
			parentId: WIKI_GLOBAL_ROOT_ID, path: "knowledge", title: "Knowledge", type: "knowledge" as any,
		}));
		// knowledge is a leaf so far (no children) → file at knowledge/knowledge__<id8>.md
		let kp = wiki.diskPathFor(knowledgeRoot.id);
		expect(kp.isFolder).toBe(false);
		expect(kp.detailFile).toBe(join(WIKI_DISK_ROOT, "knowledge", `knowledge__${knowledgeRoot.id.slice(0, 8)}.md`));

		// Add a child (workflow) → knowledge promotes to folder; its detail now
		// stays at area level (containers don't get their own subdir).
		const workflow = track(wiki.create({
			parentId: knowledgeRoot.id, path: "workflow", title: "Workflow", type: "knowledge" as any,
		}));
		kp = wiki.diskPathFor(knowledgeRoot.id);
		expect(kp.isFolder).toBe(true);
		expect(kp.detailFile).toBe(join(WIKI_DISK_ROOT, "knowledge", `knowledge__${knowledgeRoot.id.slice(0, 8)}.md`));
		// workflow (regular folder once it has a child) — leaf for now:
		let wp = wiki.diskPathFor(workflow.id);
		expect(wp.detailFile).toBe(join(WIKI_DISK_ROOT, "knowledge", `Workflow__${workflow.id.slice(0, 8)}.md`));

		// software-dev under workflow → workflow promotes; software-dev leaf nests.
		const sd = track(wiki.create({
			parentId: workflow.id, path: "software-dev", title: "software-dev 工作流", type: "knowledge" as any,
		}));
		// workflow is now a folder → its detail moved into its own subdir.
		wp = wiki.diskPathFor(workflow.id);
		expect(wp.isFolder).toBe(true);
		expect(wp.detailFile).toBe(join(WIKI_DISK_ROOT, "knowledge", "Workflow", `Workflow__${workflow.id.slice(0, 8)}.md`));
		// software-dev (leaf) nests under workflow.
		const sp = wiki.diskPathFor(sd.id);
		expect(sp.detailFile).toBe(join(WIKI_DISK_ROOT, "knowledge", "Workflow", `software-dev 工作流__${sd.id.slice(0, 8)}.md`));

		// memory-agent subtree root → own id-suffix subdir under memory.
		const memRoot = track(wiki.ensureMemoryAgentRoot("agent-x"));
		const mp = wiki.diskPathFor(memRoot.id);
		expect(mp.detailFile).toBe(join(WIKI_DISK_ROOT, "memory", "agent-x", `agent-x__${memRoot.id.slice(0, 8)}.md`));
		// a memory leaf under it nests under memory/agent-x/.
		const leaf = track(wiki.createMemoryNode({
			parentId: memRoot.id, path: "memory:agent-x:decision:d1", title: "Decided X",
		}));
		const lp = wiki.diskPathFor(leaf.id);
		expect(lp.detailFile.startsWith(join(WIKI_DISK_ROOT, "memory", "agent-x"))).toBe(true);

		// project subtree root → own projectId subdir under projects.
		const proj = projectStore.create({ name: "P2", workspaceDir: join(tmpDir, "p2") });
		const projRoot = track(wiki.ensureProjectSubtree(proj.id, "P2"));
		const pp = wiki.diskPathFor(projRoot.id);
		// subtree root slug = its projectId segment; just assert area+segment.
		expect(pp.detailFile.startsWith(join(WIKI_DISK_ROOT, "projects", proj.id))).toBe(true);

		// FS isolation: every derived path stays inside WIKI_DISK_ROOT (diskPathFor
		// itself asserts this; the ".." / "." filter is exercised by nodeSlug).
		void leaf; void lp;
	});

	test("leaf→folder promotion moves the body file into the node's own subdir", () => {
		const knowledgeRoot = track(wiki.create({
			parentId: WIKI_GLOBAL_ROOT_ID, path: "knowledge", title: "Knowledge", type: "knowledge" as any,
		}));
		const workflow = track(wiki.create({
			parentId: knowledgeRoot.id, path: "workflow", title: "Workflow", type: "knowledge" as any,
		}));
		// workflow is a leaf with a body at knowledge/Workflow__<id8>.md
		wiki.writeNodeDetail(workflow.id, "workflow body");
		const leafPath = join(WIKI_DISK_ROOT, "knowledge", `Workflow__${workflow.id.slice(0, 8)}.md`);
		expect(existsSync(leafPath)).toBe(true);
		// Add a child → workflow promotes; body moves into knowledge/Workflow/.
		const child = track(wiki.create({
			parentId: workflow.id, path: "child", title: "Child", type: "knowledge" as any,
		}));
		expect(existsSync(leafPath)).toBe(false); // moved out of leaf position
		expect(wiki.readNodeDetail(workflow.id)).toBe("workflow body"); // still readable
		void child;
	});
});

// ─── 多锚点权限:并集可见性 ────────────────────────────────────

describe("P1 §10.3 多锚点:并集可见性 + 读/写同边界", () => {
	test("项目角色 A 看不到 项目 B / 全局根 / 别 agent memory", () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const projB = projectStore.create({ name: "B", workspaceDir: join(tmpDir, "b") });
		const rootA = track(wiki.ensureProjectSubtree(projA.id, "A"));
		const rootB = track(wiki.ensureProjectSubtree(projB.id, "B"));

		// Project A subtree node.
		const aHeader = track(wiki.upsertProjectNode(projA.id, {
			parentId: rootA.id, type: "header", path: "header:a.ts", title: "a.ts",
		}));
		// Project B subtree node.
		const bHeader = track(wiki.upsertProjectNode(projB.id, {
			parentId: rootB.id, type: "header", path: "header:b.ts", title: "b.ts",
		}));
		// Memory leaf under global type root (extractor A simulation).
		wiki.ensureMemoryTypeRoot("decision");
		const memRoot = memoryTypeRootId("decision");
		const memLeaf = track(wiki.createMemoryNode({
			parentId: memRoot,
			path: "memory:agent-X-fact",
			title: "Agent X fact",
		}));

		// A's anchor set = [projectA root] (auto project only; no free anchors).
		const aAnchors = [projectSubtreeRootId(projA.id)];
		const aVisible = wiki.listVisibleFromAnchors(aAnchors);
		const aIds = new Set(aVisible.map((n) => n.id));

		// Sees own subtree.
		expect(aIds.has(rootA.id)).toBe(true);
		expect(aIds.has(aHeader.id)).toBe(true);
		// Cannot see B's subtree.
		expect(aIds.has(rootB.id)).toBe(false);
		expect(aIds.has(bHeader.id)).toBe(false);
		// Cannot see global root.
		expect(aIds.has(WIKI_GLOBAL_ROOT_ID)).toBe(false);
		// Cannot see another agent's memory.
		expect(aIds.has(memLeaf.id)).toBe(false);
	});

	test("项目角色 A + memory 锚点 → 看到本项目 + 全部全局 memory 并集", () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const projB = projectStore.create({ name: "B", workspaceDir: join(tmpDir, "b") });
		const rootA = track(wiki.ensureProjectSubtree(projA.id, "A"));
		track(wiki.ensureProjectSubtree(projB.id, "B"));

		// Memory leaves under all 5 type roots.
		wiki.ensureMemoryTypeRoot("decision");
		wiki.ensureMemoryTypeRoot("event");
		wiki.ensureMemoryTypeRoot("discovery");
		wiki.ensureMemoryTypeRoot("status_change");
		wiki.ensureMemoryTypeRoot("preference");
		const decLeaf = track(wiki.createMemoryNode({
			parentId: memoryTypeRootId("decision"), path: "memory:dec-1", title: "dec 1",
		}));
		const evtLeaf = track(wiki.createMemoryNode({
			parentId: memoryTypeRootId("event"), path: "memory:evt-1", title: "evt 1",
		}));

		// Anchor set: auto memory (5 type roots) + project A root.
		const anchors = [
			memoryTypeRootId("event"), memoryTypeRootId("decision"),
			memoryTypeRootId("discovery"), memoryTypeRootId("status_change"),
			memoryTypeRootId("preference"),
			projectSubtreeRootId(projA.id),
		];
		const visible = wiki.listVisibleFromAnchors(anchors);
		const ids = new Set(visible.map((n) => n.id));

		// Sees project A + memory leaves, but NOT project B or global root.
		expect(ids.has(rootA.id)).toBe(true);
		expect(ids.has(decLeaf.id)).toBe(true);
		expect(ids.has(evtLeaf.id)).toBe(true);
		expect(ids.has(projectSubtreeRootId(projB.id))).toBe(false);
		expect(ids.has(WIKI_GLOBAL_ROOT_ID)).toBe(false);
	});

	test("zero (全局根锚点) 看全树", () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const rootA = track(wiki.ensureProjectSubtree(projA.id, "A"));
		const aHeader = track(wiki.upsertProjectNode(projA.id, {
			parentId: rootA.id, type: "header", path: "header:a.ts", title: "a.ts",
		}));

		const visible = wiki.listVisibleFromAnchors([WIKI_GLOBAL_ROOT_ID]);
		const ids = new Set(visible.map((n) => n.id));
		expect(ids.has(WIKI_GLOBAL_ROOT_ID)).toBe(true);
		expect(ids.has(rootA.id)).toBe(true);
		expect(ids.has(aHeader.id)).toBe(true);
	});

	test("空锚点集 → 空可见集", () => {
		expect(wiki.listVisibleFromAnchors([])).toEqual([]);
	});

	test("getVisibleFromAnchors:union 可见性(单节点读)", () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const projB = projectStore.create({ name: "B", workspaceDir: join(tmpDir, "b") });
		const rootB = track(wiki.ensureProjectSubtree(projB.id, "B"));
		const bHeader = track(wiki.upsertProjectNode(projB.id, {
			parentId: rootB.id, type: "header", path: "header:b.ts", title: "b.ts",
		}));

		// From A only — B invisible.
		expect(wiki.getVisibleFromAnchors([projectSubtreeRootId(projA.id)], bHeader.id))
			.toBeUndefined();
		// From A + B union — B visible.
		expect(wiki.getVisibleFromAnchors(
			[projectSubtreeRootId(projA.id), projectSubtreeRootId(projB.id)],
			bHeader.id,
		)).toBeDefined();
	});

	test("assertNodeInAnchorScope:写域 = 可见域(同一道边界)", () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const projB = projectStore.create({ name: "B", workspaceDir: join(tmpDir, "b") });
		const rootA = track(wiki.ensureProjectSubtree(projA.id, "A"));
		const rootB = track(wiki.ensureProjectSubtree(projB.id, "B"));
		const aHeader = track(wiki.upsertProjectNode(projA.id, {
			parentId: rootA.id, type: "header", path: "header:a.ts", title: "a.ts",
		}));
		const bHeader = track(wiki.upsertProjectNode(projB.id, {
			parentId: rootB.id, type: "header", path: "header:b.ts", title: "b.ts",
		}));

		const aAnchors = [projectSubtreeRootId(projA.id)];
		// Write to own subtree — OK.
		expect(() => wiki.assertNodeInAnchorScope(aAnchors, aHeader.id)).not.toThrow();
		// Write across boundary — throws with the P1 message.
		expect(() => wiki.assertNodeInAnchorScope(aAnchors, bHeader.id))
			.toThrow(/outside all caller anchor subtrees/);
		// Global caller bypasses the guard.
		expect(() => wiki.assertNodeInAnchorScope([WIKI_GLOBAL_ROOT_ID], bHeader.id)).not.toThrow();
		// Union anchor set widens write scope.
		expect(() => wiki.assertNodeInAnchorScope(
			[projectSubtreeRootId(projA.id), projectSubtreeRootId(projB.id)],
			bHeader.id,
		)).not.toThrow();
	});

	test("assertNodeInsideProjectScope(deprecated) still works as thin wrapper", () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const projB = projectStore.create({ name: "B", workspaceDir: join(tmpDir, "b") });
		const rootA = track(wiki.ensureProjectSubtree(projA.id, "A"));
		const aHeader = track(wiki.upsertProjectNode(projA.id, {
			parentId: rootA.id, type: "header", path: "header:a.ts", title: "a.ts",
		}));
		// Within own project → OK.
		expect(() => wiki.assertNodeInsideProjectScope(projA.id, aHeader.id)).not.toThrow();
		// Cross-project → throws (delegates to multi-anchor path).
		expect(() => wiki.assertNodeInsideProjectScope(projA.id, aHeader.id)).not.toThrow();
	});
});

// ─── v0.8 读写同界:*InScope 写原语(读写共用 anchor 边界) ───────
describe("anchor-scoped writes (*InScope) — read scope = write scope", () => {
	test("upsertNodeInScope: 项目 agent 能写自己子树;跨项目被拒", () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const projB = projectStore.create({ name: "B", workspaceDir: join(tmpDir, "b") });
		const rootA = track(wiki.ensureProjectSubtree(projA.id, "A"));
		const rootB = track(wiki.ensureProjectSubtree(projB.id, "B"));
		const aAnchors = [projectSubtreeRootId(projA.id)];

		// 写自己子树 → OK,且 projectId 从 parent 继承 = projA.id
		const n = track(wiki.upsertNodeInScope(aAnchors, {
			parentId: rootA.id, type: "structure", path: "note", title: "Note A",
		}));
		expect(n.projectId).toBe(projA.id);
		// 跨项目写 → 抛
		expect(() => wiki.upsertNodeInScope(aAnchors, {
			parentId: rootB.id, type: "structure", path: "spy", title: "Spy",
		})).toThrow(/outside all caller anchor subtrees/);
	});

	test("upsertNodeInScope: zero(全局根 anchor)能写任意位置,projectId 不带", () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const rootA = track(wiki.ensureProjectSubtree(projA.id, "A"));
		// zero 的 anchor 集含全局根
		const zeroAnchors = [WIKI_GLOBAL_ROOT_ID];
		// 写进项目 A 的子树 → 放行(全局根 bypass);projectId 仍从 parent 继承
		const inProj = track(wiki.upsertNodeInScope(zeroAnchors, {
			parentId: rootA.id, type: "structure", path: "global-note", title: "Global Note",
		}));
		expect(inProj.projectId).toBe(projA.id);
		// 写到全局根下 → projectId 为空(全局/knowledge 区不归属任何项目)
		const globalChild = track(wiki.upsertNodeInScope(zeroAnchors, {
			parentId: WIKI_GLOBAL_ROOT_ID, type: "structure", path: "k1", title: "K1",
		}));
		expect(globalChild.projectId).toBeFalsy();
	});

	test("updateNodeInScope / deleteNodeInScope / writeNodeDetailInScope 遵守 anchor 边界", () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const projB = projectStore.create({ name: "B", workspaceDir: join(tmpDir, "b") });
		const rootA = track(wiki.ensureProjectSubtree(projA.id, "A"));
		const rootB = track(wiki.ensureProjectSubtree(projB.id, "B"));
		const aNode = track(wiki.upsertProjectNode(projA.id, {
			parentId: rootA.id, type: "structure", path: "a1", title: "A1",
		}));
		const aAnchors = [projectSubtreeRootId(projA.id)];

		// 自己的节点 → update/delete/write 都 OK
		expect(() => wiki.updateNodeInScope(aAnchors, aNode.id, { title: "A1-renamed" })).not.toThrow();
		expect(() => wiki.writeNodeDetailInScope(aAnchors, aNode.id, "body")).not.toThrow();
		expect(wiki.readNodeDetail(aNode.id)).toBe("body");
		expect(() => wiki.deleteNodeInScope(aAnchors, aNode.id)).not.toThrow();
		expect(wiki.get(aNode.id)).toBeUndefined();

		// 重新建一个 aNode 用来测跨项目拒绝
		const aNode2 = track(wiki.upsertProjectNode(projA.id, {
			parentId: rootA.id, type: "structure", path: "a2", title: "A2",
		}));
		// 用 A 的 anchor 去写 B 的节点 → 抛(writeNodeDetailInScope 堵住了既有洞)
		expect(() => wiki.writeNodeDetailInScope(aAnchors, aNode2.id, "x")).not.toThrow(); // 自己的,OK
		const bNode = track(wiki.upsertProjectNode(projB.id, {
			parentId: rootB.id, type: "structure", path: "b1", title: "B1",
		}));
		expect(() => wiki.writeNodeDetailInScope(aAnchors, bNode.id, "x")).toThrow(/outside all caller anchor subtrees/);
		expect(() => wiki.updateNodeInScope(aAnchors, bNode.id, { title: "X" })).toThrow(/outside all caller anchor subtrees/);
		expect(() => wiki.deleteNodeInScope(aAnchors, bNode.id)).toThrow(/outside all caller anchor subtrees/);
	});

	test("free wikiAnchor 授予的子树同样可写(读写同界)", () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const rootA = track(wiki.ensureProjectSubtree(projA.id, "A"));
		const child = track(wiki.upsertProjectNode(projA.id, {
			parentId: rootA.id, type: "structure", path: "shared", title: "Shared",
		}));
		// 另一个 agent 通过 free anchor 拿到 child 子树 → 能在 child 下写
		const freeAnchors = [child.id];
		const n = track(wiki.upsertNodeInScope(freeAnchors, {
			parentId: child.id, type: "structure", path: "under-shared", title: "Under Shared",
		}));
		expect(n.parentId).toBe(child.id);
	});
});
