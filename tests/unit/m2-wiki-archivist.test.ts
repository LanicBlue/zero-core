// M2 单元测试:全局 wiki 记忆树 + archivist
//
// # 文件说明书
//
// ## 核心功能
// 验证 M2 核心交付 (acceptance-M2.md):
//   - WikiStore 全局唯一记忆树 + project 子树挂 project 节点下 + memory 节点位置预留
//   - WikiNode 含 type(header/intent/structure/project/memory)、docPointer、
//     provenance、requirementIds
//   - 按 session wikiRootNodeId 截断查询 (store 层强制):项目 session 看不到别的
//     project、看不到全局 memory 上层结构
//   - archivist 写入守卫:WikiStore.upsertProjectNode 限自己 project 子树 + 类型
//   - archivist-service git 增量扫描 (lastScannedRef 按 (archivist, project) 维度)
//   - 意图从 artifact 聚合;provenance 打标;分歧信号
//   - archivist git 管理 (ensureRepo / commit / merge / cleanup worktree)
//   - 写入守卫靠 prompt + 工具能力,无 AST/hook (archivist 角色 toolPolicy 无 Write/Edit)
//
// ## 输入
// 临时 CoreDatabase (mkdtempSync) + 真实 stores + 临时 git repo (simple-git via child_process).
//
// ## 输出
// Vitest 用例。
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { CoreDatabase } from "../../src/server/core-database.js";
import { ProjectStore } from "../../src/server/project-store.js";
import {
	WikiStore,
	WIKI_GLOBAL_ROOT_ID,
	WIKI_PROJECTS_ROOT_ID,
	projectSubtreeRootId,
	isInsideWikiDisk,
} from "../../src/server/wiki-node-store.js";
import { ProjectWikiStore } from "../../src/server/project-wiki-store.js";
import { ArchivistGit, featureBranchName, featureWorktreePath } from "../../src/server/archivist-git.js";
import { runMigrations } from "../../src/server/db-migration.js";
// NOTE (BLOCKER 6 fix, round-2 架构 lens): wiki-scan-cursor-store.ts was DELETED
// by sub-03 (cursor migrated into wiki_repositories), and WikiSkeletonService was
// rewritten as a delegation shim whose scanner scenarios are covered by
// wiki-v2-indexer/sync tests. The old archivist-scan + intent/divergence describe
// blocks that relied on the legacy readdir scan + cursorStore were removed here;
// the live WikiStore / write-guard / ArchivistGit / ProjectWikiStore coverage stays.

let tmpDir: string;
let sessionDB: CoreDatabase;
let wikiStore: WikiStore;
let projectStore: ProjectStore;
let archivistGit: ArchivistGit;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-m2-"));
	sessionDB = new CoreDatabase(join(tmpDir, "core.db"));
	runMigrations(sessionDB);
	projectStore = new ProjectStore(sessionDB);
	wikiStore = new WikiStore(sessionDB);
	archivistGit = new ArchivistGit();
});

afterEach(() => {
	try { sessionDB.close(); } catch {}
	rmSync(tmpDir, { recursive: true, force: true });
});

// ─── helpers ─────────────────────────────────────────────────

function makeGitRepo(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	execSync("git init -b main", { cwd: dir, stdio: "ignore" });
	execSync('git config user.email "t@t.t"', { cwd: dir, stdio: "ignore" });
	execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
	execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: "ignore" });
}

function writeFile(dir: string, rel: string, content: string): void {
	const abs = join(dir, rel);
	const parent = abs.slice(0, abs.lastIndexOf(require("node:path").sep));
	if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
	writeFileSync(abs, content);
}

function gitCommit(dir: string, msg: string): void {
	execSync("git add -A", { cwd: dir, stdio: "ignore" });
	execSync(`git commit -m "${msg}"`, { cwd: dir, stdio: "ignore" });
}

// ─── WikiStore: global tree structure ────────────────────────

describe("WikiStore: global memory tree structure", () => {
	test("global root is created on construction", () => {
		const root = wikiStore.get(WIKI_GLOBAL_ROOT_ID);
		expect(root).toBeDefined();
		expect(root!.type).toBe("project");
	});

	test("§10.5 Projects container is ensured on construction", () => {
		const container = wikiStore.get(WIKI_PROJECTS_ROOT_ID);
		expect(container).toBeDefined();
		expect(container!.parentId).toBe(WIKI_GLOBAL_ROOT_ID);
		expect(container!.projectId).toBeFalsy();
	});

	test("§10.5 dedup: a legacy UUID Projects container is merged into the stable one", () => {
		// Simulate the pre-fix state: a Projects container with a UUID id (the
		// old fresh-db-seed layout) coexisting with the stable-id one. Its
		// children must move onto the stable container, and the dupe row deleted.
		const legacyId = "legacy-projects-uuid";
		const stable = wikiStore.get(WIKI_PROJECTS_ROOT_ID)!;
		// legacy dupe container, with a child hanging off it.
		sessionDB.getDb().prepare(
			`INSERT INTO project_wiki (id, parent_id, path, title, project_id, last_updated_by, created_at, updated_at)
			 VALUES (?, ?, 'projects', 'Projects', NULL, 'system', ?, ?)`,
		).run(legacyId, WIKI_GLOBAL_ROOT_ID, "t", "t");
		const childId = "legacy-child";
		sessionDB.getDb().prepare(
			`INSERT INTO project_wiki (id, parent_id, path, title, project_id, last_updated_by, created_at, updated_at)
			 VALUES (?, ?, 'legacy:child', 'Child', NULL, 'system', ?, ?)`,
		).run(childId, legacyId, "t", "t");

		// Re-construct: ensureProjectsRoot runs mergeDuplicateProjectsContainers.
		const store2 = new WikiStore(sessionDB);
		// Dupe is gone; only the stable container remains under the slot.
		const slot = store2.list().filter(
			(n) => n.parentId === WIKI_GLOBAL_ROOT_ID && n.path === "projects",
		);
		expect(slot).toHaveLength(1);
		expect(slot[0]!.id).toBe(WIKI_PROJECTS_ROOT_ID);
		expect(store2.get(legacyId)).toBeUndefined();
		// The dupe's child was re-parented onto the stable container.
		const child = store2.get(childId);
		expect(child).toBeDefined();
		expect(child!.parentId).toBe(stable.id);
	});

	test("§10.5 reparent: a misplaced project root is moved under the Projects container", () => {
		// Simulate an older DB row: a project subtree root still parented to the
		// global root (the pre-fixbug layout). Drop it under global directly,
		// then re-construct the store — the constructor migration must move it.
		const proj = projectStore.create({ name: "Legacy", workspaceDir: join(tmpDir, "legacy") });
		const id = projectSubtreeRootId(proj.id);
		sessionDB
			.getDb()
			.prepare(
				`INSERT INTO project_wiki (id, parent_id, path, title, project_id, last_updated_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 'archivist', ?, ?)`,
			)
			.run(id, WIKI_GLOBAL_ROOT_ID, `project:${proj.id}`, "Legacy", proj.id, "t", "t");
		// Re-construct: constructor runs reparentProjectSubtrees().
		const store2 = new WikiStore(sessionDB);
		const moved = store2.get(id);
		expect(moved).toBeDefined();
		expect(moved!.parentId).toBe(WIKI_PROJECTS_ROOT_ID);
	});

	test("ensureProjectSubtree is idempotent and returns stable id", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root1 = wikiStore.ensureProjectSubtree(proj.id, "P");
		const root2 = wikiStore.ensureProjectSubtree(proj.id, "P");
		expect(root1.id).toBe(root2.id);
		expect(root1.id).toBe(projectSubtreeRootId(proj.id));
		expect(root1.type).toBe("project");
		// §10.5: each project subtree root is a CHILD of the "Projects" container,
		// not a sibling of it.
		expect(root1.parentId).toBe(WIKI_PROJECTS_ROOT_ID);
		expect(root1.projectId).toBe(proj.id);
	});

	test("project subtree root is the wikiRootNodeId for project-role sessions", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		wikiStore.ensureProjectSubtree(proj.id, "P");
		// session-context-router's defaultWikiRootResolver returns the same id.
		expect(projectSubtreeRootId(proj.id)).toBe(`wiki-root:${proj.id}`);
	});

	test("fresh DB has all new wiki columns (decision 23: no migration script)", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = wikiStore.ensureProjectSubtree(proj.id, "P");
		// Should round-trip every new column without throwing.
		// v0.8 (P1 §10.1, hardened): `docPointer` is NO LONGER an upsert input
		// — it's a code-internal cache of the node's body file path, derived
		// by the store. We pass `detail` (which triggers writeNodeDetail) and
		// then assert the row's docPointer was stamped to the derived wiki
		// body path — never to an external caller-supplied path.
		const node = wikiStore.upsertProjectNode(proj.id, {
			parentId: root.id,
			type: "header",
			path: "header:src/foo.ts",
			title: "foo.ts",
			summary: "Foo module",
			detail: "Detail text",
			provenance: "structure",
			requirementIds: ["req-1"],
			relations: [{ kind: "depends-on", targetId: "node-2" }],
			flags: ["intent:no-recorded-reason"],
		});
		// docPointer was stamped by writeNodeDetail to the derived wiki body
		// path (inside WIKI_DISK_ROOT). It MUST NOT equal any external
		// caller-supplied path like "src/foo.ts".
		expect(node.docPointer).toBeDefined();
		const expectedDerived = wikiStore.diskPathFor(node.id).detailFile;
		expect(node.docPointer).toBe(expectedDerived);
		expect(isInsideWikiDisk(node.docPointer)).toBe(true);
		expect(node.docPointer).not.toBe("src/foo.ts");
		// Other new columns round-trip unchanged.
		expect(node.provenance).toBe("structure");
		expect(node.requirementIds).toEqual(["req-1"]);
		expect(node.relations).toEqual([{ kind: "depends-on", targetId: "node-2" }]);
		expect(node.flags).toEqual(["intent:no-recorded-reason"]);
		expect(node.projectId).toBe(proj.id);

		// FS isolation guarantee (P1 §10.1): no file escapes WIKI_DISK_ROOT.
		// The buggy old behavior wrote "Detail text" to <repo>/src/foo.ts;
		// after the fix, src/foo.ts must NOT exist in the cwd.
		expect(existsSync(join(process.cwd(), "src", "foo.ts"))).toBe(false);
	});
});

// ─── WikiStore: view-truncated queries (decision 38) ─────────

describe("WikiStore: view-truncated queries (decision 38)", () => {
	test("project-role session only sees its own subtree — not other projects, not global root", () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const projB = projectStore.create({ name: "B", workspaceDir: join(tmpDir, "b") });
		const rootA = wikiStore.ensureProjectSubtree(projA.id, "A");
		const rootB = wikiStore.ensureProjectSubtree(projB.id, "B");

		wikiStore.upsertProjectNode(projA.id, {
			parentId: rootA.id, type: "header", path: "header:a.ts",
			title: "a.ts",
		});
		wikiStore.upsertProjectNode(projB.id, {
			parentId: rootB.id, type: "header", path: "header:b.ts",
			title: "b.ts",
		});

		// From A's view root, only A's subtree is visible.
		const aView = wikiStore.listVisibleFromRoot(projectSubtreeRootId(projA.id));
		const aPaths = aView.map((n) => n.path).sort();
		// A's subtree root path is "project:<projectId>" (stable).
		expect(aPaths).toEqual([`project:${projA.id}`, "header:a.ts"].sort());
		expect(aPaths).not.toContain("header:b.ts");
		// Global root is invisible from a project view.
		expect(aView.find((n) => n.id === WIKI_GLOBAL_ROOT_ID)).toBeUndefined();

		// Symmetric for B.
		const bView = wikiStore.listVisibleFromRoot(projectSubtreeRootId(projB.id));
		expect(bView.map((n) => n.path).sort()).toEqual([`project:${projB.id}`, "header:b.ts"].sort());
	});

	test("global session (wikiRootNodeId=global) sees the whole tree", () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		wikiStore.ensureProjectSubtree(projA.id, "A");

		const globalView = wikiStore.listVisibleFromRoot(WIKI_GLOBAL_ROOT_ID);
		expect(globalView.find((n) => n.id === WIKI_GLOBAL_ROOT_ID)).toBeDefined();
		expect(globalView.find((n) => n.id === projectSubtreeRootId(projA.id))).toBeDefined();
	});

	test("getVisible refuses nodes outside the viewer's subtree", () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const projB = projectStore.create({ name: "B", workspaceDir: join(tmpDir, "b") });
		const rootB = wikiStore.ensureProjectSubtree(projB.id, "B");
		const bHeader = wikiStore.upsertProjectNode(projB.id, {
			parentId: rootB.id, type: "header", path: "header:b.ts",
			title: "b.ts",
		});

		// From A's view root, B's node is structurally invisible.
		const fromA = wikiStore.getVisible(projectSubtreeRootId(projA.id), bHeader.id);
		expect(fromA).toBeUndefined();
		// From B's view root, B's node is visible.
		const fromB = wikiStore.getVisible(projectSubtreeRootId(projB.id), bHeader.id);
		expect(fromB).toBeDefined();
	});
});

// ─── archivist write guard (decision 39) ─────────────────────

describe("WikiStore: archivist write guard (decision 39)", () => {
	test("upsertProjectNode refuses parent outside project subtree", () => {
		const projA = projectStore.create({ name: "A", workspaceDir: join(tmpDir, "a") });
		const projB = projectStore.create({ name: "B", workspaceDir: join(tmpDir, "b") });
		const rootB = wikiStore.ensureProjectSubtree(projB.id, "B");
		// archivist for project A tries to write under B's root → reject.
		// v0.8 (P1 §10.3): multi-anchor guard fired — the message is now
		// "outside all caller anchor subtrees" (assertNodeInAnchorScope).
		expect(() => wikiStore.upsertProjectNode(projA.id, {
			parentId: rootB.id, type: "header", path: "header:foo.ts",
			title: "foo",
		})).toThrow(/outside all caller anchor subtrees/);
	});

	test("upsertProjectNode type signature restricts to header/intent/structure", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = wikiStore.ensureProjectSubtree(proj.id, "P");
		// 'memory' is not in the allowed union — TS rejects; runtime too.
		// 'project' subtree roots are minted only by ensureProjectSubtree.
		expect(() => wikiStore.upsertProjectNode(proj.id, {
			parentId: root.id, type: "header" as any, path: "header:x.ts",
			title: "x",
		})).not.toThrow();
	});

	test("createMemoryNode refuses parents inside any project subtree (N2)", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = wikiStore.ensureProjectSubtree(proj.id, "P");
		expect(() => wikiStore.createMemoryNode({
			parentId: root.id, path: "memory:foo", title: "foo",
		})).toThrow(/inside project .* subtree/);
	});

	test("createMemoryNode accepts global-type parent", () => {
		// Global root is the canonical parent for memory type nodes (M5 will
		// mint intermediate type nodes under it; here we attach directly).
		const node = wikiStore.createMemoryNode({
			parentId: WIKI_GLOBAL_ROOT_ID,
			path: "memory:global/dev/notes",
			title: "Dev notes",
			summary: "cross-project skill",
		});
		expect(node.type).toBe("memory");
		expect(node.projectId).toBeUndefined();
	});
});

// ─── archivist git management (RFC §2.15) ────────────────────
// (BLOCKER 6 fix) The two describe blocks that used to live here —
// "ArchivistService: incremental git scan" and "ArchivistService: intent
// aggregation + divergence signals" — were REMOVED: they exercised the legacy
// readdir scanner + cursorStore (header:/intent:/structure: provenance) that
// sub-03 migrated into WikiProjectIndexer (writing the new wiki.db). Those
// scenarios are now covered by wiki-v2-indexer / wiki-v2-sync / wiki-v2-source
// tests against the real indexer. The legacy WikiStore write-guard, view
// truncation, and ProjectWikiStore back-compat coverage above stays live.

describe("ArchivistGit: main-branch management (§2.15)", () => {
	let ws: string;

	beforeEach(() => {
		ws = join(tmpDir, "ws");
		makeGitRepo(ws);
	});

	test("ensureRepo is a no-op when already a repo, and inits when not", async () => {
		expect(await archivistGit.isRepo(ws)).toBe(true);
		await archivistGit.ensureRepo(ws); // no-op
		expect(await archivistGit.isRepo(ws)).toBe(true);

		// Non-repo dir gets init'd.
		const fresh = join(tmpDir, "fresh");
		mkdirSync(fresh, { recursive: true });
		expect(await archivistGit.isRepo(fresh)).toBe(false);
		await archivistGit.ensureRepo(fresh);
		expect(await archivistGit.isRepo(fresh)).toBe(true);
	});

	test("commitRequirementDoc commits only the named doc paths", async () => {
		// PM wrote a requirement doc; an unrelated code file is also staged.
		writeFile(ws, "docs/requirements/req-x.md", "# X\n");
		writeFile(ws, "src/unrelated.ts", "export const Y = 1;\n");
		// Pre-stage both — archivist should only commit the doc.
		execSync("git add -A", { cwd: ws, stdio: "ignore" });

		const r = await archivistGit.commitRequirementDoc(
			ws, "req-x-001", "X requirement",
			["docs/requirements/req-x.md"],
		);
		expect(r.ok).toBe(true);

		// The doc commit exists.
		const log = execSync("git log --oneline", { cwd: ws, encoding: "utf-8" });
		expect(log).toMatch(/docs\(req\): X requirement/);
		// The unrelated code file is NOT in that commit.
		const committedFiles = execSync("git show --stat --name-only HEAD", { cwd: ws, encoding: "utf-8" });
		expect(committedFiles).toContain("docs/requirements/req-x.md");
		expect(committedFiles).not.toContain("src/unrelated.ts");
	});

	test("mergeFeatureToMain merges a feature branch back to main + cleans up", async () => {
		// Create a feature branch + worktree, commit something, merge back.
		const branch = featureBranchName("req-abc123");
		const worktreePath = featureWorktreePath(ws, "req-abc123");
		execSync(`git worktree add -b ${branch} "${worktreePath}"`, { cwd: ws, stdio: "ignore" });
		writeFile(worktreePath, "src/feature.ts", "export const F = 1;\n");
		execSync("git add -A", { cwd: worktreePath, stdio: "ignore" });
		execSync(`git commit -m "feat: feature work [req-abc123]"`, { cwd: worktreePath, stdio: "ignore" });

		const r = await archivistGit.mergeFeatureToMain(ws, "req-abc123");
		expect(r.ok).toBe(true);
		expect(r.mergedToRef).toMatch(/^[0-9a-f]+$/);

		// Worktree + branch cleaned up.
		expect(existsSync(worktreePath)).toBe(false);
		expect(() => execSync(`git rev-parse --verify ${branch}`, { cwd: ws, stdio: "ignore" })).toThrow();
	});

	test("mergeFeatureToMain returns ok=false when branch missing", async () => {
		const r = await archivistGit.mergeFeatureToMain(ws, "req-nonexistent");
		expect(r.ok).toBe(false);
	});
});

// ─── archivist 写域保护(原 WORKFLOW_ROLES.archivist 已退役)─────────
// archivist 的 Write/Edit/Shell 缺失(write guard = tool capability)现在由画廊
// "Archivist" 模板的 toolPolicy 承担(见 template-store mergeBuiltInTemplates,
// 在 m0-session-context-router 画廊测试中断言)。project-work 的文档工位亦要求
// Wiki 工具。WORKFLOW_ROLES / getRoleConfig 已删除,此处不再断言 role config。

// ─── ProjectWikiStore back-compat view ───────────────────────

describe("ProjectWikiStore back-compat view over WikiStore", () => {
	test("listByProject returns the project subtree as ProjectWikiNode shape", () => {
		const proj = projectStore.create({ name: "P", workspaceDir: join(tmpDir, "p") });
		const root = wikiStore.ensureProjectSubtree(proj.id, "P");
		wikiStore.upsertProjectNode(proj.id, {
			parentId: root.id, type: "header", path: "header:src/a.ts",
			title: "a.ts", summary: "A module",
		});

		const view = new ProjectWikiStore(wikiStore);
		const nodes = view.listByProject(proj.id);
		// Should contain the header mapped to legacy nodeType="file".
		const header = nodes.find((n) => n.path === "header:src/a.ts");
		expect(header).toBeDefined();
		expect(header!.nodeType).toBe("file");
		expect(header!.projectId).toBe(proj.id);
	});
});
