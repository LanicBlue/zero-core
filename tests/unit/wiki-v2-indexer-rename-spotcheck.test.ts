// wiki-system-redesign sub-03 acceptance — 规约 lens (ROUND-3 SPOT-CHECK)
//
// # 文件说明书
//
// ## 核心功能
// Round-3 regression spot-check: confirm the round-3 FIX 1
// (updateChildPathAndName FTS sync rewrite) did NOT regress the NON-SWAP
// rename path. The non-swap rename path in WikiProjectIndexer.applyDiffAtomically
// (rename case) uses `nodeRepo.update()` — NOT `updateChildPathAndName` — so it
// was not directly edited in round-3. But the FTS primitives
// (ftsDeleteCommand / syncFtsInsert / readIndexedColumns) are shared, and
// round-3 touched the surrounding code; this test exercises the rename path
// end-to-end on a REAL temp Git repo to confirm:
//
//   acceptance-03 §B "rename 保留内部 ID、summary、content、revision 历史和 links,
//                      只改变 path/source binding":
//     - node ID preserved across rename (same row, NOT delete+create)
//     - summary preserved (unchanged — curation is not regenerated)
//     - content preserved (unchanged)
//     - revision = old + 1 (single bump, not double)
//     - outgoing + incoming wiki_links preserved (FK by id still resolves)
//     - source_binding source_path moved; node_id unchanged
//
//   FTS integrity (round-3 FIX discipline — confirm no SQLITE_CORRUPT_VTAB):
//     - searchFts(NEW-name-token) hits the renamed node at its NEW path/name
//     - PRAGMA integrity_check = ok after rename
//
// The fixture deliberately uses `git mv` so git's own rename detection
// (--find-renames) classifies the change as a single R (rename) entry, NOT
// D+A. This is the path that hits the `case "rename"` branch.
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + UNIQUE temp wiki.db (vi.hoisted, 隔离)。
//   - UNIQUE temp git repo (per-test, 真 git plumbing)。
//
// ## 输出
// Vitest 用例。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - Git fixture 用 `execFileSync("git", [...], {cwd})` literal argv,无 shell。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-ren-"));
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

interface RenameFixture {
	repoDir: string;
	c0Sha: string;
	c1Sha: string;
	/** Source file renamed away (C0 path). */
	oldPath: string;
	/** Source file renamed-to (C1 path). */
	newPath: string;
	/** Sibling file (never renamed; used as link target). */
	siblingPath: string;
}

/**
 * Build a fixture with two root-level source files at C0, then `git mv` one of
 * them in C1. `git mv` + identical content → 100% similarity → git diff
 * --find-renames emits a single R entry (no D+A), exercising the rename branch.
 */
function buildRenameFixture(parentTempDir: string): RenameFixture {
	const repoDir = mkdtempSync(join(parentTempDir, "zc-renfix-"));
	git(repoDir, ["init", "-b", "main"]);
	setIdentity(repoDir);

	const oldPath = "alpha.ts";
	const newPath = "zeta.ts";
	const siblingPath = "sibling.ts";

	// C0 — two source files.
	writeRepoFile(repoDir, oldPath, "export const alpha = 1;\n");
	writeRepoFile(repoDir, siblingPath, "export const sibling = 2;\n");
	git(repoDir, ["add", oldPath, siblingPath]);
	git(repoDir, ["commit", "-m", "C0: two files"]);
	const c0Sha = git(repoDir, ["rev-parse", "HEAD"]).trim();

	// C1 — pure rename (git mv), content unchanged.
	git(repoDir, ["mv", oldPath, newPath]);
	git(repoDir, ["commit", "-m", "C1: rename alpha.ts -> zeta.ts"]);
	const c1Sha = git(repoDir, ["rev-parse", "HEAD"]).trim();

	// Sanity: confirm git classifies C0..C1 as a single rename (R), not D+A.
	// If this fixture assertion fails, the test is not exercising the rename
	// branch and its conclusions do not apply.
	const diffNameStatus = git(repoDir,
		["diff", "--name-status", "-z", "--find-renames", c0Sha, c1Sha]);
	const entries = diffNameStatus.split("\0").map((s) => s.trim()).filter(Boolean);
	// --find-renames emits R<score> entries like "R100\0alpha.ts\0zeta.ts".
	expect(entries.some((e) => e.startsWith("R")), `fixture sanity: git must classify as rename (got: ${JSON.stringify(entries)})`).toBe(true);

	return { repoDir, c0Sha, c1Sha, oldPath, newPath, siblingPath };
}

// ---------------------------------------------------------------------------
// Indexer harness — same shape as wiki-v2-indexer.test.ts.
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

function makeHarness(projectId: string, workspaceDir: string): Harness {
	_dbCounter += 1;
	const dbPath = join(UNIQUE_DIR, `wiki-ren-${_dbCounter}-${Date.now()}.db`);
	const wiki = new WikiDatabase(dbPath);
	const db = wiki.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const linkRepo = new WikiLinkRepository(db);
	const auditRepo = new WikiAuditRepository(db);
	const store = new WikiRepositoryStore(db);
	const git = new ArchivistGit();
	const projectStore: ProjectStoreLike = {
		get: (id) => (id === projectId ? { id, name: "Rename Demo", workspaceDir } : undefined),
		list: () => [{ id: projectId, name: "Rename Demo", workspaceDir }],
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

let FIXTURE: RenameFixture;
const FIXTURE_TEMP = mkdtempSync(join(tmpdir(), "zc-renfix-root-"));

beforeEach(() => {
	FIXTURE = buildRenameFixture(FIXTURE_TEMP);
});

afterEach(() => {
	try { rmSync(FIXTURE_TEMP, { recursive: true, force: true }); } catch { /* ignore */ }
	try { mkdirSync(FIXTURE_TEMP, { recursive: true }); } catch { /* ignore */ }
});

// ===========================================================================
// §B rename (non-swap) — preserves node ID + summary + content + revision
//   history + links; only changes path/source binding. (acceptance-03 §B)
// ===========================================================================

describe("§B non-swap rename — preserves ID/summary/content/links; FTS not corrupted (round-3 regression spot-check)", () => {
	test("rename via git mv: node ID + summary + content + links preserved; FTS re-indexed to NEW name; integrity_check ok", async () => {
		const h = makeHarness("ren", FIXTURE.repoDir);
		try {
			const repoId = `repo-ren`;
			const projectPrefix = `${WIKI_ROOT_PATH}/projects/ren`;

			// ── C0: fullIndex ──
			const res0 = await h.indexer.fullIndex("ren", { revision: FIXTURE.c0Sha });
			expect(res0.ok).toBe(true);

			// Capture the OLD (alpha.ts) node identity & curated fields.
			const oldBinding = h.store.sourceBindings.getBySourcePath(repoId, FIXTURE.oldPath)!;
			expect(oldBinding).toBeDefined();
			const alphaId = oldBinding.node_id;
			const alphaNodeBefore = h.nodeRepo.getById(alphaId)!;
			const summaryBefore = alphaNodeBefore.summary;
			const contentBefore = alphaNodeBefore.content;
			const revisionBefore = alphaNodeBefore.revision;
			const pathBefore = alphaNodeBefore.path;

			// Sanity: summary is non-empty and mentions the OLD path (so we can
			// detect if it were regenerated to the NEW path — which it must NOT be).
			expect(summaryBefore.length).toBeGreaterThan(0);
			expect(summaryBefore).toContain(FIXTURE.oldPath);

			// Capture sibling node (link target).
			const sibBinding = h.store.sourceBindings.getBySourcePath(repoId, FIXTURE.siblingPath)!;
			const sibId = sibBinding.node_id;
			// Project root node (link source for incoming).
			const projectNode = h.nodeRepo.getActiveByPath(projectPrefix)!;
			const projectId = projectNode.id;

			// ── Insert links (curated) — both directions through alpha ──
			// outgoing: alpha → sibling (relation "depends")
			h.linkRepo.insert({
				source_id: alphaId, target_id: sibId, relation: "depends",
				created_by: "test",
			});
			// incoming: project → alpha (relation "references")
			h.linkRepo.insert({
				source_id: projectId, target_id: alphaId, relation: "references",
				created_by: "test",
			});
			expect(h.linkRepo.outgoing(alphaId).length).toBe(1);
			expect(h.linkRepo.incoming(alphaId).length).toBe(1);

			// ── C1: sync (rename applies) ──
			const advance = await h.indexer.sync("ren", { targetRevision: FIXTURE.c1Sha });
			expect(advance.toRevision).toBe(FIXTURE.c1Sha);
			expect(advance.syncStatus).toBe("synced");
			expect(advance.stats.renamed, "rename diff must apply as a single R").toBe(1);
			expect(advance.changesApplied).toBe(1);

			// ── (1) OLD source_path binding is gone; NEW source_path → SAME node_id ──
			const oldBindingAfter = h.store.sourceBindings.getBySourcePath(repoId, FIXTURE.oldPath);
			expect(oldBindingAfter, "OLD source_path must be released").toBeUndefined();
			const newBinding = h.store.sourceBindings.getBySourcePath(repoId, FIXTURE.newPath)!;
			expect(newBinding).toBeDefined();
			expect(
				newBinding.node_id,
				"rename must preserve node ID (not delete+create)",
			).toBe(alphaId);

			// ── (2) Node identity: same id, NEW path, NEW name, UNCHANGED summary/content ──
			const alphaNodeAfter = h.nodeRepo.getById(alphaId)!;
			expect(alphaNodeAfter.archived_at).toBeNull(); // not archived
			expect(alphaNodeAfter.name).toBe(FIXTURE.newPath); // name = "zeta.ts"
			expect(alphaNodeAfter.path).toBe(joinWikiPath(projectPrefix, FIXTURE.newPath));
			expect(pathBefore).toBe(joinWikiPath(projectPrefix, FIXTURE.oldPath)); // sanity: was alpha
			expect(
				alphaNodeAfter.summary,
				"summary must be PRESERVED (curation not regenerated)",
			).toBe(summaryBefore);
			expect(
				alphaNodeAfter.content,
				"content must be PRESERVED",
			).toBe(contentBefore);
			expect(
				alphaNodeAfter.revision,
				"revision must bump EXACTLY once",
			).toBe(revisionBefore + 1);

			// ── (3) Links preserved (FK by node id still resolves both directions) ──
			const outAfter = h.linkRepo.outgoing(alphaId);
			expect(outAfter.length, "outgoing link must survive rename").toBe(1);
			expect(outAfter[0].target_id).toBe(sibId);
			expect(outAfter[0].relation).toBe("depends");

			const inAfter = h.linkRepo.incoming(alphaId);
			expect(inAfter.length, "incoming link must survive rename").toBe(1);
			expect(inAfter[0].source_id).toBe(projectId);
			expect(inAfter[0].relation).toBe("references");

			// ── (4) FTS integrity (round-3 FIX 1 was about FTS sync; confirm no
			//        SQLITE_CORRUPT_VTAB and NEW name token is indexed) ──
			// searchFts throws SqliteError "database disk image is malformed" if
			// external-content invariant is violated — its absence is the assertion.
			const zetaHits = h.nodeRepo.searchFts("zeta", 50);
			const zetaHitIds = new Set(zetaHits.map((r) => r.id));
			expect(
				zetaHitIds.has(alphaId),
				`FTS must index NEW name token "zeta" for the renamed node (got: ${JSON.stringify(zetaHits.map((r) => ({ id: r.id, name: r.name, path: r.path })))})`,
			).toBe(true);
			// The hit's row reflects the NEW path/name (join reads live wiki_nodes).
			const zetaRow = zetaHits.find((r) => r.id === alphaId)!;
			expect(zetaRow.name).toBe(FIXTURE.newPath);
			expect(zetaRow.path).toBe(joinWikiPath(projectPrefix, FIXTURE.newPath));

			// Defensive: confirm no SECOND node was created at the new path
			// (rename must NOT leave a delete+create footprint).
			const allActive = h.wiki.getDb()
				.prepare("SELECT id, path, name FROM wiki_nodes WHERE archived_at IS NULL AND path LIKE ?")
				.all(`${projectPrefix}/%`) as { id: number; path: string; name: string }[];
			const sameNameCount = allActive.filter((n) => n.name === FIXTURE.newPath).length;
			expect(sameNameCount, "exactly ONE active node with the new name").toBe(1);

			// ── (5) PRAGMA integrity_check — overall DB consistency ──
			const ic = h.wiki.getDb().prepare("PRAGMA integrity_check").get() as { integrity_check: string };
			expect(ic.integrity_check, "PRAGMA integrity_check must be ok").toBe("ok");
		} finally {
			h.dispose();
		}
	});
}, 30000);
