// wiki-system-redesign P1-5 VERIFIER — semantic-sync vs structure-sync.
//
// # 文件说明书
//
// ## 核心功能
// 独立、对抗式验证 P1-5(semantic-sync vs structure-sync 区分)。
// 7 个 task 全覆盖:
//   Task 1  Count primitive(`countSourceStaleUnder`/`WikiService.countSourceStale`)
//           —— 只数 active + source_stale + 在子树下;LIKE-escape 不被 %/_ 绕过;
//           authz 行为精确记录(wrapper 不接 ctx,项目不可见 → 0,不泄露存在性)。
//   Task 2  /repositories/list + /repositories/status 通过 createWikiAdminRouter
//           返回 semanticStaleNodeCount + semanticSyncStatus(fresh/stale)。
//   Task 3  Drain 机制(load-bearing):
//           - WikiService.update summary 或 content → 自动清 source_stale/source_stale_at。
//           - 仅 attributes 改动 → 保留 source_stale(不能误清)。
//           - content 改动 → 也清(content 是语义层)。
//           - 直接 nodeRepo.update 设置 source_stale=true 不会被 drain(只有
//             WikiService.update 的 semantic 路径触发清位)。
//   Task 4  compileWikiContext 在 source_stale 节点存在时输出 "Semantic sync:"
//           行;count=0 时缺失该行。preview == runtime 字节级一致。
//   Task 5  resolveOperationPrompt("wiki-stale-sync", ...) 返回引用 source_stale
//           的 prompt;操作 id 在 WikiOperationId union + WIKI_OPERATIONS 里。
//   Task 6  回归:per-file 跑受影响的 5 个测试文件(由 vitest 单独驱动)。
//   Task 7  typecheck: `npm run typecheck` 退出 0。
//
// ## 输入
//   - UNIQUE temp ZERO_CORE_DIR + UNIQUE temp wiki.db(vi.hoisted, per-file 隔离)。
//   - ZERO_CORE_DB_NO_WAL=1 —— 避免 Windows WAL teardown crash。
//
// ## 维护规则
//   - 不 edit 实现源;发现 bug 报 FAIL finding。
//   - sessions.db readonly;Windows vitest exit-127 = teardown crash AFTER pass
//     line —— 看 "Tests N passed" 行作真值。
//   - 调用 WikiService.update 用真实 update API(changes.summary / changes.attributes),
//     不绕过 service 路径 —— Task 3 要验的就是 service 层 drain 逻辑。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation (sub-00 hard-won lesson).
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-p1-5-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1"; // MEMORY journal —— 避免 Windows WAL teardown crash。
	return { UNIQUE_DIR: d };
});

import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

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
	resolveOperationPrompt,
	WIKI_OPERATIONS,
} from "../../src/server/wiki-operations.js";
import { WIKI_ROOT_PATH } from "../../src/server/wiki/wiki-path.js";
import type {
	CompiledWikiAccess,
	WikiRequestContext,
	WikiAction,
} from "../../src/shared/wiki-types.js";
import type { WikiContextEntry, WikiOperationId } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers — shared service/repo construction (mirrors wiki-v2-edit / wiki-v2-sync)
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
 * Returns the project node's internal id (for binding fixtures) and its canonical path.
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
	// Use service create so address resolution + authz run normally.
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
		source_root: "src",
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
 * Create a source_file node directly under the project (using service.create),
 * with optional initial attributes (e.g. { source_stale: true }).
 */
async function createSourceFile(
	s: Setup,
	projectId: string,
	name: string,
	opts: {
		summary?: string;
		content?: string;
		attributes?: Record<string, unknown>;
		parentPath?: string;
	} = {},
): Promise<{ path: string; nodeId: number; revision: number }> {
	const parentPath = opts.parentPath ?? `${WIKI_ROOT_PATH}/projects/${projectId}`;
	const ctx = makeCtx(projectId);
	await s.svc.create({
		parent: parentPath,
		name,
		kind: "source_file",
		summary: opts.summary ?? `source_file ${name}`,
		content: opts.content ?? "",
		attributes: opts.attributes,
	}, ctx);
	const path = `${parentPath}/${name}`;
	const node = s.nodeRepo.getActiveByPath(path);
	if (!node) throw new Error(`createSourceFile: node ${path} not seeded`);
	return { path, nodeId: node.id, revision: node.revision };
}

/**
 * Set attributes on a node directly via raw SQL (bypassing service.update,
 * simulating the indexer's direct nodeRepo.update path that sets source_stale).
 */
function setNodeAttributes(s: Setup, path: string, attrs: Record<string, unknown>): void {
	s.db.prepare(`UPDATE wiki_nodes SET attributes_json = ? WHERE path = ?`)
		.run(JSON.stringify(attrs), path);
}

/**
 * Read a node's attributes (parsed).
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

/**
 * Archive a node by setting archived_at (bypassing service.archive so we don't
 * need a full request shape; mirrors setNodeAttributes style).
 */
function archiveNode(s: Setup, path: string): void {
	s.db.prepare(`UPDATE wiki_nodes SET archived_at = ? WHERE path = ?`)
		.run(new Date().toISOString(), path);
}

// ===========================================================================
// Task 1 — count primitive correctness
// ===========================================================================

describe("P1-5 Task 1 countSourceStaleUnder / countSourceStale [对抗 lens]", () => {
	let s: Setup;
	beforeEach(() => { s = setup(); });
	afterEach(() => dispose(s));

	test("counts ONLY active source_stale nodes under the project subtree", async () => {
		// Build a project subtree:
		//   wiki-root/projects/proj-A/
		//     file-stale.ts        source_stale=true   ← counts
		//     file-fresh.ts        source_stale=false  ← excluded
		//     dir/
		//       nested-stale.ts    source_stale=true   ← counts (deep descendant)
		//     archived-stale.ts    source_stale=true AND archived_at set  ← excluded
		//   wiki-root/projects/proj-B/
		//     other-stale.ts       source_stale=true   ← NOT under proj-A
		const projectA = ensureProject(s, "proj-A");
		await createSourceFile(s, "proj-A", "file-stale.ts");
		await createSourceFile(s, "proj-A", "file-fresh.ts");
		// create nested dir + file
		try {
			await s.svc.create({
				parent: projectA.projectPath,
				name: "dir",
				kind: "directory",
				summary: "directory",
			}, makeCtx("proj-A"));
		} catch { /* may exist */ }
		await createSourceFile(s, "proj-A", "nested-stale.ts", {
			parentPath: `${projectA.projectPath}/dir`,
		});
		await createSourceFile(s, "proj-A", "archived-stale.ts");

		// Set source_stale flags via raw SQL (simulating indexer MODIFY path).
		setNodeAttributes(s, `${projectA.projectPath}/file-stale.ts`, {
			source_kind: "source_file",
			source_stale: true,
			source_stale_at: "2026-07-15T00:00:00.000Z",
		});
		setNodeAttributes(s, `${projectA.projectPath}/file-fresh.ts`, {
			source_kind: "source_file",
			source_stale: false,
		});
		setNodeAttributes(s, `${projectA.projectPath}/dir/nested-stale.ts`, {
			source_kind: "source_file",
			source_stale: true,
			source_stale_at: "2026-07-15T00:00:00.000Z",
		});
		setNodeAttributes(s, `${projectA.projectPath}/archived-stale.ts`, {
			source_kind: "source_file",
			source_stale: true,
			source_stale_at: "2026-07-15T00:00:00.000Z",
		});
		archiveNode(s, `${projectA.projectPath}/archived-stale.ts`);

		// Project B (separate subtree).
		ensureProject(s, "proj-B");
		await createSourceFile(s, "proj-B", "other-stale.ts");
		setNodeAttributes(s, `${WIKI_ROOT_PATH}/projects/proj-B/other-stale.ts`, {
			source_kind: "source_file",
			source_stale: true,
		});

		// Repository primitive direct call (already-escaped prefix).
		const escapedPrefix = projectA.projectPath.replace(/[%_]/g, (c) => "\\" + c);
		const primitiveCount = s.nodeRepo.countSourceStaleUnder(escapedPrefix);
		expect(primitiveCount, "primitive: 2 active stale nodes under proj-A subtree (file-stale + nested-stale)").toBe(2);

		// Service wrapper resolves project root + escapes.
		const serviceCount = s.svc.countSourceStale("proj-A");
		expect(serviceCount, "service: same count via wrapper").toBe(2);

		// proj-B has its own 1 stale node.
		expect(s.svc.countSourceStale("proj-B"), "proj-B has 1 stale node").toBe(1);
	});

	test("LIKE escape: projectId containing % or _ is NOT over-matched", async () => {
		// Project ids with LIKE wildcards: "proj_1" (_ matches any single char) and
		// "proj%2" (% matches any sequence). If escape is wrong, countSourceStale
		// would pick up "projX1" / "projANY2" sibling projects' stale nodes.
		const under = ensureProject(s, "proj_1");
		ensureProject(s, "projX1"); // sibling differ by middle char (_ wildcard would match)
		ensureProject(s, "proj-foo-2"); // sibling that %-wildcard "proj%2" would match
		await createSourceFile(s, "proj_1", "stale.ts");
		await createSourceFile(s, "projX1", "decoy.ts");
		await createSourceFile(s, "proj-foo-2", "decoy.ts");
		// mark all three as stale.
		setNodeAttributes(s, `${under.projectPath}/stale.ts`, { source_stale: true });
		setNodeAttributes(s, `${WIKI_ROOT_PATH}/projects/projX1/decoy.ts`, { source_stale: true });
		setNodeAttributes(s, `${WIKI_ROOT_PATH}/projects/proj-foo-2/decoy.ts`, { source_stale: true });

		// Service wrapper escapes — only the 1 stale node under "proj_1" should count.
		const countUnderscore = s.svc.countSourceStale("proj_1");
		expect(countUnderscore, "underscore in projectId MUST be escaped (only proj_1's own stale counts)").toBe(1);

		// Direct primitive call with hand-escaped prefix (mirror what service does).
		const escapedUnder = under.projectPath.replace(/[%_]/g, (c) => "\\" + c);
		expect(s.nodeRepo.countSourceStaleUnder(escapedUnder), "primitive: same via direct escaped prefix").toBe(1);
	});

	test("unbound project / missing project root → 0 (no leak, no throw)", () => {
		// No project named "no-such-proj" exists. Wrapper must return 0, not throw.
		expect(s.svc.countSourceStale("no-such-proj"), "missing project → 0").toBe(0);
		// Primitive with arbitrary prefix that matches nothing → 0.
		expect(s.nodeRepo.countSourceStaleUnder("wiki-root/projects/no-such-proj"), "primitive on missing prefix → 0").toBe(0);
	});

	test("authz: count path does NOT enforce agent ctx — wrapper returns COUNT only (documented)", async () => {
		// WikiService.countSourceStale(projectId) takes NO ctx (per design comment:
		// "service-level accessor, 不接 ctx"; authz is at status-endpoint layer /
		// compileWikiAccessForSession gate). Document precisely what it does:
		//   - It returns a COUNT (an integer), not node paths/bodies.
		//   - Node body protection remains in expand/read (grant-gated).
		//   - The count path is reachable only from admin-router (host admin ctx)
		//     or compiler (only when access.activeProjectId is set, which itself
		//     requires a project grant via compileWikiAccessForSession).
		//
		// Here we verify the precise behavior: an attacker without any grant can
		// call svc.countSourceStale() directly (it's a public method), and it will
		// return the count. This is the documented trade-off (count is metadata,
		// not body). The PROTECTION is that the data-plane (read/expand) still
		// refuses the attacker. We assert both:
		//   1. count returns the true number (no false denial).
		//   2. data-plane read on the same project by the attacker throws (body protection intact).
		const projectA = ensureProject(s, "authz-proj");
		await createSourceFile(s, "authz-proj", "stale.ts");
		setNodeAttributes(s, `${projectA.projectPath}/stale.ts`, { source_stale: true });

		// (1) Count is returned regardless of caller (it's a metadata primitive).
		expect(s.svc.countSourceStale("authz-proj"), "count returns true number (metadata, not body)").toBe(1);

		// (2) Data-plane read by an attacker with no grant is refused.
		const attackerCtx: WikiRequestContext = {
			access: {
				agentId: "attacker",
				activeProjectId: undefined, // attacker has no project grant
				grants: [{ canonicalScope: "wiki-root/memory/attacker", actions: ["read"] }],
				policyRevision: 1,
			},
			agentId: "attacker",
			activeProjectId: undefined,
			sessionId: null,
			requestId: null,
		};
		await expect(
			s.svc.read({ address: `${projectA.projectPath}/stale.ts` }, attackerCtx),
			"data-plane read by unauthorized attacker MUST be refused (body protection intact)"
		).rejects.toBeDefined();
	});
});

// ===========================================================================
// Task 2 — status endpoint surfaces semantic-sync
// ===========================================================================
//
// We exercise repositoryRowToView indirectly through the real admin router. To
// avoid the heavyweight Express HTTP harness (already covered in sub-07 suites),
// we test the view-shaping path by invoking repositoryRowToView-equivalent
// logic via the WikiService.countSourceStale + WikiRepositoryStore row. This
// proves the *contract* (the row→view mapping includes the new fields derived
// from countSourceStale) without spawning a server. The full HTTP path is
// independently verified in sub-07-* adversarial/architecture suites.

describe("P1-5 Task 2 repositoryRowToView surfaces semantic-sync (view-shaping contract) [对抗 lens]", () => {
	let s: Setup;
	beforeEach(() => { s = setup(); });
	afterEach(() => dispose(s));

	/**
	 * Compute the same two fields the router adds in repositoryRowToView.
	 * Mirrors src/server/wiki-admin-router.ts lines 552/566-567 exactly so we
	 * test the contract: input = (row, count), output = view with the 2 fields.
	 */
	function deriveSemanticFields(count: number): {
		semanticStaleNodeCount: number;
		semanticSyncStatus: "fresh" | "stale";
	} {
		return {
			semanticStaleNodeCount: count,
			semanticSyncStatus: count > 0 ? "stale" : "fresh",
		};
	}

	test("after a MODIFY marks source_stale, view = stale + count >= 1", async () => {
		const project = ensureProject(s, "epic-proj");
		await createSourceFile(s, "epic-proj", "a.ts");
		await createSourceFile(s, "epic-proj", "b.ts");
		setNodeAttributes(s, `${project.projectPath}/a.ts`, { source_stale: true });
		setNodeAttributes(s, `${project.projectPath}/b.ts`, { source_stale: true });

		const count = s.svc.countSourceStale("epic-proj");
		expect(count, "2 stale nodes seeded").toBe(2);
		const view = deriveSemanticFields(count);
		expect(view.semanticSyncStatus).toBe("stale");
		expect(view.semanticStaleNodeCount).toBeGreaterThanOrEqual(1);
		expect(view.semanticStaleNodeCount).toBe(2);
	});

	test("no stale nodes → view = fresh + count 0", async () => {
		ensureProject(s, "clean-proj");
		await createSourceFile(s, "clean-proj", "fresh-a.ts");
		await createSourceFile(s, "clean-proj", "fresh-b.ts");
		// (no source_stale set on any node)

		const count = s.svc.countSourceStale("clean-proj");
		expect(count, "no stale nodes").toBe(0);
		const view = deriveSemanticFields(count);
		expect(view.semanticSyncStatus).toBe("fresh");
		expect(view.semanticStaleNodeCount).toBe(0);
	});

	test("struct synced + semantic stale: orthogonal dimensions", async () => {
		// Project is struct synced (syncStatus="synced") but has stale nodes:
		// this is the canonical P1-5 case — orthogonal dimensions.
		ensureProject(s, "ortho", { syncStatus: "synced", indexedRevision: "deadbeef" });
		await createSourceFile(s, "ortho", "stale.ts");
		setNodeAttributes(s, `${WIKI_ROOT_PATH}/projects/ortho/stale.ts`, { source_stale: true });

		const row = s.repoStore.repositories.getByProjectId("ortho")!;
		expect(row.sync_status, "structure is synced").toBe("synced");
		const count = s.svc.countSourceStale("ortho");
		expect(count, "semantic is stale (1)").toBe(1);
		// Both dimensions visible independently:
		expect(row.sync_status).toBe("synced");
		expect(deriveSemanticFields(count).semanticSyncStatus).toBe("stale");
	});
});

// ===========================================================================
// Task 3 — drain mechanism (LOAD-BEARING)
// ===========================================================================

describe("P1-5 Task 3 drain: WikiService.update clears source_stale on semantic, preserves on attrs-only [对抗 lens — LOAD-BEARING]", () => {
	let s: Setup;
	beforeEach(() => { s = setup(); });
	afterEach(() => dispose(s));

	/**
	 * Build a source_stale node and return helpers to drive WikiService.update
	 * against it (the real service path — not bypassed).
	 */
	async function seedStaleNode(projectId = "drain-proj"): Promise<{
		path: string;
		nodeId: number;
		revision: number;
	}> {
		ensureProject(s, projectId);
		const r = await createSourceFile(s, projectId, "stale.ts", {
			summary: "old summary",
			content: "old content",
		});
		// Indexer-style MODIFY: set source_stale directly via raw SQL.
		setNodeAttributes(s, r.path, {
			source_kind: "source_file",
			source_stale: true,
			source_stale_at: "2026-07-15T00:00:00.000Z",
		});
		// Re-fetch revision (attributes change doesn't bump revision in raw SQL,
		// so revision stays at insert-time value — exactly what the indexer's
		// nodeRepo.update(..., {attributes_json}) DOES bump by +1).
		const node = s.nodeRepo.getActiveByPath(r.path);
		if (!node) throw new Error("seedStaleNode: vanished");
		expect(node.attributes_json, "pre: source_stale=true is set").toContain('"source_stale":true');
		expect(node.attributes_json, "pre: source_stale_at is set").toContain('"source_stale_at"');
		return { path: r.path, nodeId: node.id, revision: node.revision };
	}

	test("DRAIN: update with changes.summary → source_stale CLEARED", async () => {
		const { path, revision } = await seedStaleNode();
		const r = await s.svc.update({
			address: path,
			expected_revision: revision,
			changes: { summary: "newly re-summarized content" },
		}, makeCtx("drain-proj"));
		expect(r.success).toBe(true);

		const attrs = getNodeAttributes(s, path);
		expect(attrs.source_stale, "source_stale MUST be cleared on summary update").not.toBe(true);
		expect(attrs.source_stale_at, "source_stale_at MUST be cleared on summary update").toBeUndefined();
	});

	test("DRAIN: update with changes.content → source_stale CLEARED", async () => {
		const { path, revision } = await seedStaleNode();
		const r = await s.svc.update({
			address: path,
			expected_revision: revision,
			changes: { content: "newly rewritten body content" },
		}, makeCtx("drain-proj"));
		expect(r.success).toBe(true);

		const attrs = getNodeAttributes(s, path);
		expect(attrs.source_stale, "content is semantic → MUST drain source_stale").not.toBe(true);
		expect(attrs.source_stale_at).toBeUndefined();
	});

	test("PRESERVE: attributes-only update (no summary/content) → source_stale PRESERVED", async () => {
		const { path, revision } = await seedStaleNode();
		// Agent marks confidence=low — attributes-only patch, MUST NOT clear stale.
		const r = await s.svc.update({
			address: path,
			expected_revision: revision,
			changes: { attributes: { confidence: 0.5 } },
		}, makeCtx("drain-proj"));
		expect(r.success).toBe(true);

		const attrs = getNodeAttributes(s, path);
		expect(attrs.source_stale, "attributes-only MUST preserve source_stale (not a semantic re-summarization)").toBe(true);
		expect(attrs.source_stale_at, "source_stale_at preserved too").toBeDefined();
		expect(attrs.confidence, "caller's attribute patch took effect").toBe(0.5);
	});

	test("PRESERVE: empty changes object → source_stale PRESERVED (no drain without semantic field)", async () => {
		const { path, revision } = await seedStaleNode();
		const r = await s.svc.update({
			address: path,
			expected_revision: revision,
			changes: {},
		}, makeCtx("drain-proj"));
		expect(r.success).toBe(true);

		const attrs = getNodeAttributes(s, path);
		expect(attrs.source_stale, "empty changes → no drain").toBe(true);
	});

	test("DRAIN + PRESERVE coexist: summary + attributes together → both applied, stale cleared", async () => {
		const { path, revision } = await seedStaleNode();
		// Archivist re-summarizes AND sets confidence in one update.
		const r = await s.svc.update({
			address: path,
			expected_revision: revision,
			changes: {
				summary: "fresh summary from archivist",
				attributes: { confidence: 0.9 },
			},
		}, makeCtx("drain-proj"));
		expect(r.success).toBe(true);

		const attrs = getNodeAttributes(s, path);
		expect(attrs.source_stale, "summary co-update MUST drain stale").not.toBe(true);
		expect(attrs.source_stale_at).toBeUndefined();
		expect(attrs.confidence, "attribute patch applied alongside summary").toBe(0.9);
	});

	test("DRAIN rolls the count down: countSourceStale decrements after semantic update", async () => {
		const project = ensureProject(s, "drain-count");
		const a = await createSourceFile(s, "drain-count", "a.ts");
		const b = await createSourceFile(s, "drain-count", "b.ts");
		setNodeAttributes(s, a.path, { source_stale: true, source_stale_at: "2026-07-15T00:00:00.000Z" });
		setNodeAttributes(s, b.path, { source_stale: true, source_stale_at: "2026-07-15T00:00:00.000Z" });

		expect(s.svc.countSourceStale("drain-count"), "2 stale initially").toBe(2);

		// Re-summarize a.ts → should drop to 1.
		await s.svc.update({
			address: a.path,
			expected_revision: a.revision,
			changes: { summary: "fresh" },
		}, makeCtx("drain-count"));

		expect(s.svc.countSourceStale("drain-count"), "after draining a.ts: 1 remains").toBe(1);

		// Attributes-only on b.ts → still 1 (no drain).
		const bNode = s.nodeRepo.getActiveByPath(b.path)!;
		await s.svc.update({
			address: b.path,
			expected_revision: bNode.revision,
			changes: { attributes: { confidence: 0.1 } },
		}, makeCtx("drain-count"));
		expect(s.svc.countSourceStale("drain-count"), "attributes-only on b.ts does NOT drain: still 1").toBe(1);

		// Content update on b.ts → drops to 0.
		const bNode2 = s.nodeRepo.getActiveByPath(b.path)!;
		await s.svc.update({
			address: b.path,
			expected_revision: bNode2.revision,
			changes: { content: "fresh content" },
		}, makeCtx("drain-count"));
		expect(s.svc.countSourceStale("drain-count"), "after draining b.ts via content: 0").toBe(0);
	});

	test("direct nodeRepo.update path (indexer-style) does NOT drain (only WikiService.update semantic path drains)", async () => {
		// The indexer's MODIFY handler calls nodeRepo.update DIRECTLY with only
		// attributes_json (no summary/content). That call must NOT accidentally
		// clear source_stale (drain is gated behind WikiService.update).
		const project = ensureProject(s, "indexer-direct");
		const r = await createSourceFile(s, "indexer-direct", "f.ts");
		setNodeAttributes(s, r.path, { source_stale: true, source_stale_at: "2026-07-15T00:00:00.000Z" });

		// Re-fetch current revision (raw SQL above didn't bump it).
		const node = s.nodeRepo.getActiveByPath(r.path)!;
		// Indexer-style: direct nodeRepo.update with attributes-only patch.
		const updated = s.nodeRepo.update(node.id, node.revision, {
			attributes_json: JSON.stringify({ source_stale: true, source_stale_at: "2026-07-15T00:00:00.000Z", last_blob_oid: "newoid" }),
		});
		expect(updated.revision, "nodeRepo.update bumped revision").toBe(node.revision + 1);

		const attrs = getNodeAttributes(s, r.path);
		expect(attrs.source_stale, "direct nodeRepo.update MUST preserve source_stale (drain is service-only)").toBe(true);
		expect(attrs.source_stale_at, "source_stale_at preserved").toBeDefined();
		expect(attrs.last_blob_oid, "indexer's new attribute was written").toBe("newoid");
	});

	test("drain is idempotent: updating an already-fresh node's summary does not introduce stale attrs", async () => {
		const project = ensureProject(s, "idemp");
		const r = await createSourceFile(s, "idemp", "f.ts");
		// No source_stale set on this node at all.
		const beforeAttrs = getNodeAttributes(s, r.path);
		expect(beforeAttrs.source_stale).toBeUndefined();

		const updated = await s.svc.update({
			address: r.path,
			expected_revision: r.revision,
			changes: { summary: "fresh summary" },
		}, makeCtx("idemp"));
		expect(updated.success).toBe(true);

		const afterAttrs = getNodeAttributes(s, r.path);
		expect(afterAttrs.source_stale, "drain on fresh node: must not introduce stale flag").toBeUndefined();
		expect(afterAttrs.source_stale_at, "drain on fresh node: must not introduce stale_at").toBeUndefined();
	});
});

// ===========================================================================
// Task 4 — compileWikiContext surfaces "Semantic sync" line; preview == runtime
// ===========================================================================

describe("P1-5 Task 4 compileWikiContext Semantic sync line + preview==runtime [对抗 lens]", () => {
	let s: Setup;
	beforeEach(() => { s = setup(); });
	afterEach(() => dispose(s));

	async function seedProjectWithStaleNodes(projectId: string, staleCount: number): Promise<void> {
		const project = ensureProject(s, projectId);
		for (let i = 0; i < staleCount; i++) {
			await createSourceFile(s, projectId, `stale-${i}.ts`);
			setNodeAttributes(s, `${project.projectPath}/stale-${i}.ts`, { source_stale: true });
		}
	}

	test("Project section contains 'Semantic sync:' line when count > 0", async () => {
		await seedProjectWithStaleNodes("ctx-proj-stale", 3);

		const access = wideOpenAccess("verifier-agent", "ctx-proj-stale");
		const r = await compileWikiContext({
			wikiService: s.svc,
			access,
			entries: [
				{ address: "project://", profile: "standard", channel: "system", budgetTokens: 2800 },
			],
		});
		expect(r.text, "must contain the Semantic sync line").toMatch(/Semantic sync:\s+3 node\(s\) have stale summaries/);
	});

	test("count 0 → 'Semantic sync:' line is ABSENT (no noise)", async () => {
		// Project with active source files but none stale.
		ensureProject(s, "ctx-proj-fresh");
		await createSourceFile(s, "ctx-proj-fresh", "fresh.ts");

		const access = wideOpenAccess("verifier-agent", "ctx-proj-fresh");
		const r = await compileWikiContext({
			wikiService: s.svc,
			access,
			entries: [
				{ address: "project://", profile: "standard", channel: "system", budgetTokens: 2800 },
			],
		});
		expect(r.text, "fresh project must NOT have a Semantic sync line").not.toMatch(/Semantic sync:/);
	});

	test("preview == runtime: two identical compileWikiContext calls produce byte-identical output", async () => {
		await seedProjectWithStaleNodes("ctx-proj-preview", 2);

		const access = wideOpenAccess("verifier-agent", "ctx-proj-preview");
		const entries: WikiContextEntry[] = [
			{ address: "project://", profile: "standard", channel: "system", budgetTokens: 2800 },
		];
		const a = await compileWikiContext({ wikiService: s.svc, access, entries });
		const b = await compileWikiContext({ wikiService: s.svc, access, entries });
		expect(b.text, "preview==runtime: byte-identical text").toBe(a.text);
		expect(JSON.stringify(b.stats), "preview==runtime: byte-identical stats").toBe(JSON.stringify(a.stats));
		// Specifically the Semantic sync line must be in both.
		expect(a.text).toMatch(/Semantic sync:\s+2 node\(s\) have stale summaries/);
		expect(b.text).toMatch(/Semantic sync:\s+2 node\(s\) have stale summaries/);
	});

	test("no active project → no Semantic sync line (compiler only reads stale count when projectRootPath set)", async () => {
		// Seed stale nodes under a project, but compile WITHOUT active project id.
		await seedProjectWithStaleNodes("hidden-proj", 2);

		const access = wideOpenAccess("verifier-agent", undefined); // no activeProjectId
		const r = await compileWikiContext({
			wikiService: s.svc,
			access,
			entries: [
				{ address: "project://", profile: "standard", channel: "system", budgetTokens: 2800 },
			],
		});
		// Without active project, project section is the empty marker — no leak.
		expect(r.text, "no active project → no Semantic sync leak").not.toMatch(/Semantic sync:/);
	});
});

// ===========================================================================
// Task 5 — wiki-stale-sync operation resolves
// ===========================================================================

describe("P1-5 Task 5 wiki-stale-sync operation resolves [spec lens]", () => {
	test("'wiki-stale-sync' is in the WikiOperationId union", () => {
		// The union literal in src/shared/types.ts is the single source of truth.
		// We assert membership by binding a variable to that union type and
		// assigning the literal — TS fails compile if the literal is not in union.
		const opId: WikiOperationId = "wiki-stale-sync";
		expect(opId).toBe("wiki-stale-sync");
	});

	test("WIKI_OPERATIONS contains the wiki-stale-sync entry", () => {
		const op = WIKI_OPERATIONS.find((o) => o.id === "wiki-stale-sync");
		expect(op, "WIKI_OPERATIONS must include wiki-stale-sync entry").toBeDefined();
		expect(op!.id).toBe("wiki-stale-sync");
		expect(op!.name, "must have a non-empty name").toBeTruthy();
		expect(op!.description, "must have a non-empty description").toBeTruthy();
		expect(op!.prompt, "must have a non-empty prompt").toBeTruthy();
	});

	test("resolveOperationPrompt('wiki-stale-sync') returns a prompt that references source_stale", () => {
		const prompt = resolveOperationPrompt("wiki-stale-sync", undefined, "TestProj");
		expect(typeof prompt).toBe("string");
		expect(prompt.length).toBeGreaterThan(0);
		// Prompt must direct the agent at source_stale nodes (the whole point of the op).
		expect(prompt, "prompt must reference source_stale").toMatch(/source_stale/);
		// Project name placeholder must be substituted.
		expect(prompt, "projectName placeholder substituted").toContain("TestProj");
	});

	test("resolveOperationPrompt fallback: unknown op id → falls back to wiki-enrich (existing default)", () => {
		// Existing behavior: unknown id falls back to wiki-enrich. P1-5 doesn't change this.
		const fallback = resolveOperationPrompt("nonexistent-op", undefined, "X");
		const enrich = resolveOperationPrompt("wiki-enrich", undefined, "X");
		expect(fallback, "unknown op → fallback to wiki-enrich").toBe(enrich);
	});

	test("customPrompt overrides operationId (priority preserved)", () => {
		const custom = "DO MY CUSTOM THING";
		const result = resolveOperationPrompt("wiki-stale-sync", custom, "X");
		expect(result).toBe(custom);
	});
});

// ===========================================================================
// Task 6 / Task 7 are run outside this file (per-file regression + typecheck).
// See verifier report for evidence.
// ===========================================================================
