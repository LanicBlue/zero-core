// wiki-system-redesign sub-03 acceptance — 架构 lens
// (commit integration §C + structural §G + D1/D3 adjudication + regression)
//
// # 文件说明书
//
// ## 核心功能
// 行为级验证 acceptance-03 §C(commit 集成)+ §G(结构性拒绝条件)+
// D1/D3 disclosure 裁定 + sub-03 → 旧测试的回归。
//
// 与其它 lens 的边界:
//   - 规约 lens: §A 全量镜像 / §B 幂等 / D2 / D4。
//   - 对抗 lens: §D source read/search 安全 / symlink escape / 二进制。
//   - 架构 lens(本文件): §C commit 路由 / §G Git 是事实源 /
//     D1 shim 无写路径 / D3 hook-manager / 回归。
//
// ## 关键不变量(plan-03 §6 / §G)
//   - 成功 commit/merge 必须走 indexer 并记录目标 SHA。
//   - Git 成功 + Wiki 失败 → Git 保留(不回滚),状态 stale/failed。
//   - 正式路由(/api/archivist/{scan,rescan-full,rebuild-subtree,
//     commit-requirement-doc,merge-feature}) 都走新 indexer。
//   - 旧 WikiSkeletonService 不存在可达结构写路径(只委托 indexer 或 Git)。
//   - 启动 stale-check 有界(`git rev-parse HEAD`),不阻塞 server。
//   - Git tree 是唯一事实源;不枚举 workspace readdir。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + UNIQUE temp wiki.db(vi.hoisted)。
//   - UNIQUE temp git repo(per-test,真 git plumbing)。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - sessions.db readonly;INTEGER affinity;Windows vitest exit-127 = teardown crash。
//   - 不假设 m2-wiki-archivist.test.ts / sub12-summary-truncation.test.ts 仍然存在
//     (它们 import 了被删除的 wiki-scan-cursor-store.ts —— 回归断言)。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-integ-"));
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
import { WikiSkeletonService } from "../../src/server/wiki-skeleton-service.js";
import { WIKI_ROOT_PATH, joinWikiPath } from "../../src/server/wiki/wiki-path.js";

// ---------------------------------------------------------------------------
// Git fixture helper — literal argv, NO shell, core.autocrlf=false.
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
	shim: WikiSkeletonService;
	dispose: () => void;
}

function makeHarness(projectId: string, workspaceDir: string): Harness {
	_dbCounter += 1;
	const dbPath = join(UNIQUE_DIR, `wiki-integ-${_dbCounter}-${Date.now()}.db`);
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
	const shim = new WikiSkeletonService({
		indexer,
		git,
		projectStore,
	});
	return {
		wiki, nodeRepo, linkRepo, auditRepo, store, indexer, projectStore, git, shim,
		dispose: () => { try { wiki.close(); } catch { /* ignore */ } },
	};
}

// ===========================================================================
// D1 — WikiSkeletonService shim has NO reachable structural-write path
// ===========================================================================
//
// acceptance-03 §C: "旧 WikiSkeletonService 不存在可达写路径".
// Trace: every shim method delegates to either ArchivistGit (for Git ops) or
// WikiProjectIndexer (for structural writes). The shim holds NO handle on
// WikiStore / wikiDb / nodeRepo / sourceBindings. ensureSummary is read-only
// (returns undefined), detectDivergence returns empty report.
//
// This is a static + behavioural cross-check (grep the source + behaviour).

describe("D1 — WikiSkeletonService shim has NO reachable structural-WRITE path", () => {
	test("shim deps type carries no wikiStore / cursorStore / wikiDb / nodeRepo handle", () => {
		// Static contract: the WikiSkeletonServiceDeps shape only has indexer/git/
		// projectStore/(requirementStore?)/(archivistId?). NO direct DB handles.
		// Verifying by constructing a shim with ONLY those fields — if the type
		// required wikiStore or cursorStore, this wouldn't compile. (Imported at
		// top of file: WikiSkeletonService constructor takes the deps object.)
		const h = makeHarness("static-only", UNIQUE_DIR);
		try {
			// Reach into private deps to assert the runtime shape.
			const depsAny = (h.shim as unknown as { deps: Record<string, unknown> }).deps;
			expect(depsAny["indexer"]).toBe(h.indexer);
			expect(depsAny["git"]).toBe(h.git);
			expect(depsAny["projectStore"]).toBe(h.projectStore);
			// NO structural-write handles:
			expect(depsAny["wikiStore"]).toBeUndefined();
			expect(depsAny["cursorStore"]).toBeUndefined();
			expect(depsAny["wikiDb"]).toBeUndefined();
			expect(depsAny["nodeRepo"]).toBeUndefined();
			expect(depsAny["repositoryStore"]).toBeUndefined();
		} finally {
			h.dispose();
		}
	});

	test("ensureSummary is a read-only no-op (returns undefined; never writes)", () => {
		// plan-03 §C trace: legacy lazy-summary materialization is removed; the
		// shim returns undefined so wiki-router falls back to the existing summary.
		const h = makeHarness("es", UNIQUE_DIR);
		try {
			const ret = h.shim.ensureSummary("any-node-id");
			expect(ret).toBeUndefined();
		} finally {
			h.dispose();
		}
	});

	test("detectDivergence returns empty report (no structural mutation)", async () => {
		const h = makeHarness("dd", UNIQUE_DIR);
		try {
			const r = await h.shim.detectDivergence("dd");
			expect(r.unimplementedRequirements).toEqual([]);
			expect(r.uncoveredCode).toEqual([]);
		} finally {
			h.dispose();
		}
	});

	test("cleanupWorktree delegates to git ONLY (no indexer / wiki write)", async () => {
		// Build a real repo + feature worktree so cleanup has something to do.
		// Then assert neither indexer nor wiki DB sees any write.
		const repoDir = mkdtempSync(join(UNIQUE_DIR, "wt-repo-"));
		try {
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "README.md", "# demo\n");
			git(repoDir, ["add", "README.md"]);
			git(repoDir, ["commit", "-m", "init"]);
			// Create a feature worktree the way ArchivistGit expects (central path).
			const reqId = "req-" + "abcd1234abcd1234abcd1234abcd1234";
			// Use the public central path helper so cleanup finds it.
			const { centralFeatureWorktreePath, featureBranchName } =
				await import("../../src/server/archivist-git.js");
			const centralWt = centralFeatureWorktreePath("cwt", reqId);
			mkdirSync(join(centralWt, ".."), { recursive: true });
			git(repoDir, ["worktree", "add", "-b", featureBranchName(reqId), centralWt]);
			expect(existsSync(centralWt)).toBe(true);

			const h = makeHarness("cwt", repoDir);
			try {
				const auditBefore = countAudit(h, "index.sync");
				const bindingsBefore = h.store.sourceBindings.listByRepository("repo-cwt").length;
				// cleanupWorktree should NOT touch wiki/indexer at all.
				await h.shim.cleanupWorktree("cwt", reqId);
				expect(countAudit(h, "index.sync")).toBe(auditBefore);
				expect(h.store.sourceBindings.listByRepository("repo-cwt").length).toBe(bindingsBefore);
				// repo binding shouldn't even exist (we never indexed).
				expect(h.store.repositories.getByProjectId("cwt")).toBeUndefined();
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});

// ===========================================================================
// §C — Commit/merge integration (Git success → indexer.sync → records SHA)
// ===========================================================================

describe("§C commit/merge — successful Git op delegates to indexer + records SHA", () => {
	test("commitRequirementDoc success → Git commit + indexer.sync records final SHA", async () => {
		const repoDir = mkdtempSync(join(UNIQUE_DIR, "creq-"));
		try {
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "README.md", "# demo\n");
			git(repoDir, ["add", "README.md"]);
			git(repoDir, ["commit", "-m", "init"]);

			const h = makeHarness("creq", repoDir);
			try {
				// Seed an initial binding + full index so the post-commit sync is
				// an incremental sync to the new SHA (not a from-scratch fullIndex).
				await h.indexer.fullIndex("creq");

				// Add a doc + commit via the shim's commitRequirementDoc entry.
				writeRepoFile(repoDir, "docs/REQ-1.md", "# REQ-1\nBody\n");
				const r = await h.shim.commitRequirementDoc(
					"creq",
					"REQ-1",
					"REQ-1 title",
					["docs/REQ-1.md"],
				);
				expect(r.ok).toBe(true);
				expect(r.ref).toBeTruthy();

				// plan-03 §C: indexer was called + recorded the target SHA.
				expect(r.sync, "post-commit sync result must be returned").toBeDefined();
				expect(r.sync!.toRevision).toBe(r.ref);

				// The wiki DB binding row records the new SHA.
				const repoRow = h.store.repositories.getByProjectId("creq")!;
				expect(repoRow.indexed_revision).toBe(r.ref);
				expect(repoRow.sync_status).toBe("synced");
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("mergeFeatureToMain success → indexer.sync records merged SHA", async () => {
		const repoDir = mkdtempSync(join(UNIQUE_DIR, "mrg-"));
		try {
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "README.md", "# demo\n");
			git(repoDir, ["add", "README.md"]);
			git(repoDir, ["commit", "-m", "init"]);

			const h = makeHarness("mrg", repoDir);
			try {
				await h.indexer.fullIndex("mrg");

				// Create a feature branch + commit on it + a central worktree
				// so mergeFeatureToMain has a branch to merge + worktree to clean.
				const reqId = "req-" + "feedfacefeedfacefeedfacefeedface";
				const { centralFeatureWorktreePath, featureBranchName } =
					await import("../../src/server/archivist-git.js");
				const centralWt = centralFeatureWorktreePath("mrg", reqId);
				mkdirSync(join(centralWt, ".."), { recursive: true });
				git(repoDir, ["worktree", "add", "-b", featureBranchName(reqId), centralWt]);
				writeRepoFile(centralWt, "feat.txt", "feature work\n");
				git(centralWt, ["add", "feat.txt"]);
				git(centralWt, ["commit", "-m", "feat"]);

				const r = await h.shim.mergeFeatureToMain("mrg", reqId);
				expect(r.ok).toBe(true);
				expect(r.mergedToRef).toBeTruthy();
				expect(r.sync, "post-merge sync must run").toBeDefined();
				expect(r.sync!.toRevision).toBe(r.mergedToRef);

				const repoRow = h.store.repositories.getByProjectId("mrg")!;
				expect(repoRow.indexed_revision).toBe(r.mergedToRef);
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("Git commit succeeded but Wiki sync failed → Git commit RETAINED; repo status=failed", async () => {
		// Inject a Wiki-side failure by handing the indexer a target revision
		// that doesn't exist in the repo — BLOCKER 5 fix means sync() validates
		// the target SHA via resolveRevision BEFORE diffing, so a bogus SHA
		// flips sync_status to `failed` (NOT loose synced-with-empty-diff) and
		// leaves indexed_revision UNCHANGED — all WITHOUT rolling back Git.
		const repoDir = mkdtempSync(join(UNIQUE_DIR, "fail-"));
		try {
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "README.md", "# demo\n");
			git(repoDir, ["add", "README.md"]);
			git(repoDir, ["commit", "-m", "init"]);
			const headSha = git(repoDir, ["rev-parse", "HEAD"]).trim();

			const h = makeHarness("fail", repoDir);
			try {
				// Establish a binding at HEAD so we know the baseline.
				await h.indexer.fullIndex("fail");
				const before = h.store.repositories.getByProjectId("fail")!;
				expect(before.indexed_revision).toBe(headSha);

				// Make a real Git commit (advances HEAD).
				writeRepoFile(repoDir, "docs/x.md", "# X\n");
				await h.git.commitRequirementDoc(repoDir, "forcefail", "title", ["docs/x.md"]);
				const newHead = git(repoDir, ["rev-parse", "HEAD"]).trim();
				expect(newHead).not.toBe(headSha);

				// Now request indexer.sync to a NON-EXISTENT revision → Git-side
				// commit was already successful; sync must fail WITHOUT rollback
				// of the Git commit. Plan-03 §6 explicitly forbids Git rollback.
				const bogusRev = "0".repeat(40);
				const sync = await h.indexer.onGitCommitSuccess("fail", bogusRev);
				// FLIPPED (BLOCKER 5 fix): status is now deterministically `failed`
				// (was round-1 loose /^(failed|synced)$/ — the silent-stall bug let
				// a bogus SHA through as synced). Assert hard + error surfaced.
				expect(sync.syncStatus, `expected failed, got ${sync.syncStatus} (${sync.error ?? ""})`).toBe("failed");
				expect(sync.error).toBeTruthy();
				expect(sync.toRevision).toBe(headSha); // unchanged, NOT bogus

				// CRITICAL: Git commit must NOT be rolled back.
				const headAfter = git(repoDir, ["rev-parse", "HEAD"]).trim();
				expect(headAfter, "Git HEAD must not move backward on Wiki sync failure").toBe(newHead);
				// CRITICAL: file from the commit must still exist in Git.
				const filesInHead = git(repoDir, ["ls-tree", "-r", "--name-only", "HEAD"]);
				expect(filesInHead).toContain("docs/x.md");

				// DB state reflects the failure: status=failed + last_error set +
				// indexed_revision UNCHANGED at the pre-commit baseline (headSha).
				const after = h.store.repositories.getByProjectId("fail")!;
				expect(after.sync_status).toBe("failed");
				expect(after.last_error).toBeTruthy();
				expect(after.indexed_revision, "indexed_revision must NOT advance to bogus SHA").toBe(headSha);
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("explicit full reindex via rebuildFromScratch rebuilds the SAME canonical tree", async () => {
		// acceptance-03 §C: "显式 full reindex 可从 Wiki 空 project subtree 重建相同 canonical tree".
		// (Root-level files only — multi-segment paths hit a separate blocker
		// tracked in wiki-v2-indexer.test.ts.)
		const repoDir = mkdtempSync(join(UNIQUE_DIR, "rebuild-"));
		try {
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "README.md", "# demo\n");
			writeRepoFile(repoDir, "a.ts", "console.log(1);\n");
			writeRepoFile(repoDir, "b.json", "{}\n");
			git(repoDir, ["add", "README.md", "a.ts", "b.json"]);
			git(repoDir, ["commit", "-m", "c0"]);

			const h = makeHarness("rebuild", repoDir);
			try {
				const first = await h.indexer.fullIndex("rebuild");
				expect(first.ok).toBe(true);

				const pathsBefore = allActiveNodePaths(h).filter((p) =>
					p.startsWith(`${WIKI_ROOT_PATH}/projects/rebuild/`));
				expect(pathsBefore.length).toBeGreaterThan(0);

				// Wipe + rebuild via the shim entry (mirrors /rebuild-subtree route).
				const rebuildScan = await h.shim.rebuildProjectSubtree("rebuild");
				expect(rebuildScan.scannedRef).toBeTruthy();

				const pathsAfter = allActiveNodePaths(h).filter((p) =>
					p.startsWith(`${WIKI_ROOT_PATH}/projects/rebuild/`));
				expect(pathsAfter.sort()).toEqual(pathsBefore.sort());
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});

// ===========================================================================
// §C — formal routes (index.ts /api/archivist/*) all delegate to the shim
// which delegates to the new indexer. Static trace + behavioural cross-check.
// ===========================================================================

describe("§C formal routes — /api/archivist/* all delegate to the new indexer", () => {
	test("index.ts constructs WikiSkeletonService with indexer=WikiProjectIndexer (no cursorStore)", () => {
		// Static trace: the only place that wires WikiSkeletonService for the
		// /api/archivist routes is src/server/index.ts. Read the file as text
		// and assert the construction shape.
		//
		// NOTE: reading the source from disk (NOT running it — the server boot
		// pulls in Electron-only modules). This is a static wire-up audit, in
		// line with acceptance-03 §E "verify commands" expectations.
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const src = readFileSync(
			join(process.cwd(), "src/server/index.ts"),
			"utf-8",
		);
		// The construction block uses { indexer: wikiProjectIndexer, ... }.
		expect(src).toMatch(/new\s+WikiSkeletonService\(\s*\{[^}]*indexer:\s*wikiProjectIndexer/m);
		// Cursor store is GONE — no cursorStore field anywhere in the wiring.
		expect(src).not.toMatch(/cursorStore\s*:/);
		// /api/archivist routes call archivistService.{buildSkeleton,rescanProjectFull,
		// rebuildProjectSubtree,detectDivergence,commitRequirementDoc,mergeFeatureToMain,
		// cleanupWorktree}.
		expect(src).toMatch(/archivistService\.buildSkeleton\b/);
		expect(src).toMatch(/archivistService\.rescanProjectFull\b/);
		expect(src).toMatch(/archivistService\.rebuildProjectSubtree\b/);
		expect(src).toMatch(/archivistService\.commitRequirementDoc\b/);
		expect(src).toMatch(/archivistService\.mergeFeatureToMain\b/);
		expect(src).toMatch(/archivistService\.cleanupWorktree\b/);
	});
});

// ===========================================================================
// §C — startup stale-check is NON-BLOCKING (bounded rev-parse, fire-and-forget)
// ===========================================================================

describe("§C startup — kickStaleProjectSyncs is bounded + non-blocking", () => {
	test("index.ts invokes kickStaleProjectSyncs with `void` (fire-and-forget)", () => {
		// Static trace: server/index.ts line ~718 calls
		//   void kickStaleProjectSyncs(wikiProjectIndexer, ...).
		// The `void` operator makes it explicitly fire-and-forget — server
		// serves BEFORE any full scan finishes (plan-03 §6).
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const src = readFileSync(
			join(process.cwd(), "src/server/index.ts"),
			"utf-8",
		);
		expect(src).toMatch(/void\s+kickStaleProjectSyncs\s*\(/);
	});

	test("resolveRevision is bounded (5s timeout) — no full tree walk at startup", () => {
		// plan-03 §6: startup uses bounded `git rev-parse HEAD` per project,
		// NOT `git ls-tree` / `git diff`. Confirm by reading archivist-git.ts.
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const src = readFileSync(
			join(process.cwd(), "src/server/archivist-git.ts"),
			"utf-8",
		);
		// resolveRevision uses rev-parse --verify (single-object lookup).
		expect(src).toMatch(/rev-parse.*--verify.*\^\{commit\}/);
		// It carries a 5-second timeout.
		expect(src).toMatch(/timeout:\s*5000/);
		// resolveRevision does NOT spawn ls-tree or diff.
		const fnSlice = src.match(/async\s+resolveRevision[\s\S]*?\n\s*\}/);
		expect(fnSlice, "resolveRevision function body must be found").toBeTruthy();
		expect(fnSlice![0]).not.toMatch(/\bls-tree\b/);
		expect(fnSlice![0]).not.toMatch(/\bdiff\b/);
	});
});

// ===========================================================================
// §G — Structural rejections
// ===========================================================================

describe("§G — Git tree is the truth source (no readdir enumeration)", () => {
	test("WikiProjectIndexer source contains zero readdir calls on the workspace", () => {
		// plan-03 §G: "用递归文件系统扫描替代 Git tree 事实源" is rejected.
		// Static assertion: the indexer source has no readdirSync/readdir
		// except possibly in comments.
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const src = readFileSync(
			join(process.cwd(), "src/server/wiki/wiki-project-indexer.ts"),
			"utf-8",
		);
		// Strip line + block comments before checking — comments are allowed
		// to mention readdir (the source itself references §G rejection).
		const stripped = src
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "");
		expect(stripped).not.toMatch(/\breaddir\b/);
		expect(stripped).not.toMatch(/\breaddirSync\b/);
	});

	test("ArchivistGit plumbing (ls-tree / diff / cat-file) is the only tree source", () => {
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const src = readFileSync(
			join(process.cwd(), "src/server/archivist-git.ts"),
			"utf-8",
		);
		// listTreeAtRevision uses git ls-tree -r -z (the §G truth source).
		expect(src).toMatch(/ls-tree.*-r.*-z/);
		// diffNameStatus uses git diff --name-status -z.
		expect(src).toMatch(/diff.*--name-status.*-z/);
	});
});

describe("§G — all tracked files indexed (suffix-agnostic)", () => {
	test("a .png / no-ext / .lock file at repo root each gets a source-bound node", async () => {
		// plan-03 §G: "只索引代码/文档后缀,遗漏 tracked 文件" is rejected.
		// Drive the real indexer with a fixture that includes a binary blob,
		// a no-extension file, and a .lock file. Every tracked path must have
		// an active source_binding.
		const repoDir = mkdtempSync(join(UNIQUE_DIR, "suffix-"));
		try {
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			// A 1-byte binary file (so it doesn't trip text-file expectations).
			writeRepoFile(repoDir, "icon.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("binary"));
			writeRepoFile(repoDir, "Makefile", "all:\n\techo hi\n"); // no extension
			writeRepoFile(repoDir, "yarn.lock", "# yarn lockfile\n"); // .lock suffix
			// Add via `git add -A` then commit so the .png is stored as a blob.
			git(repoDir, ["add", "-A"]);
			git(repoDir, ["commit", "-m", "init"]);

			const tracked = git(repoDir, ["ls-tree", "-r", "-z", "--name-only", "HEAD"])
				.split("\0").map((s) => s.trim()).filter(Boolean);
			expect(tracked.sort()).toEqual(["Makefile", "icon.png", "yarn.lock"].sort());

			const h = makeHarness("suffix", repoDir);
			try {
				const res = await h.indexer.fullIndex("suffix");
				expect(res.ok).toBe(true);
				expect(res.trackedFiles).toBe(3);

				const bindings = h.store.sourceBindings.listByRepository("repo-suffix");
				const paths = bindings.map((b) => b.source_path).sort();
				expect(paths).toEqual(["Makefile", "icon.png", "yarn.lock"].sort());

				// §G: NO source/README body in summary/content (binary + lockfile
				// must not get their bytes mirrored into summary/content).
				for (const b of bindings) {
					const node = h.nodeRepo.getById(b.node_id)!;
					expect(node.content, `content for ${b.source_path} must be empty`).toBe("");
					// summary may mention the source_kind/path but NOT the body bytes.
					expect(node.summary).not.toContain("yarn lockfile");
					expect(node.summary).not.toContain("PNG");
				}
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});

describe("§G — sync failure does NOT advance indexed_revision", () => {
	test("sync to nonexistent revision → repo stays at old indexed_revision + status=failed", async () => {
		// plan-03 §G: "sync 失败仍推进 revision" is rejected.
		// BLOCKER 5 fix: sync() validates targetRevision via resolveRevision at
		// the top; a bogus SHA → sync_status=failed + last_error written +
		// indexed_revision UNCHANGED (was round-1 loose: could pass as synced).
		const repoDir = mkdtempSync(join(UNIQUE_DIR, "syncrev-"));
		try {
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "README.md", "# demo\n");
			git(repoDir, ["add", "README.md"]);
			git(repoDir, ["commit", "-m", "init"]);
			const headSha = git(repoDir, ["rev-parse", "HEAD"]).trim();

			const h = makeHarness("syncrev", repoDir);
			try {
				await h.indexer.fullIndex("syncrev");
				const before = h.store.repositories.getByProjectId("syncrev")!;
				expect(before.indexed_revision).toBe(headSha);
				expect(before.sync_status).toBe("synced");

				// Sync to a target that doesn't exist in the repo.
				const bogusRev = "0".repeat(40);
				const r = await h.indexer.sync("syncrev", { targetRevision: bogusRev });
				// FLIPPED (BLOCKER 5 fix): status is deterministically `failed`
				// (round-1 loose regex accepted silent synced-stall).
				expect(r.syncStatus, `expected failed, got ${r.syncStatus} (${r.error ?? ""})`).toBe("failed");
				expect(r.error).toBeTruthy();
				expect(r.toRevision).toBe(headSha); // unchanged
				expect(r.changesApplied).toBe(0);

				const after = h.store.repositories.getByProjectId("syncrev")!;
				// CRITICAL: indexed_revision MUST NOT have moved to the bogus SHA.
				expect(
					after.indexed_revision,
					"sync failure must not advance indexed_revision to a bogus SHA",
				).toBe(headSha);
				expect(after.sync_status).toBe("failed");
				expect(after.last_error).toBeTruthy();
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});

// ===========================================================================
// §G BLOCKER #2 (FLIPPED) — incremental sync APPLIES the modify
// (round-1 documented the --no-renames=false silent-stall bug; impl fixed
//  diffNameStatus to use `--find-renames`. Post-fix: modify applies, binding
//  + indexed_revision advance to c1, retry is idempotent.)
// ===========================================================================

describe("§G BLOCKER #2 (FLIPPED) — incremental sync over modify APPLIES the change", () => {
	test("sync C0→C1 over a modify: binding + indexed_revision advance to c1; retry idempotent", async () => {
		// This was the central §G/§B/§C blocker in round-1. Every commit/merge
		// routes through indexer.sync; if sync silently no-ops on every diff,
		// the entire commit-integration acceptance item fails. BLOCKER 2 fix
		// (diffNameStatus uses `--find-renames`) makes the modify flow real.
		const repoDir = mkdtempSync(join(UNIQUE_DIR, "silent-"));
		try {
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "a.txt", "v0\n");
			git(repoDir, ["add", "a.txt"]);
			git(repoDir, ["commit", "-m", "c0"]);
			const c0 = git(repoDir, ["rev-parse", "HEAD"]).trim();

			writeRepoFile(repoDir, "a.txt", "v1\n");
			git(repoDir, ["add", "a.txt"]);
			git(repoDir, ["commit", "-m", "c1"]);
			const c1 = git(repoDir, ["rev-parse", "HEAD"]).trim();

			// Sanity: the raw git diff (default flags) DOES report the modify.
			const goodDiff = git(repoDir, ["diff", "--name-status", "-z", c0, c1]);
			expect(goodDiff.length).toBeGreaterThan(0);

			// The buggy flag form is STILL rejected by git — documents what the
			// impl USED to emit (and no longer does).
			let buggyThrew = false;
			try {
				git(repoDir, ["diff", "--name-status", "-z", "--no-renames=false", c0, c1]);
			} catch {
				buggyThrew = true;
			}
			expect(buggyThrew, "git rejects --no-renames=false (option takes no value)").toBe(true);

			// Drive the indexer: it now uses `--find-renames` internally.
			const h = makeHarness("silent", repoDir);
			try {
				await h.indexer.fullIndex("silent", { revision: c0 });
				const bindingBefore = h.store.sourceBindings.getBySourcePath("repo-silent", "a.txt")!;
				expect(bindingBefore.indexed_revision).toBe(c0);
				const summaryBefore = h.nodeRepo.getActiveByPath(projectFile("silent", "a.txt"))!.summary;

				const r = await h.indexer.sync("silent", { targetRevision: c1 });
				// FLIPPED: modify IS applied now (was: 0 dropped, silent stall).
				expect(r.syncStatus, r.error ?? "").toBe("synced");
				expect(r.stats.modified, "modify must be applied now (BLOCKER 2 fixed)").toBe(1);
				expect(r.changesApplied).toBe(1);

				// FLIPPED: repo + binding both advance to c1 (was: repo advanced
				// to c1 while binding stayed c0 → permanent staleness).
				const repoRow = h.store.repositories.getByProjectId("silent")!;
				expect(repoRow.indexed_revision).toBe(c1);
				expect(repoRow.sync_status).toBe("synced");
				expect(repoRow.last_error).toBeNull();

				const bindingAfter = h.store.sourceBindings.getBySourcePath("repo-silent", "a.txt")!;
				expect(bindingAfter.indexed_revision, "binding must advance to c1").toBe(c1);
				// blob_oid must be the c1 blob (proves the modify was read, not just the counter).
				expect(bindingAfter.blob_oid).toBe(blobOidAt(repoDir, c1, "a.txt"));

				// summary preserved (modify does not overwrite curated fields).
				expect(h.nodeRepo.getActiveByPath(projectFile("silent", "a.txt"))!.summary).toBe(summaryBefore);

				// Retry to the SAME SHA → idempotent no-op (plan-03 §B), no double-apply.
				const retry = await h.indexer.sync("silent", { targetRevision: c1 });
				expect(retry.changesApplied).toBe(0);
				expect(retry.syncStatus).toBe("synced");
				const bindingRetry = h.store.sourceBindings.getBySourcePath("repo-silent", "a.txt")!;
				expect(bindingRetry.indexed_revision).toBe(c1);
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});

// ===========================================================================
// §G BLOCKER #1 (FLIPPED) + SUBDIR coverage gap (round-1 miss)
// (round-1 documented the joinWikiPath INVALID_NAME crash on multi-segment
//  paths; impl fixed via joinWikiPathMulti. Post-fix: files under src/,
//  config/, docs/ ALL get nodes + bindings. Round-1 only had root-level
//  fixtures — that gap hid BLOCKER 1. This suite uses the COMMON real-repo
//  shape: files nested under src/ + config/ + docs/.)
// ===========================================================================

describe("§G BLOCKER #1 (FLIPPED) + SUBDIR coverage — nested files all indexed", () => {
	test("fullIndex over src/ + config/ + docs/ fixtures: every tracked file gets a node + binding", async () => {
		// The COMMON real-repo shape: code under src/, config under config/,
		// docs under docs/. Round-1 only indexed root-level files, so the
		// multi-segment joinWikiPath crash (BLOCKER 1) never fired. This is
		// the regression guard against that gap.
		const repoDir = mkdtempSync(join(UNIQUE_DIR, "subdir-mix-"));
		try {
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			// src/ subtree (depth-2 + depth-3).
			writeRepoFile(repoDir, "src/server/loop.ts", "export const loop = 1;\n");
			writeRepoFile(repoDir, "src/server/db/main.ts", "export const db = 1;\n");
			writeRepoFile(repoDir, "src/index.ts", "export const entry = 1;\n");
			// config/ subtree.
			writeRepoFile(repoDir, "config/app.json", "{}\n");
			writeRepoFile(repoDir, "config/features.yaml", "on: true\n");
			// docs/ subtree.
			writeRepoFile(repoDir, "docs/architecture.md", "# Arch\n");
			writeRepoFile(repoDir, "docs/plan/sub-03.md", "# sub-03\n");
			git(repoDir, ["add", "-A"]);
			git(repoDir, ["commit", "-m", "c0"]);
			const c0 = git(repoDir, ["rev-parse", "HEAD"]).trim();

			const tracked = git(repoDir, ["ls-tree", "-r", "-z", "--name-only", "HEAD"])
				.split("\0").map((s) => s.trim()).filter(Boolean);
			expect(tracked.length).toBe(7);

			const h = makeHarness("submix", repoDir);
			try {
				const res = await h.indexer.fullIndex("submix", { revision: c0 });
				// FLIPPED: fullIndex MUST succeed (was round-1 INVALID_NAME crash).
				expect(res.ok, `fullIndex failed: ${res.error}`).toBe(true);
				expect(res.trackedFiles).toBe(7);

				// Every tracked file → exactly one active source_binding at c0.
				const bindings = h.store.sourceBindings.listByRepository("repo-submix");
				const sourcePaths = bindings.map((b) => b.source_path).sort();
				expect(sourcePaths).toEqual([
					"config/app.json",
					"config/features.yaml",
					"docs/architecture.md",
					"docs/plan/sub-03.md",
					"src/index.ts",
					"src/server/db/main.ts",
					"src/server/loop.ts",
				].sort());
				for (const b of bindings) {
					expect(b.indexed_revision, `binding ${b.source_path} must be at c0`).toBe(c0);
					expect(b.blob_oid).toBe(blobOidAt(repoDir, c0, b.source_path));
				}

				// Intermediate directory nodes exist for every non-empty dir.
				const dirs = allActiveDirPaths(h).filter((p) =>
					p.startsWith(`${WIKI_ROOT_PATH}/projects/submix/`));
				for (const expected of ["src", "src/server", "src/server/db", "config", "docs", "docs/plan"]) {
					expect(dirs, `expected dir node for ${expected}`).toContain(`${WIKI_ROOT_PATH}/projects/submix/${expected}`);
				}
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("SUBDIR sync: modify a depth-2 file (src/server/loop.ts) C0→C1 applies", async () => {
		// Round-1 gap: incremental sync was only tested on root-level files.
		// BLOCKER 1+2 interact: even if fullIndex reaches a nested file, sync
		// must still APPLY a modify to a depth-2 path. This guards the gap.
		const repoDir = mkdtempSync(join(UNIQUE_DIR, "subdir-sync-"));
		try {
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "src/server/loop.ts", "v0\n");
			git(repoDir, ["add", "-A"]);
			git(repoDir, ["commit", "-m", "c0"]);
			const c0 = git(repoDir, ["rev-parse", "HEAD"]).trim();

			writeRepoFile(repoDir, "src/server/loop.ts", "v1\n");
			git(repoDir, ["add", "-A"]);
			git(repoDir, ["commit", "-m", "c1"]);
			const c1 = git(repoDir, ["rev-parse", "HEAD"]).trim();

			const h = makeHarness("subsync", repoDir);
			try {
				await h.indexer.fullIndex("subsync", { revision: c0 });
				const before = h.store.sourceBindings.getBySourcePath("repo-subsync", "src/server/loop.ts")!;
				expect(before.indexed_revision).toBe(c0);

				const r = await h.indexer.sync("subsync", { targetRevision: c1 });
				expect(r.syncStatus, r.error ?? "").toBe("synced");
				expect(r.stats.modified, "depth-2 modify must apply").toBe(1);

				const after = h.store.sourceBindings.getBySourcePath("repo-subsync", "src/server/loop.ts")!;
				expect(after.indexed_revision).toBe(c1);
				expect(after.blob_oid).toBe(blobOidAt(repoDir, c1, "src/server/loop.ts"));
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("SUBDIR add+delete: a new file under config/ syncs in; delete archives the node", async () => {
		const repoDir = mkdtempSync(join(UNIQUE_DIR, "subdir-ad-"));
		try {
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "config/keep.json", "{}\n");
			git(repoDir, ["add", "-A"]);
			git(repoDir, ["commit", "-m", "c0"]);
			const c0 = git(repoDir, ["rev-parse", "HEAD"]).trim();

			// c1: add config/new.toml, delete config/keep.json.
			writeRepoFile(repoDir, "config/new.toml", "k=1\n");
			rmSync(join(repoDir, "config/keep.json"));
			git(repoDir, ["add", "-A"]);
			git(repoDir, ["commit", "-m", "c1"]);
			const c1 = git(repoDir, ["rev-parse", "HEAD"]).trim();

			const h = makeHarness("subad", repoDir);
			try {
				await h.indexer.fullIndex("subad", { revision: c0 });
				expect(h.store.sourceBindings.getBySourcePath("repo-subad", "config/keep.json")).toBeDefined();
				expect(h.store.sourceBindings.getBySourcePath("repo-subad", "config/new.toml")).toBeUndefined();

				const r = await h.indexer.sync("subad", { targetRevision: c1 });
				expect(r.syncStatus, r.error ?? "").toBe("synced");
				expect(r.stats.added).toBe(1);
				expect(r.stats.deleted).toBe(1);

				// new.toml now bound; keep.json binding gone + node archived.
				expect(h.store.sourceBindings.getBySourcePath("repo-subad", "config/new.toml")).toBeDefined();
				expect(h.store.sourceBindings.getBySourcePath("repo-subad", "config/keep.json")).toBeUndefined();
				const keepNode = h.nodeRepo.getActiveByPath(projectFile("subad", "config/keep.json"));
				expect(keepNode, "deleted file's node must be archived").toBeUndefined();
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("SUBDIR rename: rename under docs/ preserves node internal ID", async () => {
		// plan-03 §G / BLOCKER 3: rename preserves internal ID + summary.
		const repoDir = mkdtempSync(join(UNIQUE_DIR, "subdir-rn-"));
		try {
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "docs/old-name.md", "# Old\n");
			git(repoDir, ["add", "-A"]);
			git(repoDir, ["commit", "-m", "c0"]);
			const c0 = git(repoDir, ["rev-parse", "HEAD"]).trim();

			// c1: rename docs/old-name.md → docs/new-name.md.
			git(repoDir, ["mv", "docs/old-name.md", "docs/new-name.md"]);
			git(repoDir, ["commit", "-m", "c1"]);
			const c1 = git(repoDir, ["rev-parse", "HEAD"]).trim();

			const h = makeHarness("subrn", repoDir);
			try {
				await h.indexer.fullIndex("subrn", { revision: c0 });
				const before = h.store.sourceBindings.getBySourcePath("repo-subrn", "docs/old-name.md")!;
				const beforeNodeId = before.node_id;
				const beforeSummary = h.nodeRepo.getById(beforeNodeId)!.summary;

				const r = await h.indexer.sync("subrn", { targetRevision: c1 });
				expect(r.syncStatus, r.error ?? "").toBe("synced");
				expect(r.stats.renamed, "rename must be detected + applied").toBe(1);

				// BLOCKER 3 (FLIPPED): rename preserves the internal node ID.
				const after = h.store.sourceBindings.getBySourcePath("repo-subrn", "docs/new-name.md")!;
				expect(after.node_id, "rename must preserve internal node ID").toBe(beforeNodeId);
				expect(after.indexed_revision).toBe(c1);
				// summary preserved (rename does not overwrite curated fields).
				expect(h.nodeRepo.getById(after.node_id)!.summary).toBe(beforeSummary);
				// old path binding is gone.
				expect(h.store.sourceBindings.getBySourcePath("repo-subrn", "docs/old-name.md")).toBeUndefined();
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});

// ===========================================================================
// §C — Formal commit/merge/scan/rescan/rebuild ROUTES integration
// (live route exercise via the shim → indexer)
// ===========================================================================

describe("§C — formal routes via shim delegate to the new indexer (live)", () => {
	test("scan route → shim.buildSkeleton → indexer.syncToHead", async () => {
		const repoDir = mkdtempSync(join(UNIQUE_DIR, "route-scan-"));
		try {
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "README.md", "# demo\n");
			git(repoDir, ["add", "README.md"]);
			git(repoDir, ["commit", "-m", "init"]);

			const h = makeHarness("rscan", repoDir);
			try {
				const r = await h.shim.buildSkeleton("rscan");
				expect(r.projectId).toBe("rscan");
				expect(r.scannedRef).toBeTruthy();
				expect(h.store.repositories.getByProjectId("rscan")).toBeDefined();
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test("rescan-full route → shim.rescanProjectFull → indexer.fullIndex", async () => {
		const repoDir = mkdtempSync(join(UNIQUE_DIR, "route-full-"));
		try {
			git(repoDir, ["init", "-b", "main"]);
			setIdentity(repoDir);
			writeRepoFile(repoDir, "README.md", "# demo\n");
			git(repoDir, ["add", "README.md"]);
			git(repoDir, ["commit", "-m", "init"]);

			const h = makeHarness("rfull", repoDir);
			try {
				const r = await h.shim.rescanProjectFull("rfull");
				expect(r.projectId).toBe("rfull");
				expect(r.scannedRef).toBeTruthy();
				expect(r.filesScanned).toBeGreaterThan(0);
			} finally {
				h.dispose();
			}
		} finally {
			try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});

// ===========================================================================
// D3 — project-work-hook-manager UNCHANGED: shim-delegation satisfies §6
// ===========================================================================

describe("D3 — project-work-hook-manager unchanged; shim-delegation satisfies §6", () => {
	test("ProjectWorkHookManager subscribes to data-change-hub (NOT to commit/merge)", () => {
		// plan-03 §6: "project-work-hook-manager.ts 及调用 commit/merge 的 workflow
		// 统一消费同一 indexer result/status". The hook manager subscribes to
		// data-change-hub events (requirements/projects/crons/etc) — it is NOT
		// in the commit/merge path at all. The "consume one indexer result"
		// requirement applies to the COMMIT/MERGE call sites, which route:
		//   git op → indexer.onGitCommitSuccess(sha) → SyncResult
		// The hook manager is unchanged because it has nothing to consume here.
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const src = readFileSync(
			join(process.cwd(), "src/server/project-work-hook-manager.ts"),
			"utf-8",
		);
		// Hook manager imports data-change-hub (not the indexer).
		expect(src).toMatch(/from\s+["']\.\/data-change-hub\.js["']/);
		expect(src).not.toMatch(/wiki-project-indexer/);
		expect(src).not.toMatch(/onGitCommitSuccess/);
		expect(src).not.toMatch(/indexer\./);
		// It calls projectWorkRunner.fireProjectWork (work trigger, not sync).
		expect(src).toMatch(/projectWorkRunner\.fireProjectWork/);
	});

	test("commit/merge call sites consume indexer.onGitCommitSuccess result (shim-side)", () => {
		// Static trace: WikiSkeletonService.commitRequirementDoc and
		// .mergeFeatureToMain both call indexer.onGitCommitSuccess(projectId, sha)
		// and surface the SyncResult. plan-03 §6 satisfied via shim-delegation.
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const src = readFileSync(
			join(process.cwd(), "src/server/wiki-skeleton-service.ts"),
			"utf-8",
		);
		expect(src).toMatch(/indexer\.onGitCommitSuccess/);
		// Both commit + merge go through this method.
		const commitSlice = src.match(/async\s+commitRequirementDoc[\s\S]*?\n\s*\}/);
		const mergeSlice = src.match(/async\s+mergeFeatureToMain[\s\S]*?\n\s*\}/);
		expect(commitSlice, "commitRequirementDoc body must exist").toBeTruthy();
		expect(mergeSlice, "mergeFeatureToMain body must exist").toBeTruthy();
		expect(commitSlice![0]).toMatch(/onGitCommitSuccess/);
		expect(mergeSlice![0]).toMatch(/onGitCommitSuccess/);
	});
});

// ===========================================================================
// Regression — DELETED wiki-scan-cursor-store.ts breaks existing test imports
// ===========================================================================

describe("Regression — deleted wiki-scan-cursor-store.ts: existing tests NO LONGER import it", () => {
	test("the source file is GONE (sub-03 deleted it)", () => {
		// plan-03 §6: "wiki-scan-cursor-store.ts: 游标迁入 wiki_repositories 后删除".
		expect(existsSync(join(process.cwd(), "src/server/wiki-scan-cursor-store.ts")))
			.toBe(false);
	});

	test("FLIPPED (plan-08 §1): legacy m2 + sub12 test files removed", () => {
		// plan-08 §1 deleted the legacy WikiScanCursorStore / wiki-scan-cursor-
		// store.ts source AND the now-dead test files (m2-wiki-archivist.test.ts
		// and sub12-summary-truncation.test.ts). Their behaviors are covered by
		// wiki-v2-* tests (service / search / regex-limits). The regression
		// guard is now "no test references the deleted module" — since both
		// files are GONE, no reference can exist.
		expect(existsSync(join(process.cwd(), "tests/unit/m2-wiki-archivist.test.ts")))
			.toBe(false);
		expect(existsSync(join(process.cwd(), "tests/unit/sub12-summary-truncation.test.ts")))
			.toBe(false);
		expect(existsSync(join(process.cwd(), "src/server/wiki-scan-cursor-store.ts")))
			.toBe(false);
	});

	test("db-migration.ts no longer CREATEs wiki_scan_cursors table (plan-08 §1)", () => {
		// plan-08 §1 removed the legacy wiki_scan_cursors DDL along with the
		// store class. Cursor state now lives in wiki_repositories.indexed_revision.
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const src = readFileSync(
			join(process.cwd(), "src/server/db-migration.ts"),
			"utf-8",
		);
		expect(src).not.toMatch(/CREATE TABLE IF NOT EXISTS wiki_scan_cursors/);
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countAudit(h: Harness, action: string): number {
	return (h.wiki.getDb()
		.prepare("SELECT COUNT(*) AS n FROM wiki_audit_log WHERE action = ?")
		.get(action) as { n: number }).n;
}

function allActiveNodePaths(h: Harness): string[] {
	return (h.wiki.getDb()
		.prepare("SELECT path FROM wiki_nodes WHERE archived_at IS NULL ORDER BY path ASC")
		.all() as { path: string }[]).map((r) => r.path);
}

function allActiveDirPaths(h: Harness): string[] {
	return (h.wiki.getDb()
		.prepare("SELECT path FROM wiki_nodes WHERE archived_at IS NULL AND kind = 'directory' ORDER BY path ASC")
		.all() as { path: string }[]).map((r) => r.path);
}

/** `<rev>:<path>` blob oid via real git (asserts binding.blob_oid after sync). */
function blobOidAt(cwd: string, rev: string, path: string): string {
	return git(cwd, ["rev-parse", `${rev}:${path}`]).trim();
}

/** Canonical wiki path of a project file: `<projectsNs>/<projectId>/<repoRelative>`. */
function projectFile(id: string, repoRelative: string): string {
	return `${WIKI_ROOT_PATH}/projects/${id}/${repoRelative}`;
}

// Ensure the wiki-root/projects subtree path is computable for assertions.
void joinWikiPath;
