// wiki-system-redesign sub-03 acceptance — 规约 lens
// (full mirror correctness + idempotent retry)
//
// # 文件说明书
//
// ## 核心功能
// 行为级验证 acceptance-03 §A(全量镜像)+ §B 幂等重试 + D2/D4 disclosure
// 裁定。本 lens 用 **真实临时 Git 仓库**(`execFileSync("git", literal-argv)`)
// 驱动 `WikiProjectIndexer`(配合真实 `ArchivistGit` plumbing),断言:
//
//   §A 全量镜像:
//     - 每个 tracked file(blobs + symlink + submodule)都有唯一 source-bound 节点。
//     - 推导非空目录存在;无 Git 不存在的平行 features/flows/docs 分支。
//     - untracked + ignored 文件不进 Wiki。
//     - project root / dir / file 节点有非空确定性 summary;Wiki content 不含
//       源码或 README 正文。
//     - source_root 正确裁剪;越界 / 不存在 source_root 被拒绝。
//     - 文件名空格、Unicode、大小写在 canonical path 与 source_path 中保持正确。
//     - symlink(mode 120000):kind=source_symlink;binding.blob_oid = link blob OID;
//       不跟随到磁盘目标。
//     - submodule(mode 160000):kind=source_submodule;不隐式递归。
//
//   §B 幂等(D4 裁定):
//     - 对同一 SHA 重试 sync 两次 → 无新节点、无 revision bump。
//     - 审计行计数验证(implementer 声称写 1 行;实测看是否真为 0,与 §B
//       「不增加 audit 噪声」对照)。
//
//   D2 裁定:目录节点不写 wiki_source_bindings(design §6.1 推导目录 w/o blob)。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + UNIQUE temp wiki.db(vi.hoisted,隔离)。
//   - UNIQUE temp git repo(per-test,真 git plumbing)。
//
// ## 输出
// Vitest 用例。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - Git fixture 用 `execFileSync("git", [...], {cwd})` literal argv,无 shell。
//   - symlink 用 `git update-index --cacheinfo 120000,<oid>,<path>` hand-craft。
//   - submodule 用 `git update-index --cacheinfo 160000,<sha>,<path>` hand-craft。
//   - sessions.db readonly;INTEGER affinity;Windows vitest exit-127 = teardown crash。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-idx-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1"; // MEMORY journal — avoid Windows WAL teardown crash.
	return { UNIQUE_DIR: d };
});

import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiLinkRepository } from "../../src/server/wiki/wiki-link-repository.js";
import { WikiAuditRepository } from "../../src/server/wiki/wiki-audit-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import {
	WikiProjectIndexer,
	type ProjectStoreLike,
} from "../../src/server/wiki/wiki-project-indexer.js";
import { ArchivistGit } from "../../src/server/archivist-git.js";
import { WIKI_ROOT_PATH, joinWikiPath } from "../../src/server/wiki/wiki-path.js";

// ---------------------------------------------------------------------------
// Git fixture helper — literal argv, no shell, core.autocrlf=false.
// ---------------------------------------------------------------------------

/** Run git with literal argv (NO shell). Throws on non-zero exit. */
function git(cwd: string, args: string[], opts?: { input?: string }): string {
	return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.ignorecase=false", ...args], {
		cwd,
		encoding: "utf-8",
		input: opts?.input,
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
	}).toString();
}

/** Write a file under cwd, creating parent dirs. */
function writeRepoFile(repoDir: string, relPath: string, content: string): void {
	const abs = join(repoDir, relPath);
	const parent = join(abs, "..");
	if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

/**
 * Build a tiny "submodule" repo and return its HEAD commit SHA + path.
 * The objects are copied into the main fixture repo via `git fetch`.
 */
function makeSubmoduleRepo(parentTempDir: string): { repoDir: string; headSha: string } {
	const repoDir = mkdtempSync(join(parentTempDir, "zc-submod-"));
	git(repoDir, ["init", "-b", "main"]);
	writeRepoFile(repoDir, "lib.ts", "export const V = 1;\n");
	git(repoDir, ["add", "lib.ts"]);
	setIdentity(repoDir);
	git(repoDir, ["commit", "-m", "submodule init"]);
	const headSha = git(repoDir, ["rev-parse", "HEAD"]).trim();
	return { repoDir, headSha };
}

/** Set a deterministic git identity (no global config assumed). */
function setIdentity(cwd: string): void {
	git(cwd, ["config", "user.name", "Test Bot"]);
	git(cwd, ["config", "user.email", "bot@example.test"]);
}

interface FixtureRepo {
	repoDir: string;
	/** HEAD commit SHA of the initial rich commit (C0). */
	c0Sha: string;
	/** HEAD commit SHA after the second commit (C1 — for idempotent tests). */
	c1Sha: string;
	/** Tracked file paths at C0 (repo-relative, Git `/` separators). */
	trackedFilesC0: string[];
	/** README.md body text (to assert NOT present in Wiki content). */
	readmeBody: string;
	/** Source code body (to assert NOT present in Wiki content). */
	sourceBody: string;
	/** symlink path (repo-relative). */
	symlinkPath: string;
	/** symlink blob OID (the link-target string blob). */
	symlinkBlobOid: string;
	/** submodule path (repo-relative). */
	submodulePath: string;
	/** submodule commit SHA (gitlink target). */
	submoduleSha: string;
	/** untracked file path (never committed → must NOT enter Wiki). */
	untrackedPath: string;
	/** ignored file path (added then gitignored, gitignore committed). */
	ignoredPath: string;
}

/**
 * Build the rich fixture repo.
 *
 * NOTE: ALL tracked files are ROOT-LEVEL (no subdirectories). This is a
 * DELIBERATE design choice to maximize coverage of the tricky path/symlink/
 * submodule/untracked/ignored/Unicode/space/case axes without entangling them
 * with subdir-path semantics. Subdir coverage (depth ≥2) lives in the separate
 * `buildSubdirFixtureRepo` builder + "subdir mirror" describe block below
 * (that block was the round-1 BLOCKER-1 gap — round-1 was root-level only
 * because joinWikiPath crashed on multi-segment paths; now fixed via
 * joinWikiPathMulti, and this fixture remains root-level for the focused
 * edge-case coverage).
 *
 * C0 (initial rich commit, root-level only):
 *   - README.md (README body to verify NOT mirrored into content)
 *   - a.ts (source)
 *   - b.ts (source)
 *   - app.json (config)
 *   - Makefile (no extension)
 *   - CHANGELOG (no extension)
 *   - 数据.ts (Unicode filename)
 *   - hello world.md (space in filename)
 *   - MyComponent.ts (case preservation: capital M, capital C)
 *   - escape (root-level symlink, mode 120000 → ../../etc/passwd)
 *   - libsub (root-level submodule gitlink, mode 160000)
 *   - .gitignore (ignores ignored.txt)
 *   - ignored.txt (gitignored BEFORE commit)
 *   - (untracked: never-added WIP.md)
 *
 * C1 (second commit, a single modify — used for sync C0→C1 + idempotent retry tests):
 *   - modify a.ts
 */
function buildFixtureRepo(parentTempDir: string): FixtureRepo {
	const repoDir = mkdtempSync(join(parentTempDir, "zc-fixture-"));
	git(repoDir, ["init", "-b", "main"]);
	setIdentity(repoDir);

	const readmeBody = "# Demo Project\n\nThis is the README body that must NOT leak into Wiki content.\n";
	const sourceBody = "console.log('this is source code body');\n";

	// ── C0: write root-level files only (subdirs blocked by joinWikiPath bug) ──
	writeRepoFile(repoDir, "README.md", readmeBody);
	writeRepoFile(repoDir, "a.ts", sourceBody);
	writeRepoFile(repoDir, "b.ts", "export const b = 2;\n");
	writeRepoFile(repoDir, "app.json", '{"name":"demo"}\n');
	writeRepoFile(repoDir, "Makefile", "all:\n\techo hi\n");
	writeRepoFile(repoDir, "CHANGELOG", "v0.1.0 initial\n");
	writeRepoFile(repoDir, "数据.ts", "export const 数据 = 1;\n");
	writeRepoFile(repoDir, "hello world.md", "# Hello World Doc\n");
	writeRepoFile(repoDir, "MyComponent.ts", "export const MyComponent = () => {};\n");

	// Ignored file: write content, then gitignore it BEFORE staging.
	writeRepoFile(repoDir, "ignored.txt", "this should be ignored\n");
	writeRepoFile(repoDir, ".gitignore", "ignored.txt\n");

	// Stage everything that should be in C0.
	git(repoDir, ["add", "README.md", "a.ts", "b.ts", "app.json", "Makefile",
		"CHANGELOG", "数据.ts", "hello world.md", "MyComponent.ts", ".gitignore"]);

	// ── symlink (mode 120000) hand-crafted via cacheinfo (ROOT-LEVEL path) ──
	// Blob content = the link target string. Git stores symlinks as blobs whose
	// body is the target path. We do NOT create a real OS symlink.
	const symlinkPath = "escape";
	const symlinkTarget = "../../etc/passwd";
	const symlinkBlobOid = git(repoDir, ["hash-object", "-w", "--stdin"], { input: symlinkTarget }).trim();
	git(repoDir, ["update-index", "--add", "--cacheinfo", `120000,${symlinkBlobOid},${symlinkPath}`]);

	// ── submodule gitlink (mode 160000) hand-crafted via cacheinfo (ROOT-LEVEL) ──
	const { repoDir: subRepoDir, headSha: submoduleSha } = makeSubmoduleRepo(parentTempDir);
	const submodulePath = "libsub";
	// Copy submodule objects into the main repo so the commit SHA resolves.
	git(repoDir, ["fetch", subRepoDir, "HEAD"]);
	git(repoDir, ["update-index", "--add", "--cacheinfo", `160000,${submoduleSha},${submodulePath}`]);

	git(repoDir, ["commit", "-m", "C0: rich initial tree (root-level)"]);
	const c0Sha = git(repoDir, ["rev-parse", "HEAD"]).trim();

	// Tracked files at C0 (authoritative list from `git ls-tree -r -z --name-only`).
	// MUST use -z so non-ASCII paths (数据.ts) come through as raw UTF-8, matching
	// what the indexer's `git ls-tree -r -z` plumbing receives (without -z, git
	// quotepath-escapes them as "\346\225\260...").
	const trackedFilesC0 = git(repoDir, ["ls-tree", "-r", "-z", "--name-only", "HEAD"])
		.split("\0").map((s) => s.trim()).filter(Boolean);

	// Untracked file (never `git add`-ed).
	const untrackedPath = "WIP.md";
	writeRepoFile(repoDir, untrackedPath, "work in progress, never committed\n");

	// ── C1: a modify commit (used for "sync to C1 then retry C1" idempotent tests) ──
	writeRepoFile(repoDir, "a.ts", sourceBody + "// modified in C1\n");
	git(repoDir, ["add", "a.ts"]);
	git(repoDir, ["commit", "-m", "C1: modify a.ts"]);
	const c1Sha = git(repoDir, ["rev-parse", "HEAD"]).trim();

	return {
		repoDir, c0Sha, c1Sha,
		trackedFilesC0,
		readmeBody, sourceBody,
		symlinkPath, symlinkBlobOid,
		submodulePath, submoduleSha,
		untrackedPath,
		ignoredPath: "ignored.txt",
	};
}

// ===========================================================================
// Subdir fixture — multi-layer dirs, files at depth ≥ 2 (round-1 BLOCKER 1 gap)
// ===========================================================================
//
// round-1 only used a root-level fixture (because joinWikiPath crashed on any
// multi-segment path), which HID the subdir bugs. This fixture builds a repo
// that mirrors a real project layout:
//
//   README.md              (root file)
//   src/index.ts           (depth-1 file under src/)
//   src/server/loop.ts     (depth-2 file — the round-1 crash case)
//   src/server/util.ts     (depth-2 sibling — multiple files per dir)
//   src/server/inner/h.ts  (depth-3 file — deeper nesting)
//   config/app.json        (depth-1 file)
//   config/defaults.json   (depth-1 sibling)
//   docs/readme.md         (depth-1 file)
//
// Expected inferred (non-empty) directory nodes after fullIndex:
//   src/, src/server/, src/server/inner/, config/, docs/   (5 dirs)
//
// C1 modifies src/server/loop.ts (depth-2 file) — used to verify sync applies
// changes to subdir files (round-1 BLOCKER 2).

interface FixtureSubdirRepo {
	repoDir: string;
	c0Sha: string;
	c1Sha: string;
	/** Tracked file paths at C0 (repo-relative, Git `/` separators). */
	trackedFilesC0: string[];
	/** Expected inferred directory paths (repo-relative) at C0. */
	expectedDirs: string[];
	/** File modified between C0 → C1 (repo-relative). */
	c1ModifiedFile: string;
}

function buildSubdirFixtureRepo(parentTempDir: string): FixtureSubdirRepo {
	const repoDir = mkdtempSync(join(parentTempDir, "zc-subdir-"));
	git(repoDir, ["init", "-b", "main"]);
	setIdentity(repoDir);

	// C0 — multi-layer tree.
	writeRepoFile(repoDir, "README.md", "# Subdir Demo\n");
	writeRepoFile(repoDir, "src/index.ts", "export * from './server/loop.js';\n");
	writeRepoFile(repoDir, "src/server/loop.ts", "export const loop = 1;\n");
	writeRepoFile(repoDir, "src/server/util.ts", "export const util = 2;\n");
	writeRepoFile(repoDir, "src/server/inner/h.ts", "export const h = 3;\n");
	writeRepoFile(repoDir, "config/app.json", '{"name":"demo"}\n');
	writeRepoFile(repoDir, "config/defaults.json", '{"port":3000}\n');
	writeRepoFile(repoDir, "docs/readme.md", "# Docs\n");

	git(repoDir, ["add", "README.md", "src/index.ts", "src/server/loop.ts",
		"src/server/util.ts", "src/server/inner/h.ts", "config/app.json",
		"config/defaults.json", "docs/readme.md"]);
	git(repoDir, ["commit", "-m", "C0: multi-layer tree"]);
	const c0Sha = git(repoDir, ["rev-parse", "HEAD"]).trim();

	const trackedFilesC0 = git(repoDir, ["ls-tree", "-r", "-z", "--name-only", "HEAD"])
		.split("\0").map((s) => s.trim()).filter(Boolean);

	// C1 — modify a depth-2 file (the round-1 BLOCKER 2 case: sync must apply).
	writeRepoFile(repoDir, "src/server/loop.ts", "export const loop = 1;\n// C1 modify\n");
	git(repoDir, ["add", "src/server/loop.ts"]);
	git(repoDir, ["commit", "-m", "C1: modify depth-2 file"]);
	const c1Sha = git(repoDir, ["rev-parse", "HEAD"]).trim();

	return {
		repoDir, c0Sha, c1Sha,
		trackedFilesC0,
		expectedDirs: [
			"src", "src/server", "src/server/inner",
			"config", "docs",
		],
		c1ModifiedFile: "src/server/loop.ts",
	};
}

// ---------------------------------------------------------------------------
// Indexer harness — fresh wiki.db + real ArchivistGit + ProjectStoreLike mock.
// ---------------------------------------------------------------------------

let _dbCounter = 0;

interface Harness {
	wiki: WikiDatabase;
	nodeRepo: WikiNodeRepository;
	linkRepo: WikiLinkRepository;
	auditRepo: WikiAuditRepository;
	store: WikiRepositoryStore;
	indexer: WikiProjectIndexer;
	projectStore: ProjectStoreLike;
	git: ArchivistGit;
	dispose: () => void;
}

function makeHarness(projectId: string, workspaceDir: string, sourceRoot?: string): Harness {
	_dbCounter += 1;
	const dbPath = join(UNIQUE_DIR, `wiki-idx-${_dbCounter}-${Date.now()}.db`);
	const wiki = new WikiDatabase(dbPath);
	const db = wiki.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const linkRepo = new WikiLinkRepository(db);
	const auditRepo = new WikiAuditRepository(db);
	const store = new WikiRepositoryStore(db);
	const git = new ArchivistGit();
	const projectStore: ProjectStoreLike = {
		get: (id) => (id === projectId ? { id, name: "Demo Project", workspaceDir } : undefined),
		list: () => [{ id: projectId, name: "Demo Project", workspaceDir }],
	};
	const indexer = new WikiProjectIndexer({
		wikiDb: wiki,
		nodeRepo,
		linkRepo,
		auditRepo,
		repositoryStore: store,
		git,
		projectStore,
	});
	return {
		wiki, nodeRepo, linkRepo, auditRepo, store, indexer, projectStore, git,
		dispose: () => { try { wiki.close(); } catch { /* ignore */ } },
	};
}

/** Count audit rows matching an action prefix. */
function countAudit(h: Harness, action: string): number {
	return (h.wiki.getDb()
		.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = ?")
		.get(action) as { n: number }).n;
}

/** All active nodes (any kind) — for "no parallel branches" / summary assertions. */
function allActiveNodes(h: Harness): { path: string; kind: string; name: string; summary: string; content: string }[] {
	return h.wiki.getDb()
		.prepare("SELECT path, kind, name, summary, content FROM wiki_nodes WHERE archived_at IS NULL ORDER BY path ASC")
		.all() as { path: string; kind: string; name: string; summary: string; content: string }[];
}

// ---------------------------------------------------------------------------
// Shared fixture (built once per file; each test gets a fresh harness so wiki.db
// state never bleeds across tests). The git repo is immutable history so sharing
// is safe; only the wiki.db differs per test.
// ---------------------------------------------------------------------------

let FIXTURE: FixtureRepo;
const FIXTURE_TEMP = mkdtempSync(join(tmpdir(), "zc-fixture-root-"));

beforeEach(() => {
	// Rebuild the fixture repo for each test so worktree state is pristine.
	FIXTURE = buildFixtureRepo(FIXTURE_TEMP);
});

afterEach(() => {
	// Best-effort cleanup of the fixture repo dirs (Windows may hold locks).
	try { rmSync(FIXTURE_TEMP, { recursive: true, force: true }); } catch { /* ignore */ }
	try { mkdirSync(FIXTURE_TEMP, { recursive: true }); } catch { /* ignore */ }
});

// ===========================================================================
// §A — Full mirror
// ===========================================================================

describe("§A full mirror — WikiProjectIndexer.fullIndex on real git fixture", () => {
	test("every tracked file has a unique source-bound node; inferred dirs exist; no parallel branches", async () => {
		const h = makeHarness("demo", FIXTURE.repoDir);
		try {
			const res = await h.indexer.fullIndex("demo", { revision: FIXTURE.c0Sha });
			expect(res.ok).toBe(true);
			expect(res.indexedRevision).toBe(FIXTURE.c0Sha);
			expect(res.trackedFiles).toBe(FIXTURE.trackedFilesC0.length);

			// Every tracked file path → exactly one active binding at that source_path.
			const bindings = h.store.sourceBindings.listByRepository(`repo-demo`);
			expect(bindings.length).toBe(FIXTURE.trackedFilesC0.length);

			const bindingPaths = new Set(bindings.map((b) => b.source_path));
			for (const tracked of FIXTURE.trackedFilesC0) {
				expect(bindingPaths.has(tracked)).toBe(true);
			}

			// UNIQUE(repository_id, source_path) — no duplicate source paths.
			const uniquePaths = new Set(bindings.map((b) => b.source_path));
			expect(uniquePaths.size).toBe(bindings.length);

			// Each binding's node exists, is active, and lives under the project subtree.
			const projectPrefix = `${WIKI_ROOT_PATH}/projects/demo`;
			for (const b of bindings) {
				const node = h.nodeRepo.getById(b.node_id);
				expect(node, `node for binding ${b.source_path} must exist`).toBeDefined();
				expect(node!.archived_at).toBeNull();
				expect(node!.path.startsWith(projectPrefix + "/")).toBe(true);
			}

			// Inferred non-empty dirs: this ROOT-LEVEL fixture has no subdirs,
			// so dirSet is empty by construction. The "subdir mirror" describe
			// block below covers the positive case (depth-2 dirs inferred).
			// Here we just assert no spurious dir nodes were created.
			const dirNodes = allActiveNodes(h)
				.filter((n) => n.kind === "directory" && n.path.startsWith(projectPrefix + "/"));
			expect(dirNodes.length).toBe(0); // root-level fixture → no inferred dirs

			// NO parallel branches: every non-fixed-root node must live under
			// wiki-root/projects/demo (the only project). Assert no spurious
			// wiki-root/features, wiki-root/flows, wiki-root/docs, etc.
			const allNodes = allActiveNodes(h);
			const fixedRootPaths = new Set([
				WIKI_ROOT_PATH,
				joinWikiPath(WIKI_ROOT_PATH, "knowledge"),
				joinWikiPath(WIKI_ROOT_PATH, "memory"),
				joinWikiPath(WIKI_ROOT_PATH, "projects"),
			]);
			for (const n of allNodes) {
				if (fixedRootPaths.has(n.path)) continue;
				expect(
					n.path.startsWith(projectPrefix + "/") || n.path === projectPrefix,
					`spurious parallel-branch node outside project subtree: ${n.path}`,
				).toBe(true);
			}
		} finally {
			h.dispose();
		}
	});

	test("untracked and ignored files do NOT enter Wiki", async () => {
		const h = makeHarness("demo", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("demo", { revision: FIXTURE.c0Sha });
			const bindingPaths = new Set(
				h.store.sourceBindings.listByRepository(`repo-demo`).map((b) => b.source_path),
			);
			// Untracked file (never added).
			expect(bindingPaths.has(FIXTURE.untrackedPath)).toBe(false);
			// Ignored file (gitignored before commit).
			expect(bindingPaths.has(FIXTURE.ignoredPath)).toBe(false);
			// No node should be created at those canonical paths either.
			const untrackedNode = h.nodeRepo.getActiveByPath(
				`${WIKI_ROOT_PATH}/projects/demo/${FIXTURE.untrackedPath}`,
			);
			expect(untrackedNode).toBeUndefined();
		} finally {
			h.dispose();
		}
	});

	test("project root / dir / file nodes have NON-EMPTY deterministic summary; content has no source/README body", async () => {
		const h = makeHarness("demo", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("demo", { revision: FIXTURE.c0Sha });
			const projectPrefix = `${WIKI_ROOT_PATH}/projects/demo`;

			// Project root summary non-empty + deterministic shape.
			const projectNode = h.nodeRepo.getActiveByPath(projectPrefix)!;
			expect(projectNode).toBeDefined();
			expect(projectNode.summary.length).toBeGreaterThan(0);
			expect(projectNode.summary).toContain("Demo Project");
			expect(projectNode.summary).toContain(FIXTURE.c0Sha.slice(0, 8));
			// Project root content must NOT contain README body or source body.
			expect(projectNode.content).toBe("");
			expect(projectNode.content).not.toContain(FIXTURE.readmeBody);

			// Directory summary check: this ROOT-LEVEL fixture has no subdirs,
			// so no dir nodes exist here. The "subdir mirror" describe block below
			// verifies directory summaries on inferred dirs.

			// Every source-bound file node: non-empty summary, empty content,
			// and content must NOT leak README body or source code body.
			const fileNodes = allActiveNodes(h).filter(
				(n) => (n.kind === "source_file" || n.kind === "source_symlink" || n.kind === "source_submodule")
					&& n.path.startsWith(projectPrefix + "/"),
			);
			expect(fileNodes.length).toBe(FIXTURE.trackedFilesC0.length);
			for (const f of fileNodes) {
				expect(f.summary.length, `file ${f.path} summary must be non-empty`).toBeGreaterThan(0);
				expect(f.content, `file ${f.path} content must be empty (no body mirror)`).toBe("");
				expect(f.content).not.toContain(FIXTURE.readmeBody);
				expect(f.content).not.toContain(FIXTURE.sourceBody);
			}

			// Specifically the README.md node: summary is a skeleton, NOT the body.
			const readmeNode = h.nodeRepo.getActiveByPath(joinWikiPath(projectPrefix, "README.md"))!;
			expect(readmeNode.summary).not.toContain(FIXTURE.readmeBody);
			expect(readmeNode.summary).toContain("README.md");
			expect(readmeNode.content).toBe("");
		} finally {
			h.dispose();
		}
	});

	test("source_root is correctly stripped; out-of-repo / absolute / `..` source_root rejected", async () => {
		// Fixture with a source_root containing both nested and root-level files.
		// (Round-1 forced this to single-segment post-strip paths to avoid the
		// joinWikiPath multi-segment bug; that bug is now fixed, so we use a
		// nested file to also exercise source_root stripping on depth-2 paths.)
		const subTemp = mkdtempSync(join(tmpdir(), "zc-subroot-"));
		try {
			const repoDir = mkdtempSync(join(subTemp, "repo-"));
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "pkg/inside.ts", "export const a = 1;\n");
			writeRepoFile(repoDir, "outside.ts", "export const c = 3;\n");
			git(repoDir, ["add", "pkg/inside.ts", "outside.ts"]);
			git(repoDir, ["commit", "-m", "subroot fixture"]);
			const sha = git(repoDir, ["rev-parse", "HEAD"]).trim();

			// Bind with explicit source_root="pkg" → only pkg/* enters wiki;
			// outside.ts is excluded (sibling of source_root, not inside it).
			const h2 = makeHarness("sub2", repoDir);
			try {
				const binding = await h2.indexer.ensureBinding("sub2", { sourceRoot: "pkg" });
				expect(binding.bound).toBe(true);
				expect(binding.sourceRoot).toBe("pkg");
				const res = await h2.indexer.fullIndex("sub2", { revision: sha });
				expect(res.ok).toBe(true);

				const bindings = h2.store.sourceBindings.listByRepository(`repo-sub2`);
				const paths = bindings.map((b) => b.source_path);
				// source_root stripped: pkg/inside.ts → inside.ts.
				expect(paths).toContain("inside.ts");
				// outside.ts is OUTSIDE source_root → must NOT appear.
				expect(paths).not.toContain("outside.ts");
			} finally {
				h2.dispose();
			}

			// `..` source_root → correctly rejected (normalize keeps ".." segment).
			const hRel = makeHarness("badrel", repoDir);
			try {
				const escBinding = await hRel.indexer.ensureBinding("badrel", { sourceRoot: "../escape" });
				expect(escBinding.bound).toBe(false);
				expect(escBinding.error).toMatch(/source_root/);
			} finally {
				hRel.dispose();
			}

			// CONCERN 7 (round-1): absolute source_root must be rejected BEFORE
			// normalize (which would strip the leading "/"). Round-1 had the
			// isAbsolute check AFTER normalize, so "/absolute/path" was silently
			// normalized to "absolute/path" and accepted. Round-2 fix: isAbsolute
			// on the RAW input — bound=false + error mentions source_root/absolute.
			const hBad = makeHarness("bad", repoDir);
			try {
				const absBinding = await hBad.indexer.ensureBinding("bad", { sourceRoot: "/absolute/path" });
				expect(absBinding.bound, "absolute source_root must be rejected (CONCERN 7 fix)").toBe(false);
				expect(absBinding.error ?? "").toMatch(/source_root|absolute/i);
				expect(hBad.store.repositories.getByProjectId("bad")).toBeUndefined();
			} finally {
				hBad.dispose();
			}
		} finally {
			try { rmSync(subTemp, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("filenames with spaces, Unicode, and case are preserved in canonical path AND source_path", async () => {
		const h = makeHarness("demo", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("demo", { revision: FIXTURE.c0Sha });

			const bindings = h.store.sourceBindings.listByRepository(`repo-demo`);
			const bySource = new Map(bindings.map((b) => [b.source_path, b]));

			// Unicode filename preserved (root-level).
			expect(bySource.has("数据.ts")).toBe(true);
			const uniNode = h.nodeRepo.getById(bySource.get("数据.ts")!.node_id)!;
			expect(uniNode.path).toBe(`${WIKI_ROOT_PATH}/projects/demo/数据.ts`);
			expect(uniNode.name).toBe("数据.ts");

			// Space filename preserved (root-level).
			expect(bySource.has("hello world.md")).toBe(true);
			const spNode = h.nodeRepo.getById(bySource.get("hello world.md")!.node_id)!;
			expect(spNode.path).toBe(`${WIKI_ROOT_PATH}/projects/demo/hello world.md`);
			expect(spNode.name).toBe("hello world.md");

			// Case preservation: MyComponent.ts keeps capitals (not lowercased).
			expect(bySource.has("MyComponent.ts")).toBe(true);
			const caseNode = h.nodeRepo.getById(bySource.get("MyComponent.ts")!.node_id)!;
			expect(caseNode.name).toBe("MyComponent.ts");
			expect(caseNode.path).toBe(`${WIKI_ROOT_PATH}/projects/demo/MyComponent.ts`);

			// README.md (root) preserves case (capital README).
			expect(bySource.has("README.md")).toBe(true);
		} finally {
			h.dispose();
		}
	});

	test("symlink (mode 120000): kind=source_symlink; blob_oid = link blob; not followed", async () => {
		const h = makeHarness("demo", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("demo", { revision: FIXTURE.c0Sha });

			const binding = h.store.sourceBindings.getBySourcePath(`repo-demo`, FIXTURE.symlinkPath);
			expect(binding, `symlink binding for ${FIXTURE.symlinkPath}`).toBeDefined();
			const node = h.nodeRepo.getById(binding!.node_id)!;

			// Kind + attributes mark symlink (plan-03 §3 symlink handling).
			expect(node.kind).toBe("source_symlink");
			expect(node.summary).toContain("symlink");
			const attrs = JSON.parse(node.attributes_json ?? "{}");
			expect(attrs.is_symlink).toBe(true);
			expect(attrs.source_kind).toBe("symlink");

			// binding.blob_oid = the LINK BLOB oid (the target-string blob),
			// NOT any blob from a followed disk target.
			expect(binding!.blob_oid).toBe(FIXTURE.symlinkBlobOid);
			expect(binding!.source_kind).toBe("symlink");

			// The link target (../../etc/passwd) must NOT have leaked as a node.
			const escapeNode = h.nodeRepo.getActiveByPath(
				`${WIKI_ROOT_PATH}/projects/demo/etc/passwd`,
			);
			expect(escapeNode).toBeUndefined();
			// And the symlink node itself sits at the root-level path "escape".
			expect(node.path).toBe(`${WIKI_ROOT_PATH}/projects/demo/escape`);
		} finally {
			h.dispose();
		}
	});

	test("submodule (mode 160000): kind=source_submodule; not implicitly recursed", async () => {
		const h = makeHarness("demo", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("demo", { revision: FIXTURE.c0Sha });

			const binding = h.store.sourceBindings.getBySourcePath(`repo-demo`, FIXTURE.submodulePath);
			expect(binding, `submodule binding for ${FIXTURE.submodulePath}`).toBeDefined();
			const node = h.nodeRepo.getById(binding!.node_id)!;

			expect(node.kind).toBe("source_submodule");
			const attrs = JSON.parse(node.attributes_json ?? "{}");
			expect(attrs.is_submodule).toBe(true);
			expect(attrs.source_kind).toBe("submodule");
			expect(node.summary).toContain("submodule");

			// Submodule contents (lib.ts inside the submodule repo) must NOT be
			// recursively indexed into the parent project subtree.
			const recursedPath = `${WIKI_ROOT_PATH}/projects/demo/${FIXTURE.submodulePath}/lib.ts`;
			const recursedNode = h.nodeRepo.getActiveByPath(recursedPath);
			expect(recursedNode, `submodule must not be recursed: ${recursedPath}`).toBeUndefined();

			// Count: total tracked-file bindings should still equal git ls-tree count
			// (submodule is ONE gitlink entry, not expanded).
			const bindings = h.store.sourceBindings.listByRepository(`repo-demo`);
			expect(bindings.length).toBe(FIXTURE.trackedFilesC0.length);
		} finally {
			h.dispose();
		}
	});

	test("D2 root-level: leaf nodes have bindings; no dir nodes exist in root-level fixture (positive D2 in subdir block)", async () => {
		const h = makeHarness("demo", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("demo", { revision: FIXTURE.c0Sha });
			const projectPrefix = `${WIKI_ROOT_PATH}/projects/demo`;

			// Root-level fixture → no inferred dirs (no subdirs by construction).
			// The positive D2 assertion (dirs exist + have no binding) is covered
			// in the "subdir mirror — D2 positive" test below. Here we verify the
			// leaf side: every leaf (file/symlink/submodule) node HAS a binding.
			const leafNodes = allActiveNodes(h).filter(
				(n) => n.kind !== "directory"
					&& n.kind !== "project"
					&& n.kind !== "namespace"
					&& n.kind !== "root"
					&& n.path.startsWith(projectPrefix + "/"),
			);
			expect(leafNodes.length).toBe(FIXTURE.trackedFilesC0.length);
			for (const f of leafNodes) {
				const row = h.nodeRepo.getActiveByPath(f.path)!;
				const binding = h.store.sourceBindings.getByNodeId(row.id);
				expect(binding, `leaf node ${f.path} must have a binding`).toBeDefined();
			}

			// And no directory nodes exist under the project subtree (root-level fixture).
			const dirNodes = allActiveNodes(h).filter(
				(n) => n.kind === "directory" && n.path.startsWith(projectPrefix + "/"),
			);
			expect(dirNodes.length).toBe(0);
		} finally {
			h.dispose();
		}
	});
}, 30000);

// ===========================================================================
// Subdirectory indexing (round-1 BLOCKER 1 — FIXED via joinWikiPathMulti)
// ===========================================================================
//
// round-1: `ensureDir`/`ensureDirChain` accumulated `acc = "src/server"` (multi-
// segment) and passed it to `joinWikiPath`, whose `validateWikiName` rejects
// names containing `/` → INVALID_NAME throw → whole fullIndex transaction
// aborted → project left un-indexed. Acceptance-03 §A "所有推导非空目录存在"
// was unreachable for ANY real project (every repo has depth-2+ dirs).
//
// Round-2 fix: new `joinWikiPathMulti(parent, ...segments)` splits each segment
// on `/` and validates each sub-segment, then joins. All call sites in the
// indexer converted. This block re-asserts the post-fix behavior end-to-end
// (this is the round-1 BLOCKER-1 expected-failure test FLIPPED to a positive
// check, plus expanded coverage of the round-1 gap).

describe("§A subdir mirror — fullIndex on a repo with subdirs (round-1 BLOCKER 1 fix)", () => {
	test("fullIndex fully indexes a repo with files in src//config//docs/ (depth ≥2); inferred dirs exist; no crash", async () => {
		const subTemp = mkdtempSync(join(tmpdir(), "zc-subdir-run-"));
		try {
			const fix = buildSubdirFixtureRepo(subTemp);
			const h = makeHarness("subdir", fix.repoDir);
			try {
				// Must not throw INVALID_NAME (or anything else).
				const res = await h.indexer.fullIndex("subdir", { revision: fix.c0Sha });
				expect(res.ok).toBe(true);
				expect(res.indexedRevision).toBe(fix.c0Sha);
				expect(res.trackedFiles).toBe(fix.trackedFilesC0.length);
				expect(res.inferredDirs).toBe(fix.expectedDirs.length);

				// Every tracked file → exactly one active source-bound node.
				const bindings = h.store.sourceBindings.listByRepository(`repo-subdir`);
				expect(bindings.length).toBe(fix.trackedFilesC0.length);
				const bindingPaths = new Set(bindings.map((b) => b.source_path));
				for (const tracked of fix.trackedFilesC0) {
					expect(bindingPaths.has(tracked), `tracked file missing binding: ${tracked}`).toBe(true);
				}

				// UNIQUE(repository_id, source_path) — no duplicate source paths.
				const uniquePaths = new Set(bindings.map((b) => b.source_path));
				expect(uniquePaths.size).toBe(bindings.length);

				// Inferred non-empty dir nodes exist (the round-1 crash site).
				// Each dir becomes a Wiki directory node under the project subtree.
				const projectPrefix = `${WIKI_ROOT_PATH}/projects/subdir`;
				const dirNodes = allActiveNodes(h)
					.filter((n) => n.kind === "directory" && n.path.startsWith(projectPrefix + "/"));
				const dirRelPaths = new Set(dirNodes.map((n) =>
					n.path.slice(projectPrefix.length + 1),
				));
				for (const expected of fix.expectedDirs) {
					expect(
						dirRelPaths.has(expected),
						`expected inferred dir node missing: ${expected} (got: ${[...dirRelPaths].join(", ")})`,
					).toBe(true);
				}
				// No spurious dir nodes.
				expect(dirNodes.length).toBe(fix.expectedDirs.length);

				// Sanity: a depth-3 file (src/server/inner/h.ts) is indexed and its
				// two ancestor dir nodes (src/server, src/server/inner) both exist.
				const deepBinding = h.store.sourceBindings.getBySourcePath(`repo-subdir`, "src/server/inner/h.ts");
				expect(deepBinding, "depth-3 file must get a binding").toBeDefined();
				const deepNode = h.nodeRepo.getById(deepBinding!.node_id)!;
				expect(deepNode.path).toBe(`${projectPrefix}/src/server/inner/h.ts`);
				const innerDir = h.nodeRepo.getActiveByPath(`${projectPrefix}/src/server/inner`);
				expect(innerDir, "depth-2 dir node src/server/inner must exist").toBeDefined();
				expect(innerDir!.kind).toBe("directory");

				// indexed_revision advanced.
				const repoRow = h.store.repositories.getByProjectId("subdir")!;
				expect(repoRow.indexed_revision).toBe(fix.c0Sha);
				expect(repoRow.sync_status).toBe("synced");
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(subTemp, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("subdir fixture: directory nodes have NON-EMPTY deterministic summary; file nodes have empty content (no body mirror)", async () => {
		const subTemp = mkdtempSync(join(tmpdir(), "zc-subdir-sum-"));
		try {
			const fix = buildSubdirFixtureRepo(subTemp);
			const h = makeHarness("subsum", fix.repoDir);
			try {
				await h.indexer.fullIndex("subsum", { revision: fix.c0Sha });
				const projectPrefix = `${WIKI_ROOT_PATH}/projects/subsum`;

				// Directory nodes get deterministic summary mentioning child count.
				const dirNodes = allActiveNodes(h)
					.filter((n) => n.kind === "directory" && n.path.startsWith(projectPrefix + "/"));
				expect(dirNodes.length).toBeGreaterThan(0);
				for (const d of dirNodes) {
					expect(d.summary.length, `dir ${d.path} summary must be non-empty`).toBeGreaterThan(0);
					expect(d.summary).toMatch(/direct children|descendants/);
					// Directory content must be empty (no body mirror).
					expect(d.content).toBe("");
				}

				// File nodes (including depth-2/3 files): non-empty summary, empty content.
				const fileNodes = allActiveNodes(h).filter(
					(n) => n.kind === "source_file"
						&& n.path.startsWith(projectPrefix + "/"),
				);
				expect(fileNodes.length).toBe(fix.trackedFilesC0.length);
				for (const f of fileNodes) {
					expect(f.summary.length, `file ${f.path} summary must be non-empty`).toBeGreaterThan(0);
					expect(f.content, `file ${f.path} content must be empty (no body mirror)`).toBe("");
				}
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(subTemp, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("D2 positive: directory nodes have NO wiki_source_bindings; only file/symlink/submodule leaves do", async () => {
		// D2 (round-1): "目录节点不写 wiki_source_bindings". Round-1 couldn't
		// exercise this positively because no dir nodes were created (BLOCKER 1).
		// Now dirs ARE created — verify the design invariant: dirs have no
		// binding (they have no Git blob), files do.
		const subTemp = mkdtempSync(join(tmpdir(), "zc-subdir-d2-"));
		try {
			const fix = buildSubdirFixtureRepo(subTemp);
			const h = makeHarness("subd2", fix.repoDir);
			try {
				await h.indexer.fullIndex("subd2", { revision: fix.c0Sha });
				const projectPrefix = `${WIKI_ROOT_PATH}/projects/subd2`;

				const dirNodes = allActiveNodes(h)
					.filter((n) => n.kind === "directory" && n.path.startsWith(projectPrefix + "/"));
				expect(dirNodes.length).toBe(fix.expectedDirs.length);

				// Each directory node has NO source_binding.
				for (const d of dirNodes) {
					const row = h.nodeRepo.getActiveByPath(d.path)!;
					const binding = h.store.sourceBindings.getByNodeId(row.id);
					expect(
						binding,
						`dir node ${d.path} must NOT have a source_binding (D2)`,
					).toBeUndefined();
				}

				// Each file leaf HAS a source_binding.
				const fileNodes = allActiveNodes(h).filter(
					(n) => n.kind === "source_file"
						&& n.path.startsWith(projectPrefix + "/"),
				);
				expect(fileNodes.length).toBe(fix.trackedFilesC0.length);
				for (const f of fileNodes) {
					const row = h.nodeRepo.getActiveByPath(f.path)!;
					const binding = h.store.sourceBindings.getByNodeId(row.id);
					expect(binding, `file node ${f.path} must have a source_binding`).toBeDefined();
				}

				// Total binding count equals file count (dirs contribute zero).
				const allBindings = h.store.sourceBindings.listByRepository(`repo-subd2`);
				expect(allBindings.length).toBe(fix.trackedFilesC0.length);
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(subTemp, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("sync C0→C1 applies modify to a depth-2 file (round-1 BLOCKER 2 fix in subdir context)", async () => {
		// Round-1 BLOCKER 2 was fixed at the impl level (--find-renames instead
		// of --no-renames=false). This re-confirms it works for SUBDIR files
		// (depth-2), not just root-level files. The sibling wiki-v2-sync.test.ts
		// covers the broader sync matrix; here we cover the depth-2 case.
		const subTemp = mkdtempSync(join(tmpdir(), "zc-subdir-sync-"));
		try {
			const fix = buildSubdirFixtureRepo(subTemp);
			const h = makeHarness("subsync", fix.repoDir);
			try {
				await h.indexer.fullIndex("subsync", { revision: fix.c0Sha });

				const advance = await h.indexer.sync("subsync", { targetRevision: fix.c1Sha });
				expect(advance.toRevision).toBe(fix.c1Sha);
				expect(advance.syncStatus).toBe("synced");
				expect(advance.stats.modified, "modify diff must apply (BLOCKER 2 fix)").toBe(1);
				expect(advance.changesApplied).toBe(1);

				// Binding for the depth-2 file now points at C1.
				const binding = h.store.sourceBindings.getBySourcePath(`repo-subsync`, fix.c1ModifiedFile)!;
				expect(binding.indexed_revision).toBe(fix.c1Sha);
				const c1Blob = git(fix.repoDir, ["rev-parse", `${fix.c1Sha}:${fix.c1ModifiedFile}`]).trim();
				expect(binding.blob_oid).toBe(c1Blob);
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(subTemp, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
}, 30000);



describe("§B idempotent retry — sync to same SHA produces no node/revision/audit noise", () => {
	test("sync({targetRevision}) to same SHA twice → no new nodes, no revision bump, no audit noise", async () => {
		const h = makeHarness("demo", FIXTURE.repoDir);
		try {
			// First sync: no binding yet → fullIndex path writes nodes + audit.
			// Use explicit targetRevision = C0 so we control the SHA precisely.
			const first = await h.indexer.sync("demo", { targetRevision: FIXTURE.c0Sha });
			expect(first.syncStatus).toBe("synced");
			expect(first.toRevision).toBe(FIXTURE.c0Sha);

			const bindingsAfterFirst = h.store.sourceBindings.listByRepository(`repo-demo`).length;
			const auditAfterFirst = countAudit(h, "index.full");
			const repoRow = h.store.repositories.getByProjectId("demo")!;
			const indexedRevAfterFirst = repoRow.indexed_revision;
			expect(indexedRevAfterFirst).toBe(FIXTURE.c0Sha);

			// Capture per-node revision snapshots after first sync.
			const revisionsAfterFirst = new Map<number, number>();
			for (const n of allActiveNodes(h)) {
				const row = h.nodeRepo.getActiveByPath(n.path)!;
				revisionsAfterFirst.set(row.id, row.revision);
			}

			// Second sync to the SAME SHA → MUST be idempotent no-op.
			const second = await h.indexer.sync("demo", { targetRevision: FIXTURE.c0Sha });
			expect(second.changesApplied).toBe(0);
			expect(second.syncStatus).toBe("synced");
			expect(second.toRevision).toBe(FIXTURE.c0Sha);

			// No new bindings.
			const bindingsAfterSecond = h.store.sourceBindings.listByRepository(`repo-demo`).length;
			expect(bindingsAfterSecond).toBe(bindingsAfterFirst);

			// indexed_revision unchanged.
			const indexedRevAfterSecond = h.store.repositories.getByProjectId("demo")!.indexed_revision;
			expect(indexedRevAfterSecond).toBe(indexedRevAfterFirst);

			// No revision bump on any node.
			for (const n of allActiveNodes(h)) {
				const row = h.nodeRepo.getActiveByPath(n.path)!;
				expect(
					row.revision,
					`node ${n.path} revision must not bump on idempotent retry`,
				).toBe(revisionsAfterFirst.get(row.id));
			}

			// D4 adjudication: audit noise on no-op retry.
			// plan-03 §B requires "不增加...audit 噪声". The implementer disclosure D4
			// claims "writes ONE audit row". Verify the ACTUAL behavior: the early-return
			// path writes ZERO audit rows (better than the disclosure).
			const auditAfterSecond = countAudit(h, "index.full");
			expect(auditAfterSecond, "idempotent retry must NOT add index.full audit rows").toBe(auditAfterFirst);
			// Also no new index.sync audit (early-return path doesn't reach the sync audit).
			const syncAudit = countAudit(h, "index.sync");
			expect(syncAudit, "idempotent no-op retry must not write index.sync audit").toBe(0);
		} finally {
			h.dispose();
		}
	});

	test("sync C0→C1 applies the modify diff (round-1 BLOCKER 2 — FIXED via --find-renames)", async () => {
		// Round-1: diffNameStatus used `--no-renames=false` which is INVALID git
		// syntax → git stderr + empty stdout → catch returned [] → zero changes
		// applied, yet indexed_revision silently advanced to C1 → permanent
		// staleness (retry to C1 saw from===new → no-op → never recovered).
		//
		// Round-2 fix: `--find-renames` (long form of default `-M`). Now the
		// modify entry comes through and applyDiffAtomically applies it.
		const h = makeHarness("demo", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("demo", { revision: FIXTURE.c0Sha });

			// Sanity: the raw git diff (correct args) reports the modify.
			const rawDiff = git(FIXTURE.repoDir,
				["diff", "--name-status", "-z", "--find-renames", FIXTURE.c0Sha, FIXTURE.c1Sha]);
			expect(rawDiff.length).toBeGreaterThan(0);

			// Advance C0→C1 via sync — modify must apply.
			const advance = await h.indexer.sync("demo", { targetRevision: FIXTURE.c1Sha });
			expect(advance.toRevision).toBe(FIXTURE.c1Sha);
			expect(advance.syncStatus).toBe("synced");
			expect(advance.stats.modified, "modify diff must apply (BLOCKER 2 fix)").toBe(1);
			expect(advance.changesApplied).toBe(1);

			// Binding for a.ts now points at C1.
			const aBinding = h.store.sourceBindings.getBySourcePath(`repo-demo`, "a.ts")!;
			expect(aBinding.indexed_revision).toBe(FIXTURE.c1Sha);
			const c1Blob = git(FIXTURE.repoDir, ["rev-parse", `${FIXTURE.c1Sha}:a.ts`]).trim();
			expect(aBinding.blob_oid).toBe(c1Blob);

			// Repository row advanced.
			const repoRow = h.store.repositories.getByProjectId("demo")!;
			expect(repoRow.indexed_revision).toBe(FIXTURE.c1Sha);
			expect(repoRow.sync_status).toBe("synced");

			// Retry to C1 → idempotent no-op (from===new).
			const retry = await h.indexer.sync("demo", { targetRevision: FIXTURE.c1Sha });
			expect(retry.changesApplied).toBe(0);
			const aBinding2 = h.store.sourceBindings.getBySourcePath(`repo-demo`, "a.ts")!;
			expect(aBinding2.indexed_revision).toBe(FIXTURE.c1Sha);
		} finally {
			h.dispose();
		}
	});

	test("idempotent retry to already-indexed SHA via fullIndex+sync({same SHA}): D4 audit adjudication", async () => {
		// Adjudicate D4: "Idempotent retry to same SHA writes ONE audit row".
		// Reality: the early-return path in sync() (fromRevision === newRevision)
		// writes ZERO audit rows — better than the disclosure. §B "不增加 audit
		// 噪声" is satisfied (zero noise, not one).
		const h = makeHarness("demo", FIXTURE.repoDir);
		try {
			// First: fullIndex to C0 (writes 1 index.full + 1 repository.bind audit).
			await h.indexer.fullIndex("demo", { revision: FIXTURE.c0Sha });
			const auditFullAfterFirst = countAudit(h, "index.full");
			const auditSyncAfterFirst = countAudit(h, "index.sync");
			expect(auditFullAfterFirst).toBe(1);

			// Retry: sync({targetRevision: C0}) — fromRevision === newRevision === C0.
			const retry = await h.indexer.sync("demo", { targetRevision: FIXTURE.c0Sha });
			expect(retry.changesApplied).toBe(0);
			expect(retry.toRevision).toBe(FIXTURE.c0Sha);

			// D4: ZERO new audit rows (not one). The implementer's disclosure is
			// inaccurate but the behavior is correct (§B-compliant).
			expect(countAudit(h, "index.full"), "no new index.full on no-op retry").toBe(auditFullAfterFirst);
			expect(countAudit(h, "index.sync"), "no index.sync on no-op retry").toBe(auditSyncAfterFirst);
		} finally {
			h.dispose();
		}
	});

	test("rebuildFromScratch preserves canonical tree shape (re-indexes at HEAD)", async () => {
		const h = makeHarness("demo", FIXTURE.repoDir);
		try {
			await h.indexer.fullIndex("demo", { revision: FIXTURE.c0Sha });
			const bindingsBefore = h.store.sourceBindings.listByRepository(`repo-demo`)
				.map((b) => b.source_path).sort();

			// Rebuild from scratch — re-indexes at HEAD (which is C1 in this fixture).
			const rebuild = await h.indexer.rebuildFromScratch("demo");
			expect(rebuild.ok).toBe(true);
			// HEAD (main) = C1; rebuild resolves HEAD when no revision given.
			expect(rebuild.indexedRevision).toBe(FIXTURE.c1Sha);

			const bindingsAfter = h.store.sourceBindings.listByRepository(`repo-demo`)
				.map((b) => b.source_path).sort();
			expect(bindingsAfter).toEqual(bindingsBefore);
		} finally {
			h.dispose();
		}
	});
}, 30000);

// ===========================================================================
// §A negative — out-of-repo / nonexistent source_root
// ===========================================================================

describe("§A source_root rejection — nonexistent workspace is not a Git repo", () => {
	test("ensureBinding fails when workspaceDir is not a Git repository", async () => {
		const notARepo = mkdtempSync(join(tmpdir(), "zc-notrepo-"));
		try {
			const h = makeHarness("norepo", notARepo);
			try {
				const binding = await h.indexer.ensureBinding("norepo");
				expect(binding.bound).toBe(false);
				expect(binding.error).toMatch(/not a Git repository|Git repository/i);
				expect(h.store.repositories.getByProjectId("norepo")).toBeUndefined();
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(notARepo, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
}, 30000);
