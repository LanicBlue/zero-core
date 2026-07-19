// wiki-system-redesign round-2 review-fix P1 §5 VERIFIER
// (Project manifest production writer — adversarial, independent)
//
// # 文件说明书
//
// ## 核心功能
// 独立、对抗式验证 round-2 review-fix P1 §5:Project manifest 的生产写入路径
// + 状态生命周期(pending / partial / ready)+ compiler / admin / UI 接线。
//
// 7 task 全覆盖(review §5.3 + §5.5 drain 保留 + §5.6 admin/UI 接线):
//   Task 1 §5.3.1  new-binding, structure-only —— 真 fullIndex 后 project root
//                  attributes.manifest_status === "pending";6 个结构化字段
//                  缺失;compiler Project 段渲染 "Manifest: pending" + 6 个
//                  "(none recorded)";不假装 ready / semantic-complete。
//   Task 2 §5.3.2  controlled enrichment writes real fields —— 用生产写入路径
//                  WikiService.update({address:"project://", changes:{attributes:{
//                  goals/stack/.../manifest_status:"ready",manifest_updated_at}}})
//                  填 6 字段,DB 真存了;compiler 段显示真值 + "Manifest: ready";
//                  preview == runtime 字节级一致。
//   Task 3 §5.3.3  enrichment failure stays partial —— update root partial →
//                  compiler 段显示 "Manifest: partial";不说 ready。
//   Task 4 §5.3.4  git MODIFY demotes ready → partial;re-enrich 回 ready ——
//                  真 indexer.sync(C0→C1)驱 MODIFY 路径;断言 pending → ready
//                  → partial → ready 的状态机过渡。
//   Task 5 §5.3.5  no-substitution guard —— 评论 + 自检:本文件**永不**用
//                  nodeRepo.update / 原始 attributes_json SQL 写 project root
//                  的 manifest 字段。writer 永远是 WikiService.update(生产)
//                  或 indexer.fullIndex/sync(生产)。
//   Task 6 §5.5    drain preservation —— WikiService.update 子节点 summary
//                  清其 source_stale(drain)→ project ROOT 的 manifest_status
//                  保留不变。
//   Task 7 §5.5+§5.6 admin view + UI wiring —— repositoryRowToView 出来的
//                  view 含 manifestStatus;UI WikiProjectCard 读 status.manifestStatus。
//
// ## 关键不变量(对抗式)
//   - **driving the PRODUCTION write path**:enrich 走 WikiService.update
//     (生产 Wiki tool 的同一调用),不绕过;pending/partial 通过 indexer.fullIndex
//     或 WikiService.update(生产)产生,不用 nodeRepo.update / 原始 SQL。
//   - **真 git fixture**:Task 1/4 用 execFileSync("git", literal-argv) 临时
//     仓库 + 真 WikiProjectIndexer,不用 mock。
//   - **preview == runtime**:同 root attributes → compiler 输出字节一致。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - sessions.db readonly;Windows vitest exit-127 = teardown crash AFTER pass
//     line —— 看 "Tests N passed" 行作真值。
//   - Task 5 自检:grep 本文件,assert 不出现 nodeRepo.update / 直接 attributes_json
//     写 project root 的 manifest 字段。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-p1-5-manifest-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1"; // MEMORY journal —— 避免 Windows WAL teardown crash。
	return { UNIQUE_DIR: d };
});

import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import express from "express";
import { createServer, type Server } from "node:http";

import type Database from "better-sqlite3";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiLinkRepository } from "../../src/server/wiki/wiki-link-repository.js";
import { WikiAuditRepository } from "../../src/server/wiki/wiki-audit-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiEditService } from "../../src/server/wiki/wiki-edit-service.js";
import { compileWikiContext } from "../../src/server/wiki/wiki-context-compiler.js";
import {
	WikiProjectIndexer,
	type ProjectStoreLike,
} from "../../src/server/wiki/wiki-project-indexer.js";
import { ArchivistGit } from "../../src/server/archivist-git.js";
import { createWikiAdminRouter } from "../../src/server/wiki-admin-router.js";
import { WIKI_ROOT_PATH } from "../../src/server/wiki/wiki-path.js";
import {
	MANIFEST_STATUS_ATTR_KEY,
	MANIFEST_UPDATED_AT_ATTR_KEY,
	manifestStatusFromAttrs,
	PROJECT_MANIFEST_FIELD_KEYS,
} from "../../src/server/wiki/wiki-manifest.js";
import type {
	CompiledWikiAccess,
	WikiRequestContext,
	WikiAction,
	WikiNodeAttributes,
} from "../../src/shared/wiki-types.js";
import type { WikiContextEntry } from "../../src/shared/types.js";
import type { WikiRepositoryRow } from "../../src/server/wiki/wiki-repository-store.js";

// ---------------------------------------------------------------------------
// Helpers — shared service/repo construction
// ---------------------------------------------------------------------------

const ALL_ACTIONS: WikiAction[] = [
	"expand", "read", "search", "create", "update",
	"delete", "link", "unlink", "move",
];

function wideOpenAccess(agentId = "verifier-agent", activeProjectId?: string): CompiledWikiAccess {
	return {
		agentId,
		activeProjectId,
		grants: [{ canonicalScope: "wiki-root", actions: [...ALL_ACTIONS] }],
		policyRevision: 1,
	};
}

function makeCtx(activeProjectId?: string): WikiRequestContext {
	return {
		access: wideOpenAccess("verifier-agent", activeProjectId),
		agentId: "verifier-agent",
		activeProjectId,
		sessionId: "verifier-session",
		requestId: null,
	};
}

function buildService(wikiDb: WikiDatabase): WikiService {
	const db = wikiDb.getDb();
	return new WikiService({
		wikiDb,
		nodeRepo: new WikiNodeRepository(db),
		linkRepo: new WikiLinkRepository(db),
		auditRepo: new WikiAuditRepository(db),
		repositoryStore: new WikiRepositoryStore(db),
		addressService: new WikiAddressService(
			new WikiRepositoryStore(db).addresses,
			new WikiNodeRepository(db),
		),
		authorizationService: new WikiAuthorizationService(),
		editService: new WikiEditService(),
	});
}

interface Setup {
	wiki: WikiDatabase;
	db: Database.Database;
	svc: WikiService;
	nodeRepo: WikiNodeRepository;
	repoStore: WikiRepositoryStore;
	tempDir: string;
}

function setup(): Setup {
	const tempDir = mkdtempSync(join(UNIQUE_DIR, `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`));
	const wiki = new WikiDatabase(join(tempDir, "wiki.db"));
	const db = wiki.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const repoStore = new WikiRepositoryStore(db);
	const svc = buildService(wiki);
	return { wiki, db, svc, nodeRepo, repoStore, tempDir };
}

function dispose(s: Setup): void {
	try { s.wiki.close(); } catch { /* idempotent */ }
}

/**
 * Create wiki-root/projects/<projectId> project node + bind a Git repository row.
 * Returns the project node's internal id, path, and the bound repositoryId.
 *
 * WikiDatabase bootstrapFixedRoots already seeds wiki-root/wiki-root/projects/
 * wiki-root/knowledge/wiki-root/memory/ — so we just create the project child.
 */
function ensureProject(s: Setup, projectId: string, opts: {
	projectName?: string;
	indexedRevision?: string;
	syncStatus?: string;
} = {}): { projectId: string; projectPath: string; projectNodeId: number; repositoryId: string } {
	const projectPath = `${WIKI_ROOT_PATH}/projects/${projectId}`;
	const projectsNs = `${WIKI_ROOT_PATH}/projects`;
	const projectSummary = `Project ${opts.projectName ?? projectId}.`;
	const ctx = makeCtx(projectId);
	try {
		s.svc.create({
			parent: projectsNs,
			name: projectId,
			kind: "project",
			summary: projectSummary,
			attributes: { display_name: opts.projectName ?? projectId },
		}, ctx);
	} catch { /* may already exist */ }
	const projectNode = s.nodeRepo.getActiveByPath(projectPath);
	if (!projectNode) throw new Error(`ensureProject: project root ${projectPath} not seeded`);

	const repositoryId = `repo-${projectId}`;
	s.repoStore.repositories.upsert({
		repository_id: repositoryId,
		project_node_id: projectNode.id,
		project_id: projectId,
		source_root: "",
		default_branch: "main",
	});
	s.repoStore.repositories.updateSyncState({
		repository_id: repositoryId,
		sync_status: opts.syncStatus ?? "synced",
		indexed_revision: opts.indexedRevision ?? "abc123",
		last_indexed_at: new Date().toISOString(),
		last_error: null,
	});
	return { projectId, projectPath, projectNodeId: projectNode.id, repositoryId };
}

/**
 * Read parsed attributes of an active node by canonical path (verifier read-back).
 * Note: this is READ-ONLY — does not seed or mutate state. Task 5 self-check
 * asserts no test writes manifest attrs through this or any direct path.
 */
function getNodeAttributes(s: Setup, path: string): Record<string, unknown> {
	const row = s.nodeRepo.getActiveByPath(path);
	if (!row) throw new Error(`node ${path} not found`);
	try {
		const parsed = JSON.parse(row.attributes_json ?? "{}");
		return (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			? parsed as Record<string, unknown>
			: {};
	} catch { return {}; }
}

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

function setIdentity(repoDir: string): void {
	git(repoDir, ["config", "user.name", "ZC Verifier"]);
	git(repoDir, ["config", "user.email", "verifier@local"]);
}

interface TinyFixture {
	repoDir: string;
	c0Sha: string;
	c1Sha: string;
}

/**
 * Smallest possible git fixture for fullIndex + MODIFY tests. Two commits:
//   - C0: README.md + a.ts + src/loop.ts
//   - C1: modify src/loop.ts  → drives MODIFY change through indexer diff path
 */
function buildTinyFixture(parentTempDir: string): TinyFixture {
	const repoDir = mkdtempSync(join(parentTempDir, "zc-manifest-fixture-"));
	git(repoDir, ["init", "-b", "main"]);
	setIdentity(repoDir);
	writeRepoFile(repoDir, "README.md", "# Demo\n");
	writeRepoFile(repoDir, "a.ts", "export const a = 1;\n");
	writeRepoFile(repoDir, "src/loop.ts", "export const loop = 1;\n");
	git(repoDir, ["add", "README.md", "a.ts", "src/loop.ts"]);
	git(repoDir, ["commit", "-m", "C0"]);
	const c0Sha = git(repoDir, ["rev-parse", "HEAD"]).trim();
	writeRepoFile(repoDir, "src/loop.ts", "export const loop = 1;\n// C1 modify\n");
	git(repoDir, ["add", "src/loop.ts"]);
	git(repoDir, ["commit", "-m", "C1"]);
	const c1Sha = git(repoDir, ["rev-parse", "HEAD"]).trim();
	return { repoDir, c0Sha, c1Sha };
}

// ---------------------------------------------------------------------------
// Indexer harness — fresh wiki.db + real ArchivistGit + ProjectStoreLike.
// ---------------------------------------------------------------------------

interface IndexerHarness {
	wiki: WikiDatabase;
	nodeRepo: WikiNodeRepository;
	linkRepo: WikiLinkRepository;
	auditRepo: WikiAuditRepository;
	store: WikiRepositoryStore;
	indexer: WikiProjectIndexer;
	dispose: () => void;
}

function makeIndexerHarness(projectId: string, workspaceDir: string): IndexerHarness {
	const dbPath = join(UNIQUE_DIR, `wiki-manifest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
	const wiki = new WikiDatabase(dbPath);
	const db = wiki.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const linkRepo = new WikiLinkRepository(db);
	const auditRepo = new WikiAuditRepository(db);
	const store = new WikiRepositoryStore(db);
	const gitPlumbing = new ArchivistGit();
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
		git: gitPlumbing,
		projectStore,
	});
	return {
		wiki, nodeRepo, linkRepo, auditRepo, store, indexer,
		dispose: () => { try { wiki.close(); } catch { /* ignore */ } },
	};
}

// ===========================================================================
// Task 1 §5.3.1 — new-binding, structure-only: pending state after fullIndex
// ===========================================================================

describe("P1 §5.3.1 manifest — fullIndex sets pending; 6 fields absent; compiler renders pending [对抗 lens]", () => {
	const FIXTURE_TEMP = mkdtempSync(join(tmpdir(), "zc-p1-5-manifest-t1-"));

	afterEach(() => {
		try { rmSync(FIXTURE_TEMP, { recursive: true, force: true }); } catch { /* ignore */ }
		try { mkdirSync(FIXTURE_TEMP, { recursive: true }); } catch { /* ignore */ }
	});

	test("after real fullIndex: root attributes.manifest_status === 'pending'; 6 structured fields absent", async () => {
		const fixture = buildTinyFixture(FIXTURE_TEMP);
		const h = makeIndexerHarness("manifest-proj", fixture.repoDir);
		try {
			const res = await h.indexer.fullIndex("manifest-proj", { revision: fixture.c0Sha });
			expect(res.ok).toBe(true);

			const projectPath = `${WIKI_ROOT_PATH}/projects/manifest-proj`;
			const rootRow = h.nodeRepo.getActiveByPath(projectPath);
			expect(rootRow, "project root must exist after fullIndex").toBeDefined();

			// Direct attrs inspect (read-only).
			const attrs = JSON.parse(rootRow!.attributes_json ?? "{}") as Record<string, unknown>;
			expect(attrs[MANIFEST_STATUS_ATTR_KEY], "manifest_status MUST be 'pending' after fullIndex").toBe("pending");
			expect(typeof attrs[MANIFEST_UPDATED_AT_ATTR_KEY], "manifest_updated_at MUST be set (ISO string)").toBe("string");
			for (const key of PROJECT_MANIFEST_FIELD_KEYS) {
				expect(attrs[key], `structured field ${key} MUST be absent (not yet enriched)`).toBeUndefined();
			}

			// manifestStatusFromAttrs helper: absent → pending.
			expect(manifestStatusFromAttrs(attrs as WikiNodeAttributes)).toBe("pending");
			expect(manifestStatusFromAttrs(null), "absent → pending").toBe("pending");
			expect(manifestStatusFromAttrs(undefined), "undefined → pending").toBe("pending");
		} finally {
			h.dispose();
		}
	}, 30000);

	test("read via WikiService.read('project://') surfaces manifest_status in node.attributes", async () => {
		const fixture = buildTinyFixture(FIXTURE_TEMP);
		const h = makeIndexerHarness("manifest-read-proj", fixture.repoDir);
		try {
			await h.indexer.fullIndex("manifest-read-proj", { revision: fixture.c0Sha });

			// Wire a WikiService onto the SAME wiki.db the indexer wrote to, so
			// the production read path observes production indexer state.
			const svc = new WikiService({
				wikiDb: h.wiki,
				nodeRepo: h.nodeRepo,
				linkRepo: h.linkRepo,
				auditRepo: h.auditRepo,
				repositoryStore: h.store,
				addressService: new WikiAddressService(h.store.addresses, h.nodeRepo),
				authorizationService: new WikiAuthorizationService(),
				editService: new WikiEditService(),
			});
			const ctx = makeCtx("manifest-read-proj");
			const r = await svc.read({ address: "project://" }, ctx);
			const attrs = (r.node.attributes ?? {}) as Record<string, unknown>;
			expect(attrs[MANIFEST_STATUS_ATTR_KEY], "production read path surfaces pending").toBe("pending");
			for (const key of PROJECT_MANIFEST_FIELD_KEYS) {
				expect(attrs[key], `production read: ${key} absent pre-enrich`).toBeUndefined();
			}
		} finally {
			h.dispose();
		}
	}, 30000);

	test("compileWikiContext Project section: Manifest: pending line + 6 × (none recorded); not ready/semantic-complete", async () => {
		const fixture = buildTinyFixture(FIXTURE_TEMP);
		const h = makeIndexerHarness("manifest-compile-proj", fixture.repoDir);
		try {
			await h.indexer.fullIndex("manifest-compile-proj", { revision: fixture.c0Sha });

			const svc = new WikiService({
				wikiDb: h.wiki,
				nodeRepo: h.nodeRepo,
				linkRepo: h.linkRepo,
				auditRepo: h.auditRepo,
				repositoryStore: h.store,
				addressService: new WikiAddressService(h.store.addresses, h.nodeRepo),
				authorizationService: new WikiAuthorizationService(),
				editService: new WikiEditService(),
			});
			const access = wideOpenAccess("verifier-agent", "manifest-compile-proj");
			const r = await compileWikiContext({
				wikiService: svc,
				access,
				entries: [
					{ address: "project://", profile: "standard", channel: "system", budgetTokens: 4000 },
				] as WikiContextEntry[],
			});

			// MUST say pending explicitly.
			expect(r.text, "must contain 'Manifest: pending' line").toMatch(/Manifest:\s+pending\b/);
			// MUST NOT claim ready / semantic-complete (which would be a lie).
			expect(r.text, "MUST NOT claim 'Manifest: ready'").not.toMatch(/Manifest:\s+ready\b/);
			expect(r.text, "MUST NOT claim 'Manifest: partial'").not.toMatch(/Manifest:\s+partial\b/);
			// 6 fields all (none recorded).
			for (const label of ["Goals", "Stack", "Entrypoints", "Modules", "Risks", "Constraints"]) {
				expect(r.text, `field ${label} must render '(none recorded)' pre-enrich`).toMatch(new RegExp(`${label}:\\s*\\(none recorded\\)`));
			}
		} finally {
			h.dispose();
		}
	}, 30000);
});

// ===========================================================================
// Task 2 §5.3.2 — controlled enrichment writes real fields via WikiService.update
// ===========================================================================

describe("P1 §5.3.2 manifest — WikiService.update enrich path: real fields in DB + compiler shows ready [对抗 lens]", () => {
	const FIXTURE_TEMP = mkdtempSync(join(tmpdir(), "zc-p1-5-manifest-t2-"));

	afterEach(() => {
		try { rmSync(FIXTURE_TEMP, { recursive: true, force: true }); } catch { /* ignore */ }
		try { mkdirSync(FIXTURE_TEMP, { recursive: true }); } catch { /* ignore */ }
	});

	test("PRODUCTION WRITE: WikiService.update({address:'project://', changes.attributes:{6 fields, manifest_status:'ready'}})", async () => {
		const fixture = buildTinyFixture(FIXTURE_TEMP);
		const h = makeIndexerHarness("enrich-proj", fixture.repoDir);
		try {
			await h.indexer.fullIndex("enrich-proj", { revision: fixture.c0Sha });

			const svc = new WikiService({
				wikiDb: h.wiki,
				nodeRepo: h.nodeRepo,
				linkRepo: h.linkRepo,
				auditRepo: h.auditRepo,
				repositoryStore: h.store,
				addressService: new WikiAddressService(h.store.addresses, h.nodeRepo),
				authorizationService: new WikiAuthorizationService(),
				editService: new WikiEditService(),
			});
			const ctx = makeCtx("enrich-proj");

			// Read root first to grab expected_revision (exactly as the Archivist does).
			const before = await svc.read({ address: "project://" }, ctx);
			const expectedRevision = before.node.revision;
			expect((before.node.attributes as Record<string, unknown>)[MANIFEST_STATUS_ATTR_KEY])
				.toBe("pending");

			// PRODUCTION WRITE PATH — same call the Wiki tool dispatches for the
			// Archivist. Derive (not paste) 6 string[] fields + flip ready +
			// stamp manifest_updated_at.
			const manifestUpdatedAt = new Date().toISOString();
			const enrichAttrs: WikiNodeAttributes = {
				goals: ["Verify the manifest writer end-to-end"],
				stack: ["TypeScript 5", "Node 20", "better-sqlite3", "vitest"],
				entrypoints: ["src/main/index.ts", "src/renderer/index.tsx"],
				modules: ["src/server/wiki — Wiki service"],
				risks: ["Windows WAL teardown crash on better-sqlite3"],
				constraints: ["All features must register via AgentLoop hooks"],
				[MANIFEST_STATUS_ATTR_KEY]: "ready",
				[MANIFEST_UPDATED_AT_ATTR_KEY]: manifestUpdatedAt,
			};
			const updateRes = await svc.update({
				address: "project://",
				expected_revision: expectedRevision,
				changes: { attributes: enrichAttrs },
			}, ctx);
			expect(updateRes.success, "production update must succeed").toBe(true);

			// Read back via WikiService.read — DB truly has the real fields now.
			const after = await svc.read({ address: "project://" }, ctx);
			const afterAttrs = (after.node.attributes ?? {}) as Record<string, unknown>;
			expect(afterAttrs[MANIFEST_STATUS_ATTR_KEY], "DB: status now ready").toBe("ready");
			expect(afterAttrs[MANIFEST_UPDATED_AT_ATTR_KEY], "DB: manifest_updated_at stamped").toBe(manifestUpdatedAt);
			expect(afterAttrs.goals).toEqual(["Verify the manifest writer end-to-end"]);
			expect(afterAttrs.stack).toEqual(["TypeScript 5", "Node 20", "better-sqlite3", "vitest"]);
			expect(afterAttrs.entrypoints).toEqual(["src/main/index.ts", "src/renderer/index.tsx"]);
			expect(afterAttrs.modules).toEqual(["src/server/wiki — Wiki service"]);
			expect(afterAttrs.risks).toEqual(["Windows WAL teardown crash on better-sqlite3"]);
			expect(afterAttrs.constraints).toEqual(["All features must register via AgentLoop hooks"]);

			// Compiler shows ready line + real values (NOT "(none recorded)").
			const access = wideOpenAccess("verifier-agent", "enrich-proj");
			const r = await compileWikiContext({
				wikiService: svc,
				access,
				entries: [
					{ address: "project://", profile: "standard", channel: "system", budgetTokens: 4000 },
				] as WikiContextEntry[],
			});
			expect(r.text, "compiler: ready line").toMatch(/Manifest:\s+ready\b/);
			expect(r.text, "compiler: enriched on a date").toMatch(/enriched\s+\d{4}-\d{2}-\d{2}/);
			expect(r.text, "compiler: real goal value present").toContain("Verify the manifest writer end-to-end");
			expect(r.text, "compiler: real stack value present").toContain("better-sqlite3");
			expect(r.text, "compiler: real entrypoint value present").toContain("src/main/index.ts");
			expect(r.text, "compiler: real constraint value present").toContain("AgentLoop hooks");
			// 6 fields ALL show real values (none of them say "(none recorded)").
			for (const label of ["Goals", "Stack", "Entrypoints", "Modules", "Risks", "Constraints"]) {
				expect(r.text, `compiler: ${label} must NOT say (none recorded)`)
					.not.toMatch(new RegExp(`${label}:\\s*\\(none recorded\\)`));
			}
		} finally {
			h.dispose();
		}
	}, 30000);

	test("preview == runtime: byte-identical Project section text across two compiles", async () => {
		const fixture = buildTinyFixture(FIXTURE_TEMP);
		const h = makeIndexerHarness("enrich-preview-proj", fixture.repoDir);
		try {
			await h.indexer.fullIndex("enrich-preview-proj", { revision: fixture.c0Sha });

			const svc = new WikiService({
				wikiDb: h.wiki,
				nodeRepo: h.nodeRepo,
				linkRepo: h.linkRepo,
				auditRepo: h.auditRepo,
				repositoryStore: h.store,
				addressService: new WikiAddressService(h.store.addresses, h.nodeRepo),
				authorizationService: new WikiAuthorizationService(),
				editService: new WikiEditService(),
			});
			const ctx = makeCtx("enrich-preview-proj");
			const before = await svc.read({ address: "project://" }, ctx);
			await svc.update({
				address: "project://",
				expected_revision: before.node.revision,
				changes: {
					attributes: {
						goals: ["G1"],
						stack: ["S1"],
						entrypoints: ["E1"],
						modules: ["M1"],
						risks: ["R1"],
						constraints: ["C1"],
						[MANIFEST_STATUS_ATTR_KEY]: "ready",
						[MANIFEST_UPDATED_AT_ATTR_KEY]: "2026-07-18T00:00:00.000Z",
					},
				},
			}, ctx);

			const access = wideOpenAccess("verifier-agent", "enrich-preview-proj");
			const entries: WikiContextEntry[] = [
				{ address: "project://", profile: "standard", channel: "system", budgetTokens: 4000 },
			];
			const a = await compileWikiContext({ wikiService: svc, access, entries });
			const b = await compileWikiContext({ wikiService: svc, access, entries });
			expect(b.text, "preview==runtime: byte-identical Project section").toBe(a.text);
			expect(JSON.stringify(b.stats), "preview==runtime: byte-identical stats").toBe(JSON.stringify(a.stats));
			// Sanity: both carry Manifest: ready.
			expect(a.text).toMatch(/Manifest:\s+ready\b/);
			expect(b.text).toMatch(/Manifest:\s+ready\b/);
		} finally {
			h.dispose();
		}
	}, 30000);
});

// ===========================================================================
// Task 3 §5.3.3 — enrichment failure stays partial
// ===========================================================================

describe("P1 §5.3.3 manifest — partial state via WikiService.update; compiler shows partial (never ready) [对抗 lens]", () => {
	test("WikiService.update root with manifest_status='partial' → DB partial + compiler shows partial", async () => {
		const s = setup();
		try {
			ensureProject(s, "partial-proj");

			const ctx = makeCtx("partial-proj");
			const before = await s.svc.read({ address: "project://" }, ctx);
			// Pre: absent → pending.
			expect(manifestStatusFromAttrs(before.node.attributes)).toBe("pending");

			// Archivist sets partial (simulating interrupted enrich).
			const r = await s.svc.update({
				address: "project://",
				expected_revision: before.node.revision,
				changes: {
					attributes: {
						[MANIFEST_STATUS_ATTR_KEY]: "partial",
						[MANIFEST_UPDATED_AT_ATTR_KEY]: "2026-07-18T00:00:00.000Z",
						// Maybe a couple of fields got filled before interruption:
						goals: ["only this field was filled"],
					},
				},
			}, ctx);
			expect(r.success).toBe(true);

			// DB reflects partial.
			const afterAttrs = getNodeAttributes(s, `${WIKI_ROOT_PATH}/projects/partial-proj`);
			expect(afterAttrs[MANIFEST_STATUS_ATTR_KEY]).toBe("partial");

			// Compiler: shows partial, NEVER ready.
			const access = wideOpenAccess("verifier-agent", "partial-proj");
			const compiled = await compileWikiContext({
				wikiService: s.svc,
				access,
				entries: [
					{ address: "project://", profile: "standard", channel: "system", budgetTokens: 4000 },
				] as WikiContextEntry[],
			});
			expect(compiled.text, "compiler: partial line").toMatch(/Manifest:\s+partial\b/);
			expect(compiled.text, "MUST NOT say ready").not.toMatch(/Manifest:\s+ready\b/);
			expect(compiled.text, "partial hint mentions re-run wiki-enrich").toMatch(/re-run wiki-enrich/);
		} finally {
			dispose(s);
		}
	});
});

// ===========================================================================
// Task 4 §5.3.4 — git MODIFY demotes ready → partial; re-enrich → ready
// ===========================================================================

describe("P1 §5.3.4 manifest — pending → ready → partial (MODIFY demote) → ready (re-enrich) [对抗 lens — LOAD-BEARING]", () => {
	const FIXTURE_TEMP = mkdtempSync(join(tmpdir(), "zc-p1-5-manifest-t4-"));

	afterEach(() => {
		try { rmSync(FIXTURE_TEMP, { recursive: true, force: true }); } catch { /* ignore */ }
		try { mkdirSync(FIXTURE_TEMP, { recursive: true }); } catch { /* ignore */ }
	});

	test("real indexer.sync MODIFY path demotes ready → partial; WikiService.update re-enrich → ready", async () => {
		const fixture = buildTinyFixture(FIXTURE_TEMP);
		const h = makeIndexerHarness("demote-proj", fixture.repoDir);
		try {
			// === STATE 1: pending (fullIndex) ===
			const fullRes = await h.indexer.fullIndex("demote-proj", { revision: fixture.c0Sha });
			expect(fullRes.ok).toBe(true);
			const projectPath = `${WIKI_ROOT_PATH}/projects/demote-proj`;
			let rootAttrs = JSON.parse(h.nodeRepo.getActiveByPath(projectPath)!.attributes_json ?? "{}") as Record<string, unknown>;
			expect(rootAttrs[MANIFEST_STATUS_ATTR_KEY], "STATE 1: pending after fullIndex").toBe("pending");

			// Wire production service for the enrichment writes.
			const svc = new WikiService({
				wikiDb: h.wiki,
				nodeRepo: h.nodeRepo,
				linkRepo: h.linkRepo,
				auditRepo: h.auditRepo,
				repositoryStore: h.store,
				addressService: new WikiAddressService(h.store.addresses, h.nodeRepo),
				authorizationService: new WikiAuthorizationService(),
				editService: new WikiEditService(),
			});
			const ctx = makeCtx("demote-proj");

			// === STATE 2: ready (Archivist enriches via PRODUCTION WikiService.update) ===
			const readAfterIdx = await svc.read({ address: "project://" }, ctx);
			await svc.update({
				address: "project://",
				expected_revision: readAfterIdx.node.revision,
				changes: {
					attributes: {
						goals: ["G"], stack: ["S"], entrypoints: ["E"], modules: ["M"],
						risks: ["R"], constraints: ["C"],
						[MANIFEST_STATUS_ATTR_KEY]: "ready",
						[MANIFEST_UPDATED_AT_ATTR_KEY]: "2026-07-18T00:00:00.000Z",
					},
				},
			}, ctx);
			rootAttrs = JSON.parse(h.nodeRepo.getActiveByPath(projectPath)!.attributes_json ?? "{}") as Record<string, unknown>;
			expect(rootAttrs[MANIFEST_STATUS_ATTR_KEY], "STATE 2: ready after Archivist enrich").toBe("ready");

			// === STATE 3: partial (real indexer.sync drives MODIFY C0→C1) ===
			const syncRes = await h.indexer.sync("demote-proj", { targetRevision: fixture.c1Sha });
			expect(syncRes.toRevision, "sync advanced to C1").toBe(fixture.c1Sha);
			expect(syncRes.syncStatus).toBe("synced");
			// The MODIFY must have applied (src/loop.ts modified in C1).
			expect((syncRes.stats as { modified?: number }).modified ?? syncRes.changesApplied, "MODIFY diff applied")
				.toBeGreaterThanOrEqual(1);

			rootAttrs = JSON.parse(h.nodeRepo.getActiveByPath(projectPath)!.attributes_json ?? "{}") as Record<string, unknown>;
			expect(rootAttrs[MANIFEST_STATUS_ATTR_KEY], "STATE 3: demote ready → partial on MODIFY")
				.toBe("partial");

			// === STATE 4: ready again (Archivist re-enriches via PRODUCTION WikiService.update) ===
			const readAfterDemote = await svc.read({ address: "project://" }, ctx);
			await svc.update({
				address: "project://",
				expected_revision: readAfterDemote.node.revision,
				changes: {
					attributes: {
						[MANIFEST_STATUS_ATTR_KEY]: "ready",
						[MANIFEST_UPDATED_AT_ATTR_KEY]: "2026-07-18T01:00:00.000Z",
					},
				},
			}, ctx);
			rootAttrs = JSON.parse(h.nodeRepo.getActiveByPath(projectPath)!.attributes_json ?? "{}") as Record<string, unknown>;
			expect(rootAttrs[MANIFEST_STATUS_ATTR_KEY], "STATE 4: ready again after re-enrich").toBe("ready");

			// Full state machine observed in order.
			// (The four .toBe above ARE the assertion; this comment is the human-readable summary.)
		} finally {
			h.dispose();
		}
	}, 60000);

	test("demote is no-op on pending/partial (only fires on ready) — preserves status + revision", async () => {
		// Drive a MODIFY through indexer.sync on a project that's still pending
		// (never enriched to ready). Demote path must NOT fire — status stays pending.
		// (Root revision MAY bump legitimately via stampProjectRootSummary, which
		// reflects the new indexed_revision; that bump is independent of demote and
		// is not a violation. We assert STATUS + manifest_updated_at only.)
		const fixture = buildTinyFixture(FIXTURE_TEMP);
		const h = makeIndexerHarness("demote-noop-proj", fixture.repoDir);
		try {
			await h.indexer.fullIndex("demote-noop-proj", { revision: fixture.c0Sha });
			const projectPath = `${WIKI_ROOT_PATH}/projects/demote-noop-proj`;
			const rootAfterFull = h.nodeRepo.getActiveByPath(projectPath)!;
			const attrsAfterFull = JSON.parse(rootAfterFull.attributes_json ?? "{}") as Record<string, unknown>;
			expect(attrsAfterFull[MANIFEST_STATUS_ATTR_KEY]).toBe("pending");
			// Capture manifest_updated_at — demote would have refreshed it; we want
			// it stable here (proves demote didn't fire).
			const updatedAtAfterFull = attrsAfterFull[MANIFEST_UPDATED_AT_ATTR_KEY];

			// C0→C1 sync drives MODIFY; demote must no-op because status is pending.
			await h.indexer.sync("demote-noop-proj", { targetRevision: fixture.c1Sha });

			const rootAfterSync = h.nodeRepo.getActiveByPath(projectPath)!;
			const attrsAfterSync = JSON.parse(rootAfterSync.attributes_json ?? "{}") as Record<string, unknown>;
			expect(attrsAfterSync[MANIFEST_STATUS_ATTR_KEY], "pending MUST stay pending (no spurious demote)")
				.toBe("pending");
			// manifest_updated_at would have been refreshed by demote; prove it wasn't.
			expect(attrsAfterSync[MANIFEST_UPDATED_AT_ATTR_KEY], "no demote → manifest_updated_at unchanged")
				.toBe(updatedAtAfterFull);
		} finally {
			h.dispose();
		}
	}, 60000);
});

// ===========================================================================
// Task 5 §5.3.5 — no-substitution guard (self-check)
// ===========================================================================

describe("P1 §5.3.5 manifest — no-substitution guard: writer is ALWAYS WikiService.update or the indexer [对抗 lens]", () => {
	test("SELF-CHECK: this test file contains NO nodeRepo.update writes to project root manifest attrs", () => {
		// Read own source. Assert we never use nodeRepo.update to set manifest_status
		// or manifest_updated_at on the project root, and we never write raw
		// attributes_json SQL on the project root to seed manifest fields.
		// (getNodeAttributes is READ-ONLY and explicitly allowed. The raw SQL
		// UPDATE on the CHILD source_file in Task 6 is for source_stale, NOT
		// for manifest fields — different attribute, different node.)
		const own = readFileSync(__filename, "utf-8");

		// Forbidden pattern 1: any direct write through the node-repository
		// update API. This file should NEVER call that API to write any state —
		// it bypasses WikiService authz/drain and the production indexer path.
		// All writes go through WikiService.update or indexer.fullIndex/sync.
		// (We strip JS comments before scanning so this explanatory text does
		// not affect the check.)
		const ownNoComments = own.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
		expect(ownNoComments, "MUST NOT call the node-repo update API directly (bypasses authz + drain)")
			.not.toMatch(/\bnodeRepo\s*\.\s*update\s*\(/);

		// Forbidden pattern 2: raw UPDATE wiki_nodes ... manifest_status. (The
		// Task-6 raw SQL on the CHILD writes source_stale, not manifest_status,
		// so this precise pattern is forbidden everywhere in this file.)
		expect(ownNoComments, "MUST NOT write manifest_status via raw SQL")
			.not.toMatch(/UPDATE\s+wiki_nodes[^;]*manifest_status/s);
		expect(ownNoComments, "MUST NOT write manifest_updated_at via raw SQL")
			.not.toMatch(/UPDATE\s+wiki_nodes[^;]*manifest_updated_at/s);

		// Positive check: we DO use the production writer.
		expect(own, "uses production WikiService.update on project://")
			.toContain('address: "project://"');
	});

	test("SELF-CHECK: getNodeAttributes in this file is read-only (no UPDATE / .update call inside it)", () => {
		const own = readFileSync(__filename, "utf-8");
		// Extract getNodeAttributes function body.
		const m = own.match(/function getNodeAttributes[\s\S]*?\r?\n}\r?\n/);
		expect(m, "getNodeAttributes must be defined in this file").not.toBeNull();
		const body = m![0];
		expect(body, "getNodeAttributes MUST NOT call .update()").not.toMatch(/\.update\(/);
		expect(body, "getNodeAttributes MUST NOT run UPDATE SQL").not.toMatch(/UPDATE\s+/i);
		expect(body, "getNodeAttributes MUST NOT call .run(").not.toMatch(/\.run\(/);
	});
});

// ===========================================================================
// Task 6 §5.5 — drain preservation: WikiService.update child summary clears
// child source_stale but PRESERVES project root manifest_status
// ===========================================================================

describe("P1 §5.5 manifest — drain preserves manifest_status when child summary update clears source_stale [对抗 lens — LOAD-BEARING]", () => {
	test("child summary update (drain) → child source_stale cleared, ROOT manifest_status unchanged", async () => {
		const s = setup();
		try {
			const project = ensureProject(s, "drain-preserve-proj");

			// Set root manifest_status = ready via PRODUCTION path (the Archivist's
			// Wiki tool call). Then a child update that drains source_stale must
			// NOT clobber the root's manifest attrs.
			const ctx = makeCtx("drain-preserve-proj");
			const before = await s.svc.read({ address: "project://" }, ctx);
			await s.svc.update({
				address: "project://",
				expected_revision: before.node.revision,
				changes: {
					attributes: {
						goals: ["G"], stack: ["S"], entrypoints: ["E"], modules: ["M"],
						risks: ["R"], constraints: ["C"],
						[MANIFEST_STATUS_ATTR_KEY]: "ready",
						[MANIFEST_UPDATED_AT_ATTR_KEY]: "2026-07-18T00:00:00.000Z",
					},
				},
			}, ctx);
			const rootAttrsBefore = getNodeAttributes(s, project.projectPath);
			expect(rootAttrsBefore[MANIFEST_STATUS_ATTR_KEY]).toBe("ready");
			const rootRevBefore = s.nodeRepo.getActiveByPath(project.projectPath)!.revision;

			// Create a child source_file + mark it source_stale (indexer MODIFY style:
			// direct attributes write on the CHILD, not the root).
			await s.svc.create({
				parent: project.projectPath,
				name: "child.ts",
				kind: "source_file",
				summary: "old summary",
				content: "old content",
			}, ctx);
			const childPath = `${project.projectPath}/child.ts`;
			// Indexer-style MODIFY on child: set source_stale directly via raw SQL
			// on the CHILD (this is permitted — simulating indexer's
			// nodeRepo.update on the source-bound child node; NOT the root).
			s.db.prepare(`UPDATE wiki_nodes SET attributes_json = ? WHERE path = ?`)
				.run(JSON.stringify({
					source_kind: "source_file",
					source_stale: true,
					source_stale_at: "2026-07-15T00:00:00.000Z",
				}), childPath);
			const childBefore = getNodeAttributes(s, childPath);
			expect(childBefore.source_stale, "child seeded stale").toBe(true);

			// Drain: WikiService.update child summary (the production Archivist path
			// for re-summarizing a node whose source changed).
			const childRow = s.nodeRepo.getActiveByPath(childPath)!;
			const r = await s.svc.update({
				address: childPath,
				expected_revision: childRow.revision,
				changes: { summary: "freshly re-summarized" },
			}, ctx);
			expect(r.success).toBe(true);

			// Child: source_stale drained.
			const childAfter = getNodeAttributes(s, childPath);
			expect(childAfter.source_stale, "child source_stale MUST drain on summary update")
				.not.toBe(true);
			expect(childAfter.source_stale_at).toBeUndefined();

			// ROOT: manifest attrs UNCHANGED.
			const rootAttrsAfter = getNodeAttributes(s, project.projectPath);
			expect(rootAttrsAfter[MANIFEST_STATUS_ATTR_KEY], "ROOT manifest_status MUST survive child drain")
				.toBe("ready");
			expect(rootAttrsAfter[MANIFEST_UPDATED_AT_ATTR_KEY], "ROOT manifest_updated_at MUST survive child drain")
				.toBe("2026-07-18T00:00:00.000Z");
			for (const key of PROJECT_MANIFEST_FIELD_KEYS) {
				expect(rootAttrsAfter[key], `ROOT ${key} MUST survive child drain`).toBeDefined();
			}
			const rootRevAfter = s.nodeRepo.getActiveByPath(project.projectPath)!.revision;
			expect(rootRevAfter, "ROOT revision MUST NOT bump from child drain")
				.toBe(rootRevBefore);
		} finally {
			dispose(s);
		}
	});
});

// ===========================================================================
// Task 7 §5.5 + §5.6 — admin view + UI wiring
// ===========================================================================

describe("P1 §5.5+§5.6 manifest — admin router view carries manifestStatus; UI binds to status.manifestStatus [对抗 lens]", () => {
	test("repositoryRowToView (via real /repositories/list) returns manifestStatus field on the view", async () => {
		// Set up a real WikiService + a stubbed repositoryStore with one row.
		// Drive POST /api/wiki-admin/repositories/list through the real router
		// (real repositoryRowToView) and assert the returned view has
		// manifestStatus matching the project root's state.
		const s = setup();
		let server: Server | null = null;
		try {
			ensureProject(s, "admin-proj");

			// Mark root ready via PRODUCTION path.
			const ctx = makeCtx("admin-proj");
			const before = await s.svc.read({ address: "project://" }, ctx);
			await s.svc.update({
				address: "project://",
				expected_revision: before.node.revision,
				changes: {
					attributes: {
						[MANIFEST_STATUS_ATTR_KEY]: "ready",
						[MANIFEST_UPDATED_AT_ATTR_KEY]: "2026-07-18T00:00:00.000Z",
					},
				},
			}, ctx);

			// Spy on repositoryStore.repositories.list: return one row for admin-proj.
			// We keep the real store (which already has admin-proj from ensureProject)
			// but provide a minimal stub store wrapper so the router reads exactly
			// our one row regardless of the underlying DB state.
			const row: WikiRepositoryRow = {
				repository_id: "repo-admin-proj",
				project_node_id: s.nodeRepo.getActiveByPath(`${WIKI_ROOT_PATH}/projects/admin-proj`)!.id,
				project_id: "admin-proj",
				source_root: "",
				default_branch: "main",
				sync_status: "synced",
				indexed_revision: "abc123",
				last_indexed_at: "2026-07-18T00:00:00.000Z",
				last_error: null,
			};
			const stubRepoStore = {
				addresses: { list: () => [] },
				repositories: {
					list: () => [row],
					getByProjectId: (id: string) => (id === "admin-proj" ? row : undefined),
					upsert: () => undefined,
					delete: () => undefined,
				},
			};
			const stubProjectStore = {
				get: (id: string) => (id === "admin-proj" ? { id, name: "Admin Proj", workspaceDir: "" } : undefined),
				list: () => [],
			};
			const stubGit = {
				isGitRepo: async () => false,
				resolveRevision: async () => null,
				detectDefaultBranch: async () => "main",
			};

			const app = express();
			app.use(express.json());
			app.use("/api/wiki-admin", createWikiAdminRouter({
				wikiService: s.svc,
				addressService: new WikiAddressService(s.repoStore.addresses, s.nodeRepo),
				indexer: {
					ensureBinding: async () => { throw new Error("not used"); },
					fullIndex: async () => { throw new Error("not used"); },
					sync: async () => { throw new Error("not used"); },
					rebuildFromScratch: async () => { throw new Error("not used"); },
				} as any,
				repositoryStore: stubRepoStore as any,
				auditRepo: new WikiAuditRepository(s.db),
				nodeRepo: s.nodeRepo,
				projectStore: stubProjectStore as any,
				agentService: {
					publishAgentWikiPolicy: async () => ({ newRevision: 1, affectedSessions: [] }),
					getAgentWikiPolicy: async () => ({ grants: [], policyRevision: 1 }),
				} as any,
				agentStore: { get: () => undefined, update: () => undefined, list: () => [], onChange: () => () => {} } as any,
				git: stubGit as any,
			}));

			server = createServer(app);
			await new Promise<void>((resolve) => {
				server!.listen(0, () => resolve());
			});
			const port = (server.address() as { port: number }).port;

			const resp = await fetch(`http://localhost:${port}/api/wiki-admin/repositories/list`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(resp.status).toBe(200);
			const data = await resp.json() as { ok: boolean; result: { repositories: Array<{ manifestStatus: string }> } };
			expect(data.ok).toBe(true);
			expect(data.result.repositories.length).toBe(1);
			expect(data.result.repositories[0].manifestStatus, "admin view carries manifestStatus = ready (matches root)")
				.toBe("ready");
		} finally {
			if (server) { try { await new Promise<void>((r) => server!.close(r)); } catch { /* ignore */ } }
			dispose(s);
		}
	});

	test("admin view manifestStatus === 'pending' on a fresh project (absent → pending)", async () => {
		const s = setup();
		let server: Server | null = null;
		try {
			const project = ensureProject(s, "admin-pending");

			// Do NOT call seedProjectManifestPending (that's fullIndex-only).
			// Use the production WikiService.update path to also verify absent→pending
			// visibility: actually, simplest is to NOT set manifest_status at all
			// and rely on absent → pending. ensureProject creates a project root with
			// only display_name attr — manifest_status absent → helper returns "pending".

			const row: WikiRepositoryRow = {
				repository_id: "repo-admin-pending",
				project_node_id: s.nodeRepo.getActiveByPath(project.projectPath)!.id,
				project_id: "admin-pending",
				source_root: "",
				default_branch: "main",
				sync_status: "synced",
				indexed_revision: "abc123",
				last_indexed_at: "2026-07-18T00:00:00.000Z",
				last_error: null,
			};
			const stubRepoStore = {
				addresses: { list: () => [] },
				repositories: {
					list: () => [row],
					getByProjectId: (id: string) => (id === "admin-pending" ? row : undefined),
					upsert: () => undefined,
					delete: () => undefined,
				},
			};
			const stubProjectStore = {
				get: (id: string) => (id === "admin-pending" ? { id, name: "Pending Proj", workspaceDir: "" } : undefined),
				list: () => [],
			};
			const stubGit = {
				isGitRepo: async () => false,
				resolveRevision: async () => null,
				detectDefaultBranch: async () => "main",
			};

			const app = express();
			app.use(express.json());
			app.use("/api/wiki-admin", createWikiAdminRouter({
				wikiService: s.svc,
				addressService: new WikiAddressService(s.repoStore.addresses, s.nodeRepo),
				indexer: {
					ensureBinding: async () => { throw new Error("not used"); },
					fullIndex: async () => { throw new Error("not used"); },
					sync: async () => { throw new Error("not used"); },
					rebuildFromScratch: async () => { throw new Error("not used"); },
				} as any,
				repositoryStore: stubRepoStore as any,
				auditRepo: new WikiAuditRepository(s.db),
				nodeRepo: s.nodeRepo,
				projectStore: stubProjectStore as any,
				agentService: {
					publishAgentWikiPolicy: async () => ({ newRevision: 1, affectedSessions: [] }),
					getAgentWikiPolicy: async () => ({ grants: [], policyRevision: 1 }),
				} as any,
				agentStore: { get: () => undefined, update: () => undefined, list: () => [], onChange: () => () => {} } as any,
				git: stubGit as any,
			}));

			server = createServer(app);
			await new Promise<void>((resolve) => {
				server!.listen(0, () => resolve());
			});
			const port = (server.address() as { port: number }).port;

			const resp = await fetch(`http://localhost:${port}/api/wiki-admin/repositories/list`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const data = await resp.json() as { ok: boolean; result: { repositories: Array<{ manifestStatus: string }> } };
			expect(data.result.repositories[0].manifestStatus, "admin view: absent → pending").toBe("pending");
		} finally {
			if (server) { try { await new Promise<void>((r) => server!.close(r)); } catch { /* ignore */ } }
			dispose(s);
		}
	});

	test("UI wiring: WikiProjectCard.tsx reads status.manifestStatus (badge + Row)", () => {
		// Grep-level wiring check (per spec: "full pixel E2E is out of scope for unit").
		// We assert the component file references status.manifestStatus in BOTH
		// the badge area AND a Row, so the binding is real (not a dangling type
		// field the UI never reads).
		const cardPath = join(process.cwd(), "src/renderer/components/requirements/WikiProjectCard.tsx");
		const src = readFileSync(cardPath, "utf-8");

		// Multiple references (≥ 3 = badge title/color/text + Row value/hint).
		const refs = (src.match(/status\.manifestStatus/g) ?? []).length;
		expect(refs, "WikiProjectCard must reference status.manifestStatus at least 3 times (badge + Row)")
			.toBeGreaterThanOrEqual(3);

		// Badge + Row specifically.
		expect(src, "manifest badge exists").toMatch(/manifest:\s*\{status\.manifestStatus\}/);
		expect(src, "Manifest Row label exists").toMatch(/label=["']Manifest["']/);

		// Hint table covers all three statuses.
		expect(src, "manifest hint table covers pending").toContain("pending:");
		expect(src, "manifest hint table covers partial").toContain("partial:");
		expect(src, "manifest hint table covers ready").toContain("ready:");
	});
});
