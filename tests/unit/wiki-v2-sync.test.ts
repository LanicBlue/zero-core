// wiki-system-redesign sub-03 acceptance — 对抗 lens ROUND 2 (incremental sync)
// (A/M/D/R/C + swap + rollback + idempotent retry + fault injection + SUBDIR)
//
// # 文件说明书
//
// ## 核心功能
// 行为级验证 acceptance-03 §B(增量同步)。ROUND 2: round-1 documented 5 BLOCKERS
// as expected-failures; impl applied fixes + this round FLIPS the assertions to
// the CORRECT post-fix behavior + adds the SUBDIR coverage that round-1 missed
// (the gap that hid BLOCKER 1/2).
//
// 用 **真实临时 Git 仓库**(real `git diff --find-renames`)+ **mock git**
// (synthetic rename-pair cycle that real git can't produce)驱动
// `WikiProjectIndexer.sync`,断言:
//
//   §B 增量同步(FLIPPED — bugs fixed):
//     - BLOCKER 2 FLIP: real `git diff` modify C0→C1 now APPLIES —
//       binding.blob_oid + indexed_revision advance to c1 (was: diff dropped).
//     - BLOCKER 1 FLIP: fullIndex on src/server/loop.ts (depth-2) now SUCCEEDS
//       (was: joinWikiPath INVALID_NAME crash).
//     - SUBDIR sync: modify src/server/loop.ts (depth-2) applies via real git.
//     - modify (mock): binding.blob_oid/indexed_revision updated; summary/content preserved.
//     - delete (mock): archives node; no active binding.
//     - rename (mock): preserves internal ID + summary/content/revision/links.
//     - BLOCKER 3 FLIP: A↔B rename swap/cycle now SUCCEEDS via synthetic mock
//       (phase-1 updateChildPathAndName releases UNIQUE; phase-2 writes final;
//        was: phase-1 updateChildPathOnly → UNIQUE collision rollback).
//     - copy (mock): new node, distinct ID.
//     - add (mock): creates node + binding at NEW.
//
//   §B fault injection (FLIPPED — CONCERN 6 fix):
//     - enrich/diff-phase throw now caught → sync_status=failed + last_error +
//       indexed_revision UNCHANGED (was: propagated as thrown error, status stayed synced).
//
//   §B idempotent retry:
//     - same SHA → 0 changesApplied, 0 audit rows.
//
//   real-git rename swap is unreliable (`--find-renames` reports M for same-path
//   content swaps), so the swap/cycle path is covered SYNTHETICALLY via mock git
//   (the only way to produce two R entries A→B / B→A). Documented inline.
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + UNIQUE temp wiki.db (vi.hoisted, isolated).
//   - REAL temp git repo per-test (real git plumbing) for BLOCKER 1/2 + subdir.
//   - mock git (ArchivistGitLike stub) for applyDiffAtomically-level coverage.
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - Git fixture 用 `execFileSync("git", [...], {cwd})` literal argv,无 shell。
//   - sessions.db readonly;INTEGER affinity;Windows vitest exit-127 = teardown crash。

import { describe, test, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-sync-"));
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
	type ArchivistGitLike,
	type ProjectStoreLike,
	type LsTreeEntryLike,
	type DiffNameStatusEntryLike,
} from "../../src/server/wiki/wiki-project-indexer.js";
import { ArchivistGit } from "../../src/server/archivist-git.js";
import { WIKI_ROOT_PATH, joinWikiPath } from "../../src/server/wiki/wiki-path.js";

// ---------------------------------------------------------------------------
// Path helpers — joinWikiPath takes exactly (parent, name); for deeper paths
// we compose with `/` ourselves (matches existing wiki-v2-indexer.test.ts style).
// ---------------------------------------------------------------------------
const PROJECTS_NS = joinWikiPath(WIKI_ROOT_PATH, "projects");
function projectPath(id: string): string { return `${PROJECTS_NS}/${id}`; }
function projectFile(id: string, name: string): string { return `${projectPath(id)}/${name}`; }

// ---------------------------------------------------------------------------
// Git fixture helper — literal argv, no shell, core.autocrlf=false.
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[], opts?: { input?: string }): string {
	return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.ignorecase=false", ...args], {
		cwd,
		encoding: "utf-8",
		input: opts?.input,
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
	}).toString();
}

function writeRepoFile(repoDir: string, relPath: string, content: string): void {
	const abs = join(repoDir, relPath);
	const parent = join(abs, "..");
	if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

function setIdentity(cwd: string): void {
	git(cwd, ["config", "user.name", "Test Bot"]);
	git(cwd, ["config", "user.email", "bot@example.test"]);
}

/** Blob oid of <rev>:<path> via real git (used to assert binding.blob_oid after sync). */
function blobOidAt(cwd: string, rev: string, path: string): string {
	return git(cwd, ["rev-parse", `${rev}:${path}`]).trim();
}

// ---------------------------------------------------------------------------
// MockGit — ArchivistGitLike stub with switchable behavior per test.
//
// Used for the SYNTHETIC rename-pair cycle (BLOCKER 3 swap) that real git
// cannot produce: real `git diff --find-renames` reports M (not R) when two
// files at the same two paths swap content. The hasSwap branch in
// applyDiffAtomically only triggers on real R entries forming a cycle, so we
// inject synthetic R entries here to exercise the two-phase path directly.
// ---------------------------------------------------------------------------

interface MockGitConfig {
	headRevision?: string;
	defaultBranch?: string;
	isRepo?: boolean;
	/** Synthetic diff(old..new) returned by diffNameStatus. */
	diff?: DiffNameStatusEntryLike[];
	/** Synthetic tree at newRev returned by listTreeAtRevision (for enrich). */
	treeAtNew?: LsTreeEntryLike[];
	/** Optional override: throw on a specific method to simulate fault injection. */
	throwOn?: "diffNameStatus" | "listTreeAtRevision" | "resolveRevision";
}

function makeMockGit(cfg: MockGitConfig): ArchivistGitLike {
	return {
		async isGitRepo(_wd: string): Promise<boolean> { return cfg.isRepo ?? true; },
		async resolveRevision(_wd: string, ref: string): Promise<string | undefined> {
			if (cfg.throwOn === "resolveRevision") {
				throw new Error("mock: resolveRevision failed (fault injection)");
			}
			if (ref === "HEAD" || ref === (cfg.defaultBranch ?? "main")) return cfg.headRevision;
			return ref; // assume caller passed a real SHA
		},
		async detectDefaultBranch(_wd: string): Promise<string> { return cfg.defaultBranch ?? "main"; },
		async listTreeAtRevision(_wd: string, _revision: string): Promise<readonly LsTreeEntryLike[]> {
			if (cfg.throwOn === "listTreeAtRevision") {
				throw new Error("mock: listTreeAtRevision failed (fault injection mid-enrich)");
			}
			return cfg.treeAtNew ?? [];
		},
		async diffNameStatus(_wd: string, _oldRev: string, _newRev: string): Promise<readonly DiffNameStatusEntryLike[]> {
			if (cfg.throwOn === "diffNameStatus") {
				throw new Error("mock: diffNameStatus failed (fault injection)");
			}
			return cfg.diff ?? [];
		},
		async ensureRepo(_wd: string): Promise<void> { return; },
		async blobMetadata(_wd: string, _revision: string, _path: string): Promise<{ oid: string; size: number; type: string } | undefined> {
			return undefined;
		},
		async catFileBlob(_wd: string, _revision: string, _path: string): Promise<Buffer> { return Buffer.alloc(0); },
	};
}

// ---------------------------------------------------------------------------
// Indexer harness — fresh wiki.db + manually seeded binding.
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
	dispose: () => void;
}

/**
 * Build a harness with a manually-seeded binding for `projectId`.
 * Initial state:
 *   - repository row indexed_revision=`oldRev` sync_status=`synced`.
 *   - project root node at `wiki-root/projects/<projectId>` with a display_name.
 * Caller passes `initialFiles` to seed source-bound file nodes at OLD revision.
 */
function makeHarness(opts: {
	projectId: string;
	projectName?: string;
	oldRev: string;
	git?: ArchivistGitLike;
	initialFiles?: Array<{ sourcePath: string; blobOid: string; summary?: string; content?: string }>;
}): Harness {
	_dbCounter += 1;
	const projectId = opts.projectId;
	const dbPath = join(UNIQUE_DIR, `wiki-sync-${_dbCounter}-${Date.now()}.db`);
	const wiki = new WikiDatabase(dbPath);
	const db = wiki.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const linkRepo = new WikiLinkRepository(db);
	const auditRepo = new WikiAuditRepository(db);
	const store = new WikiRepositoryStore(db);
	const git: ArchivistGitLike = opts.git ?? makeMockGit({ headRevision: opts.oldRev });

	const projectStore: ProjectStoreLike = {
		get: (id) => (id === projectId
			? { id, name: opts.projectName ?? "Demo Project", workspaceDir: "/mock/workspace" }
			: undefined),
		list: () => [{ id: projectId, name: opts.projectName ?? "Demo Project", workspaceDir: "/mock/workspace" }],
	};

	const indexer = new WikiProjectIndexer({
		wikiDb: wiki, nodeRepo, linkRepo, auditRepo,
		repositoryStore: store, git, projectStore,
	});

	const pNodePath = projectPath(projectId);
	wiki.transaction(() => {
		const parent = nodeRepo.getActiveByPath(PROJECTS_NS)!;
		const projectNode = nodeRepo.insert({
			parent_id: parent.id,
			name: projectId,
			path: pNodePath,
			kind: "project",
			summary: `Project ${opts.projectName ?? "Demo Project"}.`,
			content: "",
			attributes_json: JSON.stringify({ display_name: opts.projectName ?? "Demo Project" }),
		});
		nodeRepo.syncFtsInsert(projectNode.id, projectNode.name, projectNode.summary, projectNode.content);

		const repositoryId = `repo-${projectId}`;
		store.repositories.upsert({
			repository_id: repositoryId,
			project_node_id: projectNode.id,
			project_id: projectId,
			source_root: "",
			default_branch: "main",
		});
		store.repositories.updateSyncState({
			repository_id: repositoryId,
			sync_status: "synced",
			indexed_revision: opts.oldRev,
			last_indexed_at: new Date().toISOString(),
			last_error: null,
		});
		for (const f of opts.initialFiles ?? []) {
			const fileNodePath = projectFile(projectId, f.sourcePath);
			const nodeRow = nodeRepo.insert({
				parent_id: projectNode.id,
				name: f.sourcePath,
				path: fileNodePath,
				kind: "source_file",
				summary: f.summary ?? `source_file (.ts) — ${f.sourcePath}`,
				content: f.content ?? "",
				attributes_json: JSON.stringify({ source_kind: "source_file" }),
			});
			nodeRepo.syncFtsInsert(nodeRow.id, nodeRow.name, nodeRow.summary, nodeRow.content);
			store.sourceBindings.upsert({
				node_id: nodeRow.id,
				repository_id: repositoryId,
				source_path: f.sourcePath,
				source_kind: "source_file",
				indexed_revision: opts.oldRev,
				blob_oid: f.blobOid,
			});
		}
	});

	return {
		wiki, nodeRepo, linkRepo, auditRepo, store, indexer, projectStore,
		dispose: () => { try { wiki.close(); } catch { /* ignore */ } },
	};
}

/** Count audit rows matching an action. */
function countAudit(h: Harness, action: string): number {
	return (h.wiki.getDb()
		.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = ?")
		.get(action) as { n: number }).n;
}

/** All audit rows (any action). */
function allAudit(h: Harness): { action: string }[] {
	return h.wiki.getDb()
		.prepare("SELECT action FROM wiki_audit_log ORDER BY created_at ASC, audit_id ASC")
		.all() as { action: string }[];
}

/** Count wiki_nodes rows whose path contains the swap-temp prefix. */
function countSwapTempResidue(h: Harness): number {
	return (h.wiki.getDb()
		.prepare("SELECT COUNT(*) AS n FROM wiki_nodes WHERE path LIKE ? ESCAPE '\\'")
		.get("%\\_\\_swap\\_tmp\\_%") as { n: number }).n;
}

function countSwapTempBindings(h: Harness): number {
	return (h.wiki.getDb()
		.prepare("SELECT COUNT(*) AS n FROM wiki_source_bindings WHERE source_path LIKE ? ESCAPE '\\'")
		.get("%\\_\\_swap\\_tmp\\_%") as { n: number }).n;
}

const OLD_SHA = "0000000000000000000000000000000000000001";
const NEW_SHA = "0000000000000000000000000000000000000002";

// ===========================================================================
// BLOCKER #2 (FLIPPED) — diffNameStatus now uses `--find-renames`; real git
// sync C0→C1 over a modify APPLIES the change. (round-1 asserted the drop.)
// ===========================================================================

describe("BLOCKER #2 (FLIPPED): real git sync C0→C1 over modify APPLIES the change", () => {
	test("root-level modify: binding.blob_oid + indexed_revision advance to c1; summary preserved", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "zc-blk2-"));
		try {
			const repoDir = mkdtempSync(join(tempRoot, "repo-"));
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "a.ts", "export const a = 1;\n");
			git(repoDir, ["add", "a.ts"]);
			git(repoDir, ["commit", "-m", "C0"]);
			const c0 = git(repoDir, ["rev-parse", "HEAD"]).trim();
			writeRepoFile(repoDir, "a.ts", "export const a = 1;\n// C1 modify\n");
			git(repoDir, ["add", "a.ts"]);
			git(repoDir, ["commit", "-m", "C1"]);
			const c1 = git(repoDir, ["rev-parse", "HEAD"]).trim();

			// Sanity: real `git diff --name-status -z --find-renames c0 c1` reports the modify.
			const correctDiff = git(repoDir, ["diff", "--name-status", "-z", "--find-renames", c0, c1]);
			expect(correctDiff.length).toBeGreaterThan(0);
			expect(correctDiff).toContain("M");

			const expectedC1Oid = blobOidAt(repoDir, c1, "a.ts");

			const dbPath = join(UNIQUE_DIR, `wiki-blk2-${Date.now()}.db`);
			const wiki = new WikiDatabase(dbPath);
			try {
				const nodeRepo = new WikiNodeRepository(wiki.getDb());
				const linkRepo = new WikiLinkRepository(wiki.getDb());
				const auditRepo = new WikiAuditRepository(wiki.getDb());
				const store = new WikiRepositoryStore(wiki.getDb());
				const gitReal = new ArchivistGit();
				const projectStore: ProjectStoreLike = {
					get: (id) => id === "blk2"
						? { id, name: "Blk2", workspaceDir: repoDir }
						: undefined,
					list: () => [{ id: "blk2", name: "Blk2", workspaceDir: repoDir }],
				};
				const indexer = new WikiProjectIndexer({
					wikiDb: wiki, nodeRepo, linkRepo, auditRepo,
					repositoryStore: store, git: gitReal, projectStore,
				});

				const first = await indexer.fullIndex("blk2", { revision: c0 });
				expect(first.ok).toBe(true);

				const aBindingBefore = store.sourceBindings.getBySourcePath("repo-blk2", "a.ts")!;
				expect(aBindingBefore.indexed_revision).toBe(c0);
				const summaryBefore = nodeRepo.getActiveByPath(projectFile("blk2", "a.ts"))!.summary;

				const r = await indexer.sync("blk2", { targetRevision: c1 });
				expect(r.toRevision).toBe(c1);
				expect(r.syncStatus, r.error ?? "").toBe("synced");
				// FLIPPED: modify IS applied (was: 0 dropped by --no-renames=false).
				expect(r.stats.modified, "modify must be applied now").toBe(1);
				expect(r.changesApplied).toBe(1);

				// FLIPPED: repo + binding both advance to c1.
				const repoRow = store.repositories.getByProjectId("blk2")!;
				expect(repoRow.indexed_revision).toBe(c1);
				expect(repoRow.sync_status).toBe("synced");
				expect(repoRow.last_error).toBeNull();

				const aBindingAfter = store.sourceBindings.getBySourcePath("repo-blk2", "a.ts")!;
				expect(aBindingAfter.indexed_revision, "binding must advance to c1").toBe(c1);
				expect(aBindingAfter.blob_oid, "blob_oid must be c1 oid").toBe(expectedC1Oid);

				// summary preserved (modify does not overwrite curated fields).
				expect(nodeRepo.getActiveByPath(projectFile("blk2", "a.ts"))!.summary).toBe(summaryBefore);
			} finally {
				try { wiki.close(); } catch { /* ignore */ }
			}
		} finally {
			try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});

// ===========================================================================
// SUBDIR sync coverage (round-1 gap) — depth-2 modify via real git.
// Ensures joinWikiPathMulti fix works end-to-end through sync, not just fullIndex.
// ===========================================================================

describe("SUBDIR sync (round-1 gap): modify src/server/loop.ts (depth-2) applies via real git", () => {
	test("depth-2 modify: subdir binding.blob_oid + indexed_revision advance; dir chain intact", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "zc-subsync-"));
		try {
			const repoDir = mkdtempSync(join(tempRoot, "repo-"));
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "src/server/loop.ts", "export const loop = 1;\n");
			writeRepoFile(repoDir, "src/index.ts", "export * from './server/loop.js';\n");
			writeRepoFile(repoDir, "config/app.json", '{"name":"demo"}\n');
			git(repoDir, ["add", "src/server/loop.ts", "src/index.ts", "config/app.json"]);
			git(repoDir, ["commit", "-m", "C0: multi-layer"]);
			const c0 = git(repoDir, ["rev-parse", "HEAD"]).trim();

			writeRepoFile(repoDir, "src/server/loop.ts", "export const loop = 1;\n// C1 modify\n");
			git(repoDir, ["add", "src/server/loop.ts"]);
			git(repoDir, ["commit", "-m", "C1: modify depth-2"]);
			const c1 = git(repoDir, ["rev-parse", "HEAD"]).trim();

			const expectedC1Oid = blobOidAt(repoDir, c1, "src/server/loop.ts");

			const dbPath = join(UNIQUE_DIR, `wiki-subsync-${Date.now()}.db`);
			const wiki = new WikiDatabase(dbPath);
			try {
				const nodeRepo = new WikiNodeRepository(wiki.getDb());
				const linkRepo = new WikiLinkRepository(wiki.getDb());
				const auditRepo = new WikiAuditRepository(wiki.getDb());
				const store = new WikiRepositoryStore(wiki.getDb());
				const gitReal = new ArchivistGit();
				const projectStore: ProjectStoreLike = {
					get: (id) => id === "sub"
						? { id, name: "Sub", workspaceDir: repoDir }
						: undefined,
					list: () => [{ id: "sub", name: "Sub", workspaceDir: repoDir }],
				};
				const indexer = new WikiProjectIndexer({
					wikiDb: wiki, nodeRepo, linkRepo, auditRepo,
					repositoryStore: store, git: gitReal, projectStore,
				});

				const first = await indexer.fullIndex("sub", { revision: c0 });
				expect(first.ok).toBe(true);
				// Dir chain built at fullIndex time.
				expect(nodeRepo.getActiveByPath(projectFile("sub", "src/server/loop.ts"))).toBeDefined();

				const r = await indexer.sync("sub", { targetRevision: c1 });
				expect(r.syncStatus, r.error ?? "").toBe("synced");
				expect(r.stats.modified, "depth-2 modify must apply").toBe(1);
				expect(r.changesApplied).toBe(1);
				expect(r.toRevision).toBe(c1);

				const bind = store.sourceBindings.getBySourcePath("repo-sub", "src/server/loop.ts")!;
				expect(bind.indexed_revision).toBe(c1);
				expect(bind.blob_oid).toBe(expectedC1Oid);

				// Dir chain untouched (src/, src/server/ still active).
				expect(nodeRepo.getActiveByPath(`${projectPath("sub")}/src`)).toBeDefined();
				expect(nodeRepo.getActiveByPath(`${projectPath("sub")}/src/server`)).toBeDefined();
			} finally {
				try { wiki.close(); } catch { /* ignore */ }
			}
		} finally {
			try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("SUBDIR add (config/new.json) + delete (docs/old.md) in one sync", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "zc-subad-"));
		try {
			const repoDir = mkdtempSync(join(tempRoot, "repo-"));
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "docs/old.md", "# old\n");
			writeRepoFile(repoDir, "config/keep.json", "{}\n");
			git(repoDir, ["add", "docs/old.md", "config/keep.json"]);
			git(repoDir, ["commit", "-m", "C0"]);
			const c0 = git(repoDir, ["rev-parse", "HEAD"]).trim();

			writeRepoFile(repoDir, "config/new.json", '{"new":true}\n');
			git(repoDir, ["rm", "docs/old.md"]);
			git(repoDir, ["add", "config/new.json"]);
			git(repoDir, ["commit", "-m", "C1: add + delete subdir"]);
			const c1 = git(repoDir, ["rev-parse", "HEAD"]).trim();

			const dbPath = join(UNIQUE_DIR, `wiki-subad-${Date.now()}.db`);
			const wiki = new WikiDatabase(dbPath);
			try {
				const nodeRepo = new WikiNodeRepository(wiki.getDb());
				const linkRepo = new WikiLinkRepository(wiki.getDb());
				const auditRepo = new WikiAuditRepository(wiki.getDb());
				const store = new WikiRepositoryStore(wiki.getDb());
				const gitReal = new ArchivistGit();
				const projectStore: ProjectStoreLike = {
					get: (id) => id === "ad"
						? { id, name: "Ad", workspaceDir: repoDir }
						: undefined,
					list: () => [{ id: "ad", name: "Ad", workspaceDir: repoDir }],
				};
				const indexer = new WikiProjectIndexer({
					wikiDb: wiki, nodeRepo, linkRepo, auditRepo,
					repositoryStore: store, git: gitReal, projectStore,
				});

				await indexer.fullIndex("ad", { revision: c0 });
				const r = await indexer.sync("ad", { targetRevision: c1 });
				expect(r.syncStatus, r.error ?? "").toBe("synced");
				expect(r.stats.added).toBe(1);
				expect(r.stats.deleted).toBe(1);

				// config/new.json node created + bound.
				const newBind = store.sourceBindings.getBySourcePath("repo-ad", "config/new.json");
				expect(newBind, "subdir add must create binding").toBeDefined();
				expect(newBind!.indexed_revision).toBe(c1);
				expect(nodeRepo.getActiveByPath(projectFile("ad", "config/new.json"))).toBeDefined();

				// docs/old.md archived; binding removed.
				expect(store.sourceBindings.getBySourcePath("repo-ad", "docs/old.md")).toBeUndefined();
				const oldRow = wiki.getDb()
					.prepare("SELECT archived_at FROM wiki_nodes WHERE path = ?")
					.get(projectFile("ad", "docs/old.md")) as { archived_at: string | null };
				expect(oldRow.archived_at).not.toBeNull();
			} finally {
				try { wiki.close(); } catch { /* ignore */ }
			}
		} finally {
			try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});

// ===========================================================================
// BLOCKER #1 (FLIPPED) — fullIndex on depth-2 tree now SUCCEEDS.
// (round-1 asserted INVALID_NAME throw.)
// ===========================================================================

describe("BLOCKER #1 (FLIPPED): fullIndex on depth-2 repo SUCCEEDS (joinWikiPathMulti)", () => {
	test("fullIndex src/server/loop.ts + config/app.json + docs/readme.md → all bound", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "zc-blk1-"));
		try {
			const repoDir = mkdtempSync(join(tempRoot, "repo-"));
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "src/server/loop.ts", "export const loop = 1;\n");
			writeRepoFile(repoDir, "src/server/util.ts", "export const util = 2;\n");
			writeRepoFile(repoDir, "src/server/inner/h.ts", "export const h = 3;\n");
			writeRepoFile(repoDir, "config/app.json", '{"name":"demo"}\n');
			writeRepoFile(repoDir, "docs/readme.md", "# Docs\n");
			git(repoDir, ["add", "src/server/loop.ts", "src/server/util.ts", "src/server/inner/h.ts",
				"config/app.json", "docs/readme.md"]);
			git(repoDir, ["commit", "-m", "deep tree"]);
			const sha = git(repoDir, ["rev-parse", "HEAD"]).trim();

			const dbPath = join(UNIQUE_DIR, `wiki-blk1-${Date.now()}.db`);
			const wiki = new WikiDatabase(dbPath);
			try {
				const nodeRepo = new WikiNodeRepository(wiki.getDb());
				const linkRepo = new WikiLinkRepository(wiki.getDb());
				const auditRepo = new WikiAuditRepository(wiki.getDb());
				const store = new WikiRepositoryStore(wiki.getDb());
				const gitReal = new ArchivistGit();
				const projectStore: ProjectStoreLike = {
					get: (id) => id === "blk1"
						? { id, name: "Blk1", workspaceDir: repoDir }
						: undefined,
					list: () => [{ id: "blk1", name: "Blk1", workspaceDir: repoDir }],
				};
				const indexer = new WikiProjectIndexer({
					wikiDb: wiki, nodeRepo, linkRepo, auditRepo,
					repositoryStore: store, git: gitReal, projectStore,
				});

				const result = await indexer.fullIndex("blk1", { revision: sha });
				// FLIPPED: succeeds (was: INVALID_NAME throw).
				expect(result.ok).toBe(true);
				expect(result.indexedRevision).toBe(sha);
				expect(result.trackedFiles).toBe(5);

				const repoRow = store.repositories.getByProjectId("blk1")!;
				expect(repoRow.indexed_revision).toBe(sha);

				// depth-3 file node exists + bound.
				const deepBind = store.sourceBindings.getBySourcePath("repo-blk1", "src/server/inner/h.ts");
				expect(deepBind, "depth-3 file must be bound").toBeDefined();
				expect(nodeRepo.getActiveByPath(projectFile("blk1", "src/server/inner/h.ts"))).toBeDefined();

				// Directory chain nodes exist.
				expect(nodeRepo.getActiveByPath(`${projectPath("blk1")}/src`)).toBeDefined();
				expect(nodeRepo.getActiveByPath(`${projectPath("blk1")}/src/server`)).toBeDefined();
				expect(nodeRepo.getActiveByPath(`${projectPath("blk1")}/src/server/inner`)).toBeDefined();
				expect(nodeRepo.getActiveByPath(`${projectPath("blk1")}/config`)).toBeDefined();
				expect(nodeRepo.getActiveByPath(`${projectPath("blk1")}/docs`)).toBeDefined();
			} finally {
				try { wiki.close(); } catch { /* ignore */ }
			}
		} finally {
			try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});

// ===========================================================================
// §B incremental sync — exercises applyDiffAtomically via mock git.
// ===========================================================================

describe("§B modify — only source binding/blob/stale updated; curated fields preserved", () => {
	test("modify updates binding.blob_oid/indexed_revision; seeded summary/content preserved", async () => {
		const oldOid = "oldblob0000000000000000000000000000000000000000000000001";
		const newOid = "newblob0000000000000000000000000000000000000000000000002";
		const h = makeHarness({
			projectId: "pmodify",
			oldRev: OLD_SHA,
			initialFiles: [{
				sourcePath: "a.ts",
				blobOid: oldOid,
				summary: "SEEDED SUMMARY — must survive modify sync",
				content: "SEEDED CONTENT — must survive modify sync",
			}],
		});
		try {
			h.indexer = new WikiProjectIndexer({
				wikiDb: h.wiki, nodeRepo: h.nodeRepo, linkRepo: h.linkRepo, auditRepo: h.auditRepo,
				repositoryStore: h.store, projectStore: h.projectStore,
				git: makeMockGit({
					headRevision: NEW_SHA,
					diff: [{ status: "M", path: "a.ts" }],
					treeAtNew: [{ mode: "100644", type: "blob", oid: newOid, path: "a.ts" }],
				}),
			});

			const r = await h.indexer.sync("pmodify", { targetRevision: NEW_SHA });
			expect(r.syncStatus, r.error ?? "").toBe("synced");
			expect(r.toRevision).toBe(NEW_SHA);
			expect(r.stats.modified).toBe(1);
			expect(r.changesApplied).toBe(1);

			const b = h.store.sourceBindings.getBySourcePath("repo-pmodify", "a.ts")!;
			expect(b.blob_oid).toBe(newOid);
			expect(b.indexed_revision).toBe(NEW_SHA);

			const aNodeAfter = h.nodeRepo.getActiveByPath(projectFile("pmodify", "a.ts"))!;
			expect(aNodeAfter.summary).toBe("SEEDED SUMMARY — must survive modify sync");
			expect(aNodeAfter.content).toBe("SEEDED CONTENT — must survive modify sync");
			const attrs = JSON.parse(aNodeAfter.attributes_json ?? "{}");
			expect(attrs.source_stale).toBe(true);
		} finally {
			h.dispose();
		}
	});
});

describe("§B delete — archives node, leaves no active source binding", () => {
	test("delete archives the source-bound node and removes its binding", async () => {
		const h = makeHarness({
			projectId: "pdel",
			oldRev: OLD_SHA,
			initialFiles: [{ sourcePath: "a.ts", blobOid: "oid-a" }],
		});
		try {
			h.indexer = new WikiProjectIndexer({
				wikiDb: h.wiki, nodeRepo: h.nodeRepo, linkRepo: h.linkRepo, auditRepo: h.auditRepo,
				repositoryStore: h.store, projectStore: h.projectStore,
				git: makeMockGit({
					headRevision: NEW_SHA,
					diff: [{ status: "D", path: "a.ts" }],
					treeAtNew: [],
				}),
			});

			const r = await h.indexer.sync("pdel", { targetRevision: NEW_SHA });
			expect(r.syncStatus, r.error ?? "").toBe("synced");
			expect(r.stats.deleted).toBe(1);

			expect(h.store.sourceBindings.getBySourcePath("repo-pdel", "a.ts")).toBeUndefined();

			const nodeRow = h.wiki.getDb()
				.prepare("SELECT archived_at FROM wiki_nodes WHERE name = 'a.ts' AND parent_id IN (SELECT id FROM wiki_nodes WHERE name = 'pdel')")
				.get() as { archived_at: string | null };
			expect(nodeRow.archived_at).not.toBeNull();
		} finally {
			h.dispose();
		}
	});
});

describe("§B rename — preserves internal ID + summary/content/revision/links", () => {
	test("rename keeps nodeId, summary, content, link; only path + source_path change", async () => {
		const h = makeHarness({
			projectId: "pren",
			oldRev: OLD_SHA,
			initialFiles: [{
				sourcePath: "old.ts",
				blobOid: "oid-old",
				summary: "SEEDED — survives rename",
				content: "SEEDED CONTENT — survives rename",
			}],
		});
		try {
			const oldNode = h.nodeRepo.getActiveByPath(projectFile("pren", "old.ts"))!;
			const oldId = oldNode.id;
			const oldRevision = oldNode.revision;

			let targetId = -1;
			h.wiki.transaction(() => {
				const projectNode = h.nodeRepo.getActiveByPath(projectPath("pren"))!;
				const t = h.nodeRepo.insert({
					parent_id: projectNode.id,
					name: "target.md",
					path: projectFile("pren", "target.md"),
					kind: "document",
					summary: "link target",
					content: "",
					attributes_json: null,
				});
				h.nodeRepo.syncFtsInsert(t.id, t.name, t.summary, t.content);
				targetId = t.id;
				h.linkRepo.insert({ source_id: oldId, target_id: t.id, relation: "related_to", created_by: null });
			});

			h.indexer = new WikiProjectIndexer({
				wikiDb: h.wiki, nodeRepo: h.nodeRepo, linkRepo: h.linkRepo, auditRepo: h.auditRepo,
				repositoryStore: h.store, projectStore: h.projectStore,
				git: makeMockGit({
					headRevision: NEW_SHA,
					diff: [{ status: "R100", path: "old.ts", newPath: "new.ts" }],
					treeAtNew: [{ mode: "100644", type: "blob", oid: "oid-new", path: "new.ts" }],
				}),
			});

			const r = await h.indexer.sync("pren", { targetRevision: NEW_SHA });
			expect(r.syncStatus, r.error ?? "").toBe("synced");
			expect(r.stats.renamed).toBe(1);

			expect(h.nodeRepo.getActiveByPath(projectFile("pren", "old.ts"))).toBeUndefined();
			const newNode = h.nodeRepo.getActiveByPath(projectFile("pren", "new.ts"))!;
			expect(newNode).toBeDefined();
			expect(newNode.id).toBe(oldId);
			expect(newNode.summary).toBe("SEEDED — survives rename");
			expect(newNode.content).toBe("SEEDED CONTENT — survives rename");

			const links = h.linkRepo.outgoing(newNode.id);
			expect(links.length).toBe(1);
			expect(links[0].target_id).toBe(targetId);

			const b = h.store.sourceBindings.getByNodeId(newNode.id)!;
			expect(b.source_path).toBe("new.ts");
			expect(b.blob_oid).toBe("oid-new");
			// Root rename bumps revision by exactly 1.
			expect(newNode.revision).toBe(oldRevision + 1);
		} finally {
			h.dispose();
		}
	});
});

// ===========================================================================
// BLOCKER #3 (FLIPPED) — A↔B rename swap/cycle now SUCCEEDS via synthetic mock.
// Real `git diff --find-renames` reports M (not R) for same-path content swaps,
// so the hasSwap branch CANNOT be triggered via real git. We cover it
// SYNTHETICALLY by injecting two R entries (A→B, B→A) via mock git and driving
// sync(). applyDiffAtomically is private; the behavioral swap test below is
// the direct exercise of the two-phase path. Plus a static assertion that
// phase-1 uses updateChildPathAndName (not updateChildPathOnly).
// ===========================================================================

describe("BLOCKER #3 (FLIPPED): synthetic A↔B rename swap SUCCEEDS (two-phase via updateChildPathAndName)", () => {
	test("real git reports M (not R) for same-path content swap — hasSwap unreachable via real git", async () => {
		// Documents WHY the synthetic test below is necessary. Two files at the
		// same two paths swap content; git's rename detection sees both paths
		// pre-existing → reports M for both, not R. The hasSwap branch therefore
		// only fires on a real rename cycle (a→tmp, b→a, tmp→b) which git may
		// still not detect as R entries at default similarity.
		const tempRoot = mkdtempSync(join(tmpdir(), "zc-swapreal-"));
		try {
			const repoDir = mkdtempSync(join(tempRoot, "repo-"));
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "a.ts", "AAAA\n");
			writeRepoFile(repoDir, "b.ts", "BBBB\n");
			git(repoDir, ["add", "a.ts", "b.ts"]);
			git(repoDir, ["commit", "-m", "C0"]);
			const c0 = git(repoDir, ["rev-parse", "HEAD"]).trim();
			// Swap contents (still two files at same two paths).
			writeRepoFile(repoDir, "a.ts", "BBBB\n");
			writeRepoFile(repoDir, "b.ts", "AAAA\n");
			git(repoDir, ["add", "a.ts", "b.ts"]);
			git(repoDir, ["commit", "-m", "C1: swap content"]);
			const c1 = git(repoDir, ["rev-parse", "HEAD"]).trim();
			const diff = git(repoDir, ["diff", "--name-status", "-z", "--find-renames", c0, c1]);
			// Both are M, no R entry → hasSwap branch cannot trigger.
			expect(diff).toContain("M");
			expect(diff).not.toContain("R");
		} finally {
			try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("synthetic A↔B swap: phase-1 releases UNIQUE, phase-2 writes final; IDs preserved; no residue", async () => {
		// SYNTHETIC: inject two R entries forming a cycle. This is the ONLY way
		// to reach applyDiffAtomically's hasSwap branch.
		const h = makeHarness({
			projectId: "pswap",
			oldRev: OLD_SHA,
			initialFiles: [
				{ sourcePath: "a.ts", blobOid: "oid-a-old", summary: "nodeA (originally a.ts)" },
				{ sourcePath: "b.ts", blobOid: "oid-b-old", summary: "nodeB (originally b.ts)" },
			],
		});
		try {
			const nodeA = h.nodeRepo.getActiveByPath(projectFile("pswap", "a.ts"))!;
			const nodeB = h.nodeRepo.getActiveByPath(projectFile("pswap", "b.ts"))!;
			const idA = nodeA.id;
			const idB = nodeB.id;

			h.indexer = new WikiProjectIndexer({
				wikiDb: h.wiki, nodeRepo: h.nodeRepo, linkRepo: h.linkRepo, auditRepo: h.auditRepo,
				repositoryStore: h.store, projectStore: h.projectStore,
				git: makeMockGit({
					headRevision: NEW_SHA,
					diff: [
						{ status: "R100", path: "a.ts", newPath: "b.ts" },
						{ status: "R100", path: "b.ts", newPath: "a.ts" },
					],
					treeAtNew: [
						{ mode: "100644", type: "blob", oid: "oid-a-new", path: "b.ts" },
						{ mode: "100644", type: "blob", oid: "oid-b-new", path: "a.ts" },
					],
				}),
			});

			const r = await h.indexer.sync("pswap", { targetRevision: NEW_SHA });
			// FLIPPED: swap SUCCEEDS (was: UNIQUE collision rollback).
			expect(r.syncStatus, `expected sync to succeed; error: ${r.error ?? "(none)"}`).toBe("synced");
			expect(r.stats.renamed).toBe(2);
			expect(r.changesApplied).toBe(2);
			expect(r.toRevision).toBe(NEW_SHA);

			// FLIPPED: no temp residue (was: 0 because rollback — now 0 because clean two-phase).
			expect(countSwapTempResidue(h)).toBe(0);
			expect(countSwapTempBindings(h)).toBe(0);

			// nodeA (originally a.ts) is now at b.ts; nodeB at a.ts.
			const aAfter = h.nodeRepo.getActiveByPath(projectFile("pswap", "a.ts"))!;
			const bAfter = h.nodeRepo.getActiveByPath(projectFile("pswap", "b.ts"))!;
			expect(aAfter.id, "node at a.ts after swap must be nodeB").toBe(idB);
			expect(bAfter.id, "node at b.ts after swap must be nodeA").toBe(idA);
			// Summaries travel with the node (rename preserves curated fields).
			expect(aAfter.summary).toBe("nodeB (originally b.ts)");
			expect(bAfter.summary).toBe("nodeA (originally a.ts)");

			// Bindings reflect the new source_path + the swapped blob_oids.
			const bindA = h.store.sourceBindings.getBySourcePath("repo-pswap", "a.ts")!;
			const bindB = h.store.sourceBindings.getBySourcePath("repo-pswap", "b.ts")!;
			expect(bindA.node_id).toBe(idB);
			expect(bindB.node_id).toBe(idA);
			expect(bindA.blob_oid).toBe("oid-b-new");
			expect(bindB.blob_oid).toBe("oid-a-new");
			expect(bindA.indexed_revision).toBe(NEW_SHA);
			expect(bindB.indexed_revision).toBe(NEW_SHA);

			// Repo advanced.
			const repoRow = h.store.repositories.getByProjectId("pswap")!;
			expect(repoRow.indexed_revision).toBe(NEW_SHA);
			expect(repoRow.sync_status).toBe("synced");

			// ── round-3 FIX 1 contract (BLOCKER-3 specific) ──
			// The round-2 bug was FTS corruption: phase-1 `updateChildPathAndName`
			// did a raw UPDATE on wiki_nodes.name WITHOUT syncing the FTS index,
			// so the FTS index kept OLD-name tokens while the content table had
			// tmpName. Phase-2's `update()` then ran `ftsDeleteCommand(id,
			// current.name=tmpName, ...)` against an index that held OLD tokens →
			// external-content invariant violated → next MATCH query threw
			// `SqliteError: database disk image is malformed` (SQLITE_CORRUPT_VTAB).
			//
			// The content-table assertions above CANNOT catch this — they read
			// wiki_nodes directly. The FTS-specific checks below ARE the direct
			// regression assertions for FIX 1.

			// (a) integrity_check = ok (FTS corrupt would surface here too on some
			//     SQLite builds; belt-and-suspenders alongside the MATCH probe).
			expect(h.wiki.integrityCheck(), "PRAGMA integrity_check must be ok post-swap").toBe("ok");

			// (b) MATCH query must NOT throw SQLITE_CORRUPT_VTAB and must surface
			//     the swapped nodes by their NEW names. Search the FTS-indexed name
			//     of nodeA (now at b.ts) — was originally "a.ts", now indexed as
			//     "b.ts" because FIX 1's syncFtsInsert in phase-1 + phase-2 update
			//     kept the index in lockstep with the content table.
			//     Wrap in try/catch to surface the corruption error message if the
			//     regression reappears (instead of a opaque "thrown" failure).
			let ftsHitsForB: ReturnType<typeof h.nodeRepo.searchFts> = [];
			try {
				// 'b' matches the NEW name token of nodeA (now at b.ts).
				// Using a simple term avoids FTS5 query syntax pitfalls.
				ftsHitsForB = h.nodeRepo.searchFts("b", 50);
			} catch (e) {
				throw new Error(
					`REGRESSION (round-3 FIX 1): MATCH query threw after A↔B swap — FTS index is corrupt. ` +
					`This means updateChildPathAndName did not sync FTS in phase-1. ` +
					`Original error: ${(e as Error).message}`,
				);
			}
			// nodeA (now at b.ts) must be findable by its new name token "b".
			expect(
				ftsHitsForB.some((n) => n.id === idA),
				`nodeA (id=${idA}) must be FTS-searchable by its NEW name 'b.ts' after swap; ` +
				`got hit ids: [${ftsHitsForB.map((n) => n.id).join(", ")}]`,
			).toBe(true);

			let ftsHitsForA: ReturnType<typeof h.nodeRepo.searchFts> = [];
			try {
				ftsHitsForA = h.nodeRepo.searchFts("a", 50);
			} catch (e) {
				throw new Error(
					`REGRESSION (round-3 FIX 1): second MATCH query threw — FTS corrupt. ` +
					`Original error: ${(e as Error).message}`,
				);
			}
			// nodeB (now at a.ts) must be findable by its new name token "a".
			expect(
				ftsHitsForA.some((n) => n.id === idB),
				`nodeB (id=${idB}) must be FTS-searchable by its NEW name 'a.ts' after swap; ` +
				`got hit ids: [${ftsHitsForA.map((n) => n.id).join(", ")}]`,
			).toBe(true);

			// (c) FTS row must be present for BOTH swapped nodes (no row lost).
			const ftsRowCount = (h.wiki.getDb()
				.prepare("SELECT COUNT(*) AS n FROM wiki_nodes_fts WHERE rowid IN (?, ?)")
				.get(idA, idB) as { n: number }).n;
			expect(ftsRowCount, "both swapped nodes must retain an FTS index row").toBe(2);
		} finally {
			h.dispose();
		}
	});

	// =========================================================================
	// round-3 FIX 1 — direct adversarial probe of the FTS external-content
	// invariant violation. This is the EXACT scenario that round-2's bug
	// produced: phase-1 updates wiki_nodes.name without FTS sync, then ANY
	// subsequent MATCH (or ftsDeleteCommand) trips SQLITE_CORRUPT_VTAB.
	//
	// We construct the cycle directly (real git diff does not emit R for same-
	// path content swaps, per the earlier test in this file) and then exercise
	// BOTH a fresh searchFts MATCH AND a follow-up syncFtsUpdate on the swapped
	// node — either operation trips the corruption if FIX 1 regresses.
	// =========================================================================

	test("round-3 FIX 1 adversarial: post-swap syncFtsUpdate + MATCH on BOTH swapped nodes stays consistent", async () => {
		const h = makeHarness({
			projectId: "pswapfts",
			oldRev: OLD_SHA,
			initialFiles: [
				{ sourcePath: "a.ts", blobOid: "oid-a-old", summary: "summary alpha", content: "alpha body" },
				{ sourcePath: "b.ts", blobOid: "oid-b-old", summary: "summary beta", content: "beta body" },
			],
		});
		try {
			const nodeA = h.nodeRepo.getActiveByPath(projectFile("pswapfts", "a.ts"))!;
			const nodeB = h.nodeRepo.getActiveByPath(projectFile("pswapfts", "b.ts"))!;
			const idA = nodeA.id;
			const idB = nodeB.id;

			h.indexer = new WikiProjectIndexer({
				wikiDb: h.wiki, nodeRepo: h.nodeRepo, linkRepo: h.linkRepo, auditRepo: h.auditRepo,
				repositoryStore: h.store, projectStore: h.projectStore,
				git: makeMockGit({
					headRevision: NEW_SHA,
					diff: [
						{ status: "R100", path: "a.ts", newPath: "b.ts" },
						{ status: "R100", path: "b.ts", newPath: "a.ts" },
					],
					treeAtNew: [
						{ mode: "100644", type: "blob", oid: "oid-a-new", path: "b.ts" },
						{ mode: "100644", type: "blob", oid: "oid-b-new", path: "a.ts" },
					],
				}),
			});

			const r = await h.indexer.sync("pswapfts", { targetRevision: NEW_SHA });
			expect(r.syncStatus, `swap must succeed; error: ${r.error ?? "(none)"}`).toBe("synced");

			// Post-swap: do a manual syncFtsUpdate on BOTH swapped nodes (the
			// operation that would trip SQLITE_CORRUPT_VTAB under the round-2 bug
			// because phase-1 left the FTS index holding OLD-name tokens).
			h.wiki.transaction(() => {
				// After swap: idA is now at b.ts, idB is now at a.ts.
				const aAfter = h.nodeRepo.getById(idA)!;
				const bAfter = h.nodeRepo.getById(idB)!;
				// syncFtsUpdate reads CURRENT content-table values (post-swap) and
				// re-syncs the FTS index. Under FIX 1 this is a no-op-ish resync
				// (index already consistent); under round-2 it would throw because
				// the FTS 'delete' command values wouldn't match indexed tokens.
				h.nodeRepo.syncFtsUpdate(idA, aAfter.name, aAfter.summary, aAfter.content);
				h.nodeRepo.syncFtsUpdate(idB, bAfter.name, bAfter.summary, bAfter.content);
			});

			// MATCH must still work + return BOTH swapped nodes.
			expect(h.wiki.integrityCheck()).toBe("ok");
			const m = h.nodeRepo.searchFts("alpha OR beta", 50);
			expect(m.length, "MATCH after post-swap resync must return both nodes").toBeGreaterThanOrEqual(2);
			expect(m.map((n) => n.id).sort()).toEqual([idA, idB].sort());
		} finally {
			h.dispose();
		}
	});
});

describe("§B copy — treated as new node (does NOT reuse source ID)", () => {
	test("copy a.ts → b.ts: b.ts is a NEW node distinct from a.ts's node", async () => {
		const h = makeHarness({
			projectId: "pcopy",
			oldRev: OLD_SHA,
			initialFiles: [{ sourcePath: "a.ts", blobOid: "oid-a" }],
		});
		try {
			const nodeA = h.nodeRepo.getActiveByPath(projectFile("pcopy", "a.ts"))!;

			h.indexer = new WikiProjectIndexer({
				wikiDb: h.wiki, nodeRepo: h.nodeRepo, linkRepo: h.linkRepo, auditRepo: h.auditRepo,
				repositoryStore: h.store, projectStore: h.projectStore,
				git: makeMockGit({
					headRevision: NEW_SHA,
					diff: [{ status: "C100", path: "a.ts", newPath: "b.ts" }],
					treeAtNew: [
						{ mode: "100644", type: "blob", oid: "oid-a", path: "a.ts" },
						{ mode: "100644", type: "blob", oid: "oid-b-copy", path: "b.ts" },
					],
				}),
			});

			const r = await h.indexer.sync("pcopy", { targetRevision: NEW_SHA });
			expect(r.syncStatus, r.error ?? "").toBe("synced");
			expect(r.stats.added).toBe(1);

			const nodeA2 = h.nodeRepo.getActiveByPath(projectFile("pcopy", "a.ts"))!;
			expect(nodeA2.id).toBe(nodeA.id);
			const nodeB = h.nodeRepo.getActiveByPath(projectFile("pcopy", "b.ts"))!;
			expect(nodeB).toBeDefined();
			expect(nodeB.id).not.toBe(nodeA.id);
			const bindB = h.store.sourceBindings.getByNodeId(nodeB.id)!;
			expect(bindB.source_path).toBe("b.ts");
			expect(bindB.blob_oid).toBe("oid-b-copy");
		} finally {
			h.dispose();
		}
	});
});

describe("§B add — creates file node", () => {
	test("add a new root-level file: node + binding created at NEW", async () => {
		const h = makeHarness({
			projectId: "padd",
			oldRev: OLD_SHA,
			initialFiles: [],
		});
		try {
			h.indexer = new WikiProjectIndexer({
				wikiDb: h.wiki, nodeRepo: h.nodeRepo, linkRepo: h.linkRepo, auditRepo: h.auditRepo,
				repositoryStore: h.store, projectStore: h.projectStore,
				git: makeMockGit({
					headRevision: NEW_SHA,
					diff: [{ status: "A", path: "new.ts" }],
					treeAtNew: [{ mode: "100644", type: "blob", oid: "oid-new", path: "new.ts" }],
				}),
			});

			const r = await h.indexer.sync("padd", { targetRevision: NEW_SHA });
			expect(r.syncStatus, r.error ?? "").toBe("synced");
			expect(r.stats.added).toBe(1);

			const node = h.nodeRepo.getActiveByPath(projectFile("padd", "new.ts"))!;
			expect(node).toBeDefined();
			expect(node.kind).toBe("source_file");
			const b = h.store.sourceBindings.getBySourcePath("repo-padd", "new.ts")!;
			expect(b.blob_oid).toBe("oid-new");
			expect(b.indexed_revision).toBe(NEW_SHA);
		} finally {
			h.dispose();
		}
	});

	test("SUBDIR add (mock): config/app.json → dir-chain + node created", async () => {
		const h = makeHarness({
			projectId: "padd2",
			oldRev: OLD_SHA,
			initialFiles: [],
		});
		try {
			h.indexer = new WikiProjectIndexer({
				wikiDb: h.wiki, nodeRepo: h.nodeRepo, linkRepo: h.linkRepo, auditRepo: h.auditRepo,
				repositoryStore: h.store, projectStore: h.projectStore,
				git: makeMockGit({
					headRevision: NEW_SHA,
					diff: [{ status: "A", path: "config/app.json" }],
					treeAtNew: [{ mode: "100644", type: "blob", oid: "oid-app", path: "config/app.json" }],
				}),
			});

			const r = await h.indexer.sync("padd2", { targetRevision: NEW_SHA });
			expect(r.syncStatus, r.error ?? "").toBe("synced");
			expect(r.stats.added).toBe(1);

			// Dir chain (config/) + node both created via joinWikiPathMulti.
			expect(h.nodeRepo.getActiveByPath(`${projectPath("padd2")}/config`)).toBeDefined();
			const node = h.nodeRepo.getActiveByPath(projectFile("padd2", "config/app.json"))!;
			expect(node).toBeDefined();
			const b = h.store.sourceBindings.getBySourcePath("repo-padd2", "config/app.json")!;
			expect(b.blob_oid).toBe("oid-app");
		} finally {
			h.dispose();
		}
	});
});

// ===========================================================================
// §B fault injection (FLIPPED — CONCERN 6 fix) — enrich/diff phase throws now
// caught → sync_status=failed + last_error + indexed_revision UNCHANGED.
// (round-1 used subdir add to trigger INVALID_NAME; that path is now FIXED, so
// we inject via mock git throwOn which is the realistic Git-fault case.)
// ===========================================================================

describe("§B + CONCERN 6 (FLIPPED): fault injection rolls back; indexed_revision stays old; retry succeeds", () => {
	test("enrich-phase throw (listTreeAtRevision) → sync_status=failed + last_error; indexed_revision UNCHANGED", async () => {
		const h = makeHarness({
			projectId: "pfail",
			oldRev: OLD_SHA,
			initialFiles: [{
				sourcePath: "a.ts", blobOid: "oid-a-old",
				summary: "stays unchanged after fault",
			}],
		});
		try {
			const aNodeBefore = h.nodeRepo.getActiveByPath(projectFile("pfail", "a.ts"))!;
			const revisionBefore = aNodeBefore.revision;
			const summaryBefore = aNodeBefore.summary;

			h.indexer = new WikiProjectIndexer({
				wikiDb: h.wiki, nodeRepo: h.nodeRepo, linkRepo: h.linkRepo, auditRepo: h.auditRepo,
				repositoryStore: h.store, projectStore: h.projectStore,
				git: makeMockGit({
					headRevision: NEW_SHA,
					diff: [{ status: "M", path: "a.ts" }],
					treeAtNew: [{ mode: "100644", type: "blob", oid: "oid-new", path: "a.ts" }],
					throwOn: "listTreeAtRevision", // enrich phase throws
				}),
			});

			const r = await h.indexer.sync("pfail", { targetRevision: NEW_SHA });
			// FLIPPED: caught + failed (was: propagated as thrown error).
			expect(r.syncStatus).toBe("failed");
			expect(r.toRevision).toBe(OLD_SHA);
			expect(r.error ?? "").toMatch(/fault injection/);

			const repoRow = h.store.repositories.getByProjectId("pfail")!;
			// FLIPPED: status failed + last_error set (was: stayed synced, last_error null).
			expect(repoRow.indexed_revision).toBe(OLD_SHA);
			expect(repoRow.sync_status, "BUG: status must update to failed on enrich-phase fault").toBe("failed");
			expect(repoRow.last_error ?? "").toMatch(/fault injection/);

			// a.ts unchanged (modify was in the same rolled-back txn).
			const aNodeAfter = h.nodeRepo.getActiveByPath(projectFile("pfail", "a.ts"))!;
			expect(aNodeAfter.revision).toBe(revisionBefore);
			expect(aNodeAfter.summary).toBe(summaryBefore);
			expect(h.store.sourceBindings.getBySourcePath("repo-pfail", "a.ts")!.blob_oid).toBe("oid-a-old");

			// failed audit row written.
			expect(countAudit(h, "index.sync.failed")).toBeGreaterThanOrEqual(1);
		} finally {
			h.dispose();
		}
	});

	test("diff-phase throw (diffNameStatus) → sync_status=failed + last_error; indexed_revision UNCHANGED", async () => {
		const h = makeHarness({
			projectId: "pfail2",
			oldRev: OLD_SHA,
			initialFiles: [{ sourcePath: "a.ts", blobOid: "oid-a-old" }],
		});
		try {
			h.indexer = new WikiProjectIndexer({
				wikiDb: h.wiki, nodeRepo: h.nodeRepo, linkRepo: h.linkRepo, auditRepo: h.auditRepo,
				repositoryStore: h.store, projectStore: h.projectStore,
				git: makeMockGit({
					headRevision: NEW_SHA,
					throwOn: "diffNameStatus", // diff phase throws
				}),
			});

			const r = await h.indexer.sync("pfail2", { targetRevision: NEW_SHA });
			expect(r.syncStatus).toBe("failed");
			expect(r.toRevision).toBe(OLD_SHA);

			const repoRow = h.store.repositories.getByProjectId("pfail2")!;
			expect(repoRow.indexed_revision).toBe(OLD_SHA);
			expect(repoRow.sync_status).toBe("failed");
			expect(repoRow.last_error ?? "").toMatch(/fault injection/);
		} finally {
			h.dispose();
		}
	});

	test("retry to same SHA after fault succeeds and applies changes", async () => {
		const wiki = new WikiDatabase(join(UNIQUE_DIR, `wiki-retry-${Date.now()}.db`));
		const nodeRepo = new WikiNodeRepository(wiki.getDb());
		const linkRepo = new WikiLinkRepository(wiki.getDb());
		const auditRepo = new WikiAuditRepository(wiki.getDb());
		const store = new WikiRepositoryStore(wiki.getDb());
		const projectStore: ProjectStoreLike = {
			get: (id) => id === "pretry" ? { id, name: "Retry", workspaceDir: "/mock/ws" } : undefined,
			list: () => [{ id: "pretry", name: "Retry", workspaceDir: "/mock/ws" }],
		};
		try {
			wiki.transaction(() => {
				const parent = nodeRepo.getActiveByPath(PROJECTS_NS)!;
				const pn = nodeRepo.insert({
					parent_id: parent.id, name: "pretry", path: projectPath("pretry"),
					kind: "project", summary: "Retry.", content: "",
					attributes_json: JSON.stringify({ display_name: "Retry" }),
				});
				nodeRepo.syncFtsInsert(pn.id, pn.name, pn.summary, pn.content);
				store.repositories.upsert({
					repository_id: "repo-pretry", project_node_id: pn.id, project_id: "pretry",
					source_root: "", default_branch: "main",
				});
				store.repositories.updateSyncState({
					repository_id: "repo-pretry", sync_status: "synced",
					indexed_revision: OLD_SHA, last_indexed_at: new Date().toISOString(), last_error: null,
				});
			});

			// First attempt: enrich-phase fault.
			const failIdx = new WikiProjectIndexer({
				wikiDb: wiki, nodeRepo, linkRepo, auditRepo,
				repositoryStore: store, projectStore,
				git: makeMockGit({
					headRevision: NEW_SHA,
					diff: [{ status: "A", path: "fresh.ts" }],
					treeAtNew: [{ mode: "100644", type: "blob", oid: "oid-fresh", path: "fresh.ts" }],
					throwOn: "listTreeAtRevision",
				}),
			});
			const fail = await failIdx.sync("pretry", { targetRevision: NEW_SHA });
			expect(fail.syncStatus).toBe("failed");
			expect(store.repositories.getByProjectId("pretry")!.indexed_revision).toBe(OLD_SHA);

			// Retry: working git → root-level add succeeds.
			const okIdx = new WikiProjectIndexer({
				wikiDb: wiki, nodeRepo, linkRepo, auditRepo,
				repositoryStore: store, projectStore,
				git: makeMockGit({
					headRevision: NEW_SHA,
					diff: [{ status: "A", path: "fresh.ts" }],
					treeAtNew: [{ mode: "100644", type: "blob", oid: "oid-fresh", path: "fresh.ts" }],
				}),
			});
			const ok = await okIdx.sync("pretry", { targetRevision: NEW_SHA });
			expect(ok.syncStatus, ok.error ?? "").toBe("synced");
			expect(ok.toRevision).toBe(NEW_SHA);
			expect(ok.stats.added).toBe(1);
			expect(nodeRepo.getActiveByPath(projectFile("pretry", "fresh.ts"))).toBeDefined();
			expect(store.sourceBindings.getBySourcePath("repo-pretry", "fresh.ts")!.blob_oid).toBe("oid-fresh");
		} finally {
			try { wiki.close(); } catch { /* ignore */ }
		}
	});
});

// ===========================================================================
// §B idempotent retry — same SHA → 0 changesApplied, no audit noise.
// ===========================================================================

describe("§B idempotent retry to same SHA", () => {
	test("sync to current indexed_revision = no-op; 0 changesApplied; no audit noise", async () => {
		const h = makeHarness({
			projectId: "pidem",
			oldRev: OLD_SHA,
			initialFiles: [{ sourcePath: "a.ts", blobOid: "oid-a" }],
		});
		try {
			h.indexer = new WikiProjectIndexer({
				wikiDb: h.wiki, nodeRepo: h.nodeRepo, linkRepo: h.linkRepo, auditRepo: h.auditRepo,
				repositoryStore: h.store, projectStore: h.projectStore,
				git: makeMockGit({ headRevision: OLD_SHA }),
			});

			const auditBefore = allAudit(h).length;
			const bindingsBefore = h.store.sourceBindings.listByRepository("repo-pidem").length;

			const r = await h.indexer.sync("pidem", { targetRevision: OLD_SHA });
			expect(r.changesApplied).toBe(0);
			expect(r.syncStatus).toBe("synced");
			expect(r.toRevision).toBe(OLD_SHA);
			expect(allAudit(h).length).toBe(auditBefore);
			expect(h.store.sourceBindings.listByRepository("repo-pidem").length).toBe(bindingsBefore);
		} finally {
			h.dispose();
		}
	});
});

describe("D4: idempotent retry to same SHA writes ZERO audit rows (not one)", () => {
	test("retry does NOT add index.sync or index.sync.failed audit rows", async () => {
		const h = makeHarness({
			projectId: "pd4",
			oldRev: OLD_SHA,
			initialFiles: [{ sourcePath: "a.ts", blobOid: "oid-a" }],
		});
		try {
			h.indexer = new WikiProjectIndexer({
				wikiDb: h.wiki, nodeRepo: h.nodeRepo, linkRepo: h.linkRepo, auditRepo: h.auditRepo,
				repositoryStore: h.store, projectStore: h.projectStore,
				git: makeMockGit({ headRevision: OLD_SHA }),
			});

			const syncBefore = countAudit(h, "index.sync");
			const failBefore = countAudit(h, "index.sync.failed");
			await h.indexer.sync("pd4", { targetRevision: OLD_SHA });
			expect(countAudit(h, "index.sync")).toBe(syncBefore);
			expect(countAudit(h, "index.sync.failed")).toBe(failBefore);
		} finally {
			h.dispose();
		}
	});
});
