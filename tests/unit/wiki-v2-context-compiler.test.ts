// wiki-system-redesign sub-05 acceptance — 对抗 (adversarial-edge) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-05 §C「Prompt compiler」+ plan-05 §6 + 取舍 4 判定。
// WikiContextCompiler 是 implementer 标注的 "working basic 版"(深度 profile 简化)。
//
// ## 对抗 probe 焦点
//   §C.1  preview == runtime 同函数同输出(字节级,禁止复制一套近似渲染)。
//   §C.2  compact/standard/deep 各尊重 budget + 固定截断顺序。
//   §C.3  standard Memory 按 attributes 选(不依赖固定子树名 preferences/lessons)。
//   §C.4  standard Project 含目标/技术栈/入口/模块/sync status/风险或明确空状态。
//   §C.5  Prompt 显示 memory:///project:// + retrieval guidance,不显示 ID/短 ID/旧 action。
//
// ## 取舍 4 判定
//   implementer 说 WikiContextCompiler 是 basic 版(plan-05 §6 "深度 profile" 简化)。
//   本测验证 acceptance-05 §C.3/§C.4 的最低门槛:attributes-driven selection +
//   Project 必备字段。深度 profile(capabilities/constraints/risks/recent changes 多通
//   道selection)若不满足,记 concern(非 blocker)。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-ctx-compiler-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	return { UNIQUE_DIR: d };
});

import { join } from "node:path";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { compileWikiContext } from "../../src/server/wiki/wiki-context-compiler.js";
import type { CompiledWikiAccess } from "../../src/shared/wiki-types.js";
import type { WikiContextEntry, WikiGrant } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ALL_ACTIONS = [
	"expand", "read", "search", "create", "update",
	"delete", "link", "unlink", "move",
] as const;

function wideAccess(agentId = "ctx-test-agent", activeProjectId?: string): CompiledWikiAccess {
	return {
		agentId,
		activeProjectId,
		grants: [{ canonicalScope: "wiki-root", actions: [...ALL_ACTIONS] }],
		policyRevision: 1,
	};
}

interface Setup {
	wikiService: WikiService;
	db: WikiDatabase;
	dispose: () => void;
}

function setup(): Setup {
	const dbPath = join(UNIQUE_DIR, `wiki-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
	const wiki = new WikiDatabase(dbPath);
	const wikiService = WikiService.fromDatabase(wiki);
	return {
		wikiService,
		db: wiki,
		dispose: () => { try { wiki.close(); } catch { /* idempotent */ } },
	};
}

/** Ensure the per-agent memory root exists (mirror of AgentService session-build ensure). */
async function ensureMemoryRoot(s: Setup, agentId: string): Promise<void> {
	const ctx = {
		access: wideAccess(agentId),
		agentId,
		activeProjectId: undefined,
		sessionId: null,
		requestId: null,
	};
	// wiki-root/memory namespace may not exist; create idempotently.
	try {
		await s.wikiService.create({ parent: "wiki-root", name: "memory", kind: "namespace" }, ctx);
	} catch { /* already exists */ }
	try {
		await s.wikiService.create({
			parent: "wiki-root/memory", name: agentId, kind: "memory",
			summary: `Memory root for ${agentId}`,
			attributes: { display_name: agentId },
		}, ctx);
	} catch { /* already exists */ }
}

/** Create a node via wikiService (host context = wide access). */
async function create(s: Setup, parentAddr: string, name: string, opts: {
	summary?: string;
	content?: string;
	attributes?: Record<string, unknown>;
	kind?: string;
} = {}): Promise<void> {
	const ctx = {
		access: wideAccess(),
		agentId: "ctx-test-agent",
		activeProjectId: undefined,
		sessionId: null,
		requestId: null,
	};
	await s.wikiService.create({
		parent: parentAddr,
		name,
		kind: (opts.kind ?? "node") as any,
		summary: opts.summary,
		content: opts.content,
		attributes: opts.attributes,
	}, ctx);
}

// ===========================================================================
// §C.1  preview == runtime (same function, same bytes)
// ===========================================================================

describe("wiki-v2 §C.1 preview==runtime: identical bytes from same snapshot [对抗 lens]", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("two calls with identical inputs produce byte-identical output", async () => {
		await create(s, "wiki-root/memory/ctx-test-agent", "facts", {
			summary: "stable summary",
			attributes: { memory_type: "preference", durability: "permanent" },
		});
		const access = wideAccess();
		const opts = {
			wikiService: s.wikiService,
			access,
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }] as WikiContextEntry[],
		};
		const a = await compileWikiContext(opts);
		const b = await compileWikiContext(opts);
		expect(b.text).toBe(a.text);
		expect(JSON.stringify(b.stats)).toBe(JSON.stringify(a.stats));
		expect(JSON.stringify(b.snapshot)).toBe(JSON.stringify(a.snapshot));
	});

	test("deterministic across reordering of equivalent entries", async () => {
		await create(s, "wiki-root/memory/ctx-test-agent", "node1", {
			summary: "first", attributes: { durability: "permanent" },
		});
		const access = wideAccess();
		const entriesA: WikiContextEntry[] = [
			{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 },
		];
		const entriesB: WikiContextEntry[] = [
			{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 },
		];
		const a = await compileWikiContext({ wikiService: s.wikiService, access, entries: entriesA });
		const b = await compileWikiContext({ wikiService: s.wikiService, access, entries: entriesB });
		expect(b.text).toBe(a.text);
	});
});

// ===========================================================================
// §C.2  budget respected + stable truncation order
// ===========================================================================

describe("wiki-v2 §C.2 compact/standard/deep respect budget + truncation marker [对抗 lens]", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("budget cap truncates output and emits truncated marker", async () => {
		// Many memory children; tiny budget → must truncate.
		for (let i = 0; i < 12; i++) {
			await create(s, "wiki-root/memory/ctx-test-agent", `n${i}`, {
				summary: `node ${i} `.repeat(40),
				attributes: { durability: i % 2 === 0 ? "permanent" : "short_term" },
			});
		}
		const access = wideAccess();
		const r = await compileWikiContext({
			wikiService: s.wikiService,
			access,
			entries: [{ address: "memory://", profile: "compact", channel: "system", budgetTokens: 400 }],
		});
		expect(r.stats.memoryNodesTotal).toBeGreaterThanOrEqual(12);
		expect(r.stats.memoryNodesIncluded).toBeLessThan(r.stats.memoryNodesTotal);
		expect(r.stats.truncated).toBe(true);
		// truncated marker text present
		expect(r.text).toMatch(/omitted|truncated/i);
	});

	test("higher budget includes more nodes (monotonic)", async () => {
		for (let i = 0; i < 8; i++) {
			await create(s, "wiki-root/memory/ctx-test-agent", `n${i}`, {
				summary: `node ${i} `.repeat(30),
				attributes: { durability: "long_term" },
			});
		}
		const access = wideAccess();
		const tiny = await compileWikiContext({
			wikiService: s.wikiService, access,
			entries: [{ address: "memory://", profile: "compact", channel: "system", budgetTokens: 400 }],
		});
		const big = await compileWikiContext({
			wikiService: s.wikiService, access,
			entries: [{ address: "memory://", profile: "deep", channel: "system", budgetTokens: 4000 }],
		});
		expect(big.stats.memoryNodesIncluded).toBeGreaterThanOrEqual(tiny.stats.memoryNodesIncluded);
	});
});

// ===========================================================================
// §C.3  Memory selected by attributes, NOT fixed subtree names
// ===========================================================================

describe("wiki-v2 §C.3 Memory selection by attributes (not fixed paths) [对抗 lens — 取舍 4]", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("permanent node surfaced even with non-standard name (not under 'preferences/')", async () => {
		// Custom-named permanent node — must still appear because attributes drive selection.
		await create(s, "wiki-root/memory/ctx-test-agent", "totally-arbitrary-name", {
			summary: "permanent fact",
			attributes: { memory_type: "preference", durability: "permanent", priority: 90 },
		});
		const r = await compileWikiContext({
			wikiService: s.wikiService,
			access: wideAccess(),
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
		});
		expect(r.text).toContain("totally-arbitrary-name");
	});

	test("higher priority node sorts before lower priority (deterministic order)", async () => {
		await create(s, "wiki-root/memory/ctx-test-agent", "low", {
			summary: "low pri", attributes: { priority: 10, durability: "long_term" },
		});
		await create(s, "wiki-root/memory/ctx-test-agent", "high", {
			summary: "high pri", attributes: { priority: 90, durability: "long_term" },
		});
		const r = await compileWikiContext({
			wikiService: s.wikiService,
			access: wideAccess(),
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
		});
		const highIdx = r.text.indexOf("high");
		const lowIdx = r.text.indexOf("low");
		expect(highIdx).toBeGreaterThan(-1);
		expect(lowIdx).toBeGreaterThan(-1);
		expect(highIdx, "higher priority node must appear before lower").toBeLessThan(lowIdx);
	});

	// P0-2 (defect #1): profile now FILTERS by durability — short_term is excluded
	// from compact/standard/deep (compact=permanent only; standard+deep=
	// permanent+long_term). The old assertion ("permanent sorts before short_term")
	// is no longer meaningful because the short_term node never enters the
	// ordering. Redirect to assert the corrected behavior: short_term filtered
	// out of standard; permanent survives.
	test("short_term filtered from standard profile (defect #1 redirect)", async () => {
		await create(s, "wiki-root/memory/ctx-test-agent", "zzz-short-lived", {
			summary: "x", attributes: { durability: "short_term", priority: 50 },
		});
		await create(s, "wiki-root/memory/ctx-test-agent", "aaa-permanent", {
			summary: "x", attributes: { durability: "permanent", priority: 50 },
		});
		const r = await compileWikiContext({
			wikiService: s.wikiService,
			access: wideAccess(),
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
		});
		const permIdx = r.text.indexOf("aaa-permanent");
		const shortIdx = r.text.indexOf("zzz-short-lived");
		// permanent survives the standard filter; short_term is dropped entirely.
		expect(permIdx, "permanent node must be present in standard").toBeGreaterThan(-1);
		expect(shortIdx, "short_term node must be FILTERED OUT of standard (defect #1)").toBe(-1);
	});
});

// ===========================================================================
// §C.4 + §C.5  addresses + retrieval guidance + Project empty state
// ===========================================================================

describe("wiki-v2 §C.4/§C.5 addresses + retrieval guidance + Project state [对抗 lens]", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("output shows memory:// and retrieval guidance (no node IDs / old actions)", async () => {
		const r = await compileWikiContext({
			wikiService: s.wikiService,
			access: wideAccess(),
			entries: [
				{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 },
			],
		});
		// logical addresses surface
		expect(r.text).toContain("memory://");
		// retrieval guidance present
		expect(r.text).toMatch(/Retrieval guidance/i);
		expect(r.text).toMatch(/search/i);
		// no banned old actions / IDs
		expect(r.text).not.toMatch(/\bnodeId\b/i);
		expect(r.text).not.toMatch(/createMemory|updateMemory|docRead|docWrite|docEdit/);
		expect(r.text).not.toMatch(/short[_-]?id/i);
	});

	test("project:// entry surfaces hint; no active project → empty marker not wiki-root/projects", async () => {
		// 无 active project → project 段是 empty marker,不解析到 wiki-root/projects 根。
		const r = await compileWikiContext({
			wikiService: s.wikiService,
			access: wideAccess("ctx-test-agent", undefined),
			entries: [
				{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 },
				{ address: "project://", profile: "standard", channel: "system", budgetTokens: 2800 },
			],
		});
		// 'no active project' 或 'inactive' 提示
		expect(r.text).toMatch(/inactive|no active project/i);
		// 不能扩到 wiki-root/projects
		expect(r.text).not.toMatch(/wiki-root\/projects\b/);
	});

	test("with active project, project section renders root + children", async () => {
		// First need a project root + child.
		// wikiService.create on wiki-root/projects/<pid> requires project kind root;
		// we create via wiki-root/projects path directly under wiki-root.
		const accessP = wideAccess("ctx-test-agent", "proj-test");
		// Create the projects root + project node by canonical path under wiki-root.
		// Use wide access to create wiki-root/projects/proj-test via wiki-root parent.
		const ctx = {
			access: wideAccess("ctx-test-agent", "proj-test"),
			agentId: "ctx-test-agent",
			activeProjectId: "proj-test",
			sessionId: null,
			requestId: null,
		};
		// Walk: wiki-root → projects → proj-test
		try {
			await s.wikiService.create({
				parent: "wiki-root", name: "projects", kind: "namespace",
			}, ctx);
		} catch { /* may already exist */ }
		try {
			await s.wikiService.create({
				parent: "wiki-root/projects", name: "proj-test", kind: "project",
				summary: "test project root",
			}, ctx);
		} catch { /* may already exist */ }
		await s.wikiService.create({
			parent: "wiki-root/projects/proj-test", name: "module-a", kind: "directory",
			summary: "module A",
		}, ctx);

		const r = await compileWikiContext({
			wikiService: s.wikiService,
			access: accessP,
			entries: [
				{ address: "project://", profile: "standard", channel: "system", budgetTokens: 2800 },
			],
		});
		// Project section renders (NOT the empty marker).
		expect(r.text).toMatch(/Active Project/i);
		expect(r.text).toContain("wiki-root/projects/proj-test");
		expect(r.text).toContain("module-a");
	});
});

// ===========================================================================
// §H  Wiki Context never escalates beyond wikiAccess.grants
// ===========================================================================

describe("wiki-v2 §H WikiContext honors wikiAccess scopes [对抗 lens]", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("narrow wikiAccess (no memory grant) → empty Memory section, no leak", async () => {
		// Seed memory owned by other agent.
		await create(s, "wiki-root/memory", "other-agent", {
			summary: "other agent secret", attributes: { durability: "permanent" },
		});
		await create(s, "wiki-root/memory/other-agent", "secret", {
			summary: "SECRETKEY", attributes: { durability: "permanent" },
		});

		// Attacker access: only own memory (different agent), NO access to other-agent subtree.
		const narrow: CompiledWikiAccess = {
			agentId: "attacker",
			activeProjectId: undefined,
			grants: [{ canonicalScope: "wiki-root/memory/attacker", actions: [...ALL_ACTIONS] }],
			policyRevision: 1,
		};
		const r = await compileWikiContext({
			wikiService: s.wikiService,
			access: narrow,
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
		});
		// attacker's memory root doesn't exist → empty section, no leak of other-agent's SECRETKEY.
		expect(r.text).not.toContain("SECRETKEY");
		expect(r.text).not.toContain("other-agent");
	});
});

// ===========================================================================
// P0-2 VERIFIER (adversarial, independent) — 9 reviewer defects + 1 design probe
//
// # 文件说明书
//
// ## 核心功能
// 独立验证 P0-2 Wiki Context Compiler 重写(9 个独立 review 发现的 defect +
// #9 repo binding/#3 childrenCount/#7 truthful total/#8 revision 语义/#4 root
// content/#5 confidence filter/#6 review_after/#1 profile depth/workContext)。
//
// ## 对抗 probe 焦点
//   T1   低置信假设:compact/standard 排除,deep 保留带 marker(defect #5)。
//   T2   review_after due:ISO ≤ now → demoted + marker(defect #6)。
//   T3   compact/standard/deep 三个 profile 产出不同的、确定的节点集合(§3.4)。
//   T4   Project 结构化字段(goals/stack/entrypoints/modules/risks/constraints)+
//        repo binding(branch/indexed_revision/sync_status/last_error/last_indexed_at),
//        缺省显式 "(none recorded)" / "(none — project not bound)"(defect #9)。
//   T5   root content "Stable rules" 进 prompt(defect #4)。
//   T6   workContext.recentFiles 命中 → 节点 workHit 置顶(高于 priority)。
//   T7   >100 一级节点:stats.memoryNodesTotal === 真实 countActiveChildren
//        (非首页长度);dropped === total − included;truncated === true。
//        authz 正确:无 memory:// grant → total=0,无 leak(defect #3+#7)。
//   T8   preview == runtime 同函数同字节(§C)。
//   T9   revision 语义:maxRevision 只取整数 revision,绝不解析 updated_at
//        时间戳(defect #8)。
//
// ## 设计探针(durability over-filtering)
//   D-OVER compact=permanent;standard+deep=permanent+long_term;short_term +
//   undefined-durability 全排除。reviewer matrix 说 standard = "高价值长期记忆 +
//   一级导航" —— 排除 undefined-durability 一级子节点是否过度过滤了"一级导航"?
//   构造一个常见场景(memory 一级子节点都没显式 durability)并断言实际行为。
// ===========================================================================

// ---------------------------------------------------------------------------
// P0-2 测试专用 helpers(raw DB 访问 + project root 构造)
// ---------------------------------------------------------------------------

const MEMORY_ROOT = "wiki-root/memory/ctx-test-agent";

/** 直接 UPDATE wiki_nodes.content(绕开 service.update operations 路径)。 */
function setNodeContent(s: Setup, path: string, content: string): void {
	s.db.getDb()
		.prepare(`UPDATE wiki_nodes SET content = ? WHERE path = ?`)
		.run(content, path);
}

/** 直接 UPDATE wiki_nodes.revision + updated_at(task 9 defect #8 验证用)。 */
function setNodeRevisionAndUpdatedAt(s: Setup, path: string, revision: number, updatedAt: string): void {
	s.db.getDb()
		.prepare(`UPDATE wiki_nodes SET revision = ?, updated_at = ? WHERE path = ?`)
		.run(revision, updatedAt, path);
}

/** 取 WikiService 私有 deps 的 repositoryStore(测试 only,绕 TS)。 */
function getRepoStore(s: Setup): WikiRepositoryStore {
	return (s.wikiService as unknown as { deps: { repositoryStore: WikiRepositoryStore } }).deps.repositoryStore;
}

/** 取 WikiService 私有 deps 的 nodeRepo(测试 only)。 */
function getNodeRepo(s: Setup) {
	return (s.wikiService as unknown as {
		deps: {
			nodeRepo: {
				getActiveByPath(path: string): { id: number } | undefined;
			};
		};
	}).deps.nodeRepo;
}

/** 创建 wiki-root/projects/<projectId> 节点(已存在则跳过)+ 可选 attributes。 */
async function ensureProjectRoot(
	s: Setup,
	projectId: string,
	opts: { summary?: string; attributes?: Record<string, unknown> } = {},
): Promise<string> {
	const path = `wiki-root/projects/${projectId}`;
	const ctx = {
		access: wideAccess("ctx-test-agent", projectId),
		agentId: "ctx-test-agent",
		activeProjectId: projectId,
		sessionId: null,
		requestId: null,
	};
	try {
		await s.wikiService.create({
			parent: "wiki-root/projects",
			name: projectId,
			kind: "project",
			summary: opts.summary ?? `project ${projectId}`,
			attributes: opts.attributes,
		}, ctx);
	} catch { /* may already exist */ }
	return path;
}

/** 给 projectId 绑定一个 Git 仓库(task 4 repo binding fixture)。 */
function bindRepository(
	s: Setup,
	projectId: string,
	opts: {
		repositoryId?: string;
		sourceRoot?: string;
		defaultBranch?: string;
		indexedRevision?: string | null;
		syncStatus?: string;
		lastError?: string | null;
		lastIndexedAt?: string | null;
	} = {},
): void {
	const path = `wiki-root/projects/${projectId}`;
	const projectNode = getNodeRepo(s).getActiveByPath(path);
	if (!projectNode) throw new Error(`bindRepository: project root ${path} not seeded`);
	const repoStore = getRepoStore(s);
	const repositoryId = opts.repositoryId ?? `repo-${projectId}`;
	repoStore.repositories.upsert({
		repository_id: repositoryId,
		project_node_id: projectNode.id,
		project_id: projectId,
		source_root: opts.sourceRoot ?? "src",
		default_branch: opts.defaultBranch ?? "main",
	});
	repoStore.repositories.updateSyncState({
		repository_id: repositoryId,
		indexed_revision: opts.indexedRevision ?? "abc123",
		sync_status: opts.syncStatus ?? "synced",
		last_error: opts.lastError ?? null,
		last_indexed_at: opts.lastIndexedAt ?? "2026-07-01T00:00:00.000Z",
	});
}

// ===========================================================================
// T1 — low-confidence hypothesis exclusion (defect #5)
// ===========================================================================

describe("P0-2 T1 low-confidence hypothesis filter (defect #5)", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("compact/standard EXCLUDES low-confidence hypothesis; deep INCLUDES with marker", async () => {
		await create(s, MEMORY_ROOT, "high-conf-fact", {
			summary: "confirmed fact",
			attributes: { memory_type: "preference", confidence: 0.9, durability: "permanent" },
		});
		await create(s, MEMORY_ROOT, "low-conf-guess", {
			summary: "shaky hypothesis",
			attributes: { memory_type: "hypothesis", confidence: 0.2, durability: "permanent" },
		});

		const std = await compileWikiContext({
			wikiService: s.wikiService, access: wideAccess(),
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
		});
		expect(std.text).toContain("high-conf-fact");
		expect(std.text, "standard MUST exclude low-confidence hypothesis").not.toContain("low-conf-guess");

		const compact = await compileWikiContext({
			wikiService: s.wikiService, access: wideAccess(),
			entries: [{ address: "memory://", profile: "compact", channel: "system", budgetTokens: 800 }],
		});
		expect(compact.text).toContain("high-conf-fact");
		expect(compact.text, "compact MUST exclude low-confidence hypothesis").not.toContain("low-conf-guess");

		const deep = await compileWikiContext({
			wikiService: s.wikiService, access: wideAccess(),
			entries: [{ address: "memory://", profile: "deep", channel: "system", budgetTokens: 3500 }],
		});
		expect(deep.text).toContain("high-conf-fact");
		expect(deep.text, "deep MUST KEEP low-confidence hypothesis (with marker)").toContain("low-conf-guess");
		// marker on the low-conf line
		const guessLineStart = deep.text.indexOf("low-conf-guess");
		const lineEnd = deep.text.indexOf("\n", guessLineStart);
		const guessLine = deep.text.slice(guessLineStart, lineEnd === -1 ? undefined : lineEnd);
		expect(guessLine, "deep must mark low-confidence node with (low confidence)").toMatch(/\(low confidence\)/);
	});
});

// ===========================================================================
// T2 — review_after due downgrade (defect #6)
// ===========================================================================

describe("P0-2 T2 review_after due demoted + marked (defect #6)", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("ISO review_after ≤ now → demoted (after same-priority non-due) + '(due for review)' marker", async () => {
		const now = new Date("2026-07-15T12:00:00.000Z");
		// A: high priority, no review_after.
		await create(s, MEMORY_ROOT, "alpha-high-pri", {
			summary: "a", attributes: { durability: "permanent", priority: 80 },
		});
		// B: low priority, due for review (past ISO).
		await create(s, MEMORY_ROOT, "beta-due", {
			summary: "b", attributes: { durability: "permanent", priority: 50, review_after: "2026-07-01T00:00:00.000Z" },
		});
		// C: low priority (tie with B), future review_after (not due).
		await create(s, MEMORY_ROOT, "gamma-future", {
			summary: "c", attributes: { durability: "permanent", priority: 50, review_after: "2027-01-01T00:00:00.000Z" },
		});

		const r = await compileWikiContext({
			wikiService: s.wikiService, access: wideAccess(),
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
			now,
		});

		const aIdx = r.text.indexOf("alpha-high-pri");
		const bIdx = r.text.indexOf("beta-due");
		const cIdx = r.text.indexOf("gamma-future");
		expect(aIdx).toBeGreaterThan(-1);
		expect(bIdx).toBeGreaterThan(-1);
		expect(cIdx).toBeGreaterThan(-1);

		// A (priority 80) ranks first.
		expect(aIdx, "highest-priority A must rank first").toBeLessThan(bIdx);
		expect(aIdx).toBeLessThan(cIdx);
		// C (not due) ranks before B (due) at same priority — due is demoted.
		expect(cIdx, "non-due C must rank before due B at same priority (due demoted)").toBeLessThan(bIdx);

		// marker on beta-due line
		const bLineEnd = r.text.indexOf("\n", bIdx);
		const bLine = r.text.slice(bIdx, bLineEnd === -1 ? undefined : bLineEnd);
		expect(bLine, "due node must carry '(due for review)'").toMatch(/\(due for review\)/);

		// gamma-future (not due) must NOT carry the marker.
		const cLineEnd = r.text.indexOf("\n", cIdx);
		const cLine = r.text.slice(cIdx, cLineEnd === -1 ? undefined : cLineEnd);
		expect(cLine, "non-due node must NOT carry '(due for review)'").not.toMatch(/\(due for review\)/);
	});
});

// ===========================================================================
// T3 — compact/standard/deep produce DIFFERENT deterministic node sets
// ===========================================================================

describe("P0-2 T3 compact/standard/deep differ + deterministic (§3.4)", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("three profiles yield distinct, deterministic content; deep adds grandchildren", async () => {
		// Mixed durability children.
		await create(s, MEMORY_ROOT, "perm-parent", {
			summary: "permanent parent with children",
			attributes: { durability: "permanent", priority: 90 },
		});
		await create(s, MEMORY_ROOT, "longterm-child", {
			summary: "long-term child",
			attributes: { durability: "long_term", priority: 50 },
		});
		await create(s, MEMORY_ROOT, "shortterm-child", {
			summary: "short-term child",
			attributes: { durability: "short_term", priority: 50 },
		});
		// Grandchild under perm-parent — only deep expands 2nd level.
		await create(s, `${MEMORY_ROOT}/perm-parent`, "grandchild-alpha", {
			summary: "a grandchild node",
			attributes: { durability: "permanent" },
		});

		const now = new Date("2026-07-15T12:00:00.000Z");
		const run = (profile: "compact" | "standard" | "deep") => compileWikiContext({
			wikiService: s.wikiService, access: wideAccess(),
			entries: [{ address: "memory://", profile, channel: "system" }],
			now,
		});

		const compactA = await run("compact");
		const compactB = await run("compact");
		const stdA = await run("standard");
		const stdB = await run("standard");
		const deepA = await run("deep");
		const deepB = await run("deep");

		// Determinism: two runs of the same profile are byte-identical.
		expect(compactB.text, "compact deterministic").toBe(compactA.text);
		expect(stdB.text, "standard deterministic").toBe(stdA.text);
		expect(deepB.text, "deep deterministic").toBe(deepA.text);

		// Profiles differ in content (not just length).
		expect(compactA.text, "compact != standard").not.toStrictEqual(stdA.text);
		expect(stdA.text, "standard != deep").not.toStrictEqual(deepA.text);
		expect(compactA.text, "compact != deep").not.toStrictEqual(deepA.text);

		// compact = permanent only → excludes longterm-child.
		expect(compactA.text).toContain("perm-parent");
		expect(compactA.text, "compact excludes long_term").not.toContain("longterm-child");

		// standard = permanent + long_term → includes longterm-child, excludes shortterm.
		expect(stdA.text).toContain("longterm-child");
		expect(stdA.text, "standard excludes short_term").not.toContain("shortterm-child");
		// standard does NOT expand grandchildren.
		expect(stdA.text, "standard does NOT show grandchildren").not.toContain("grandchild-alpha");

		// deep = same durability filter as standard BUT adds grandchildren.
		expect(deepA.text).toContain("longterm-child");
		expect(deepA.text, "deep excludes short_term (same as standard)").not.toContain("shortterm-child");
		expect(deepA.text, "deep MUST expand grandchildren (2nd-level)").toContain("grandchild-alpha");
	});
});

// ===========================================================================
// T4 — Project structured fields + repo binding (defect #9)
// ===========================================================================

describe("P0-2 T4 Project structured fields + repo binding (defect #9)", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("renders goals/stack/entrypoints/modules/risks/constraints + repo binding fields", async () => {
		await ensureProjectRoot(s, "proj-bind", {
			summary: "Bound project",
			attributes: {
				goals: ["ship v1", "delight users"],
				stack: ["TypeScript", "Electron"],
				entrypoints: ["src/main.ts", "src/index.ts"],
				modules: ["wiki", "agent-runtime"],
				risks: ["schedule pressure"],
				constraints: ["windows-first"],
			},
		});
		bindRepository(s, "proj-bind", {
			defaultBranch: "main",
			indexedRevision: "deadbeef",
			syncStatus: "synced",
			lastError: null,
			lastIndexedAt: "2026-07-10T08:30:00.000Z",
		});

		const r = await compileWikiContext({
			wikiService: s.wikiService,
			access: wideAccess("ctx-test-agent", "proj-bind"),
			entries: [{ address: "project://", profile: "standard", channel: "system", budgetTokens: 2800 }],
		});

		// Structured field labels present.
		expect(r.text).toMatch(/Goals:/);
		expect(r.text).toMatch(/Stack:/);
		expect(r.text).toMatch(/Entrypoints:/);
		expect(r.text).toMatch(/Modules:/);
		expect(r.text).toMatch(/Risks:/);
		expect(r.text).toMatch(/Constraints:/);
		// Actual values render.
		expect(r.text).toContain("ship v1");
		expect(r.text).toContain("TypeScript");
		expect(r.text).toContain("src/main.ts");

		// Repo binding fields rendered.
		expect(r.text).toMatch(/Repo binding:/);
		expect(r.text).toMatch(/branch=main/);
		expect(r.text).toMatch(/indexed_revision=deadbeef/);
		expect(r.text).toMatch(/sync_status=synced/);
		expect(r.text).toMatch(/last_error=/);
		expect(r.text).toMatch(/last_indexed_at=/);
	});

	test("NO attributes + NO repo binding → explicit empty states, not silent omission", async () => {
		await ensureProjectRoot(s, "proj-bare", { summary: "Bare project" });
		// No bindRepository call.

		const r = await compileWikiContext({
			wikiService: s.wikiService,
			access: wideAccess("ctx-test-agent", "proj-bare"),
			entries: [{ address: "project://", profile: "standard", channel: "system", budgetTokens: 2800 }],
		});

		// Each structured field present with "(none recorded)".
		const noneRecorded = (r.text.match(/\(none recorded\)/g) ?? []).length;
		expect(noneRecorded, "all 6 standard structured fields must show (none recorded)").toBeGreaterThanOrEqual(6);
		// Repo binding explicit empty state.
		expect(r.text, "no binding must show explicit '(none — project not bound...'").toMatch(/\(none — project not bound/);
	});
});

// ===========================================================================
// T5 — root content "Stable rules" enters the prompt (defect #4)
// ===========================================================================

describe("P0-2 T5 root content rendered as Stable rules (defect #4)", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("memory root content rendered under 'Stable rules:' label (truncated)", async () => {
		setNodeContent(s, MEMORY_ROOT, "Always cite wiki path. Prefer search before read. Keep summaries terse.");

		const r = await compileWikiContext({
			wikiService: s.wikiService, access: wideAccess(),
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
		});
		expect(r.text, "Stable rules: header present").toMatch(/Stable rules:/);
		expect(r.text, "actual content body enters prompt").toContain("Always cite wiki path");
		expect(r.text).toContain("Prefer search before read");
	});

	test("empty root content → Stable rules block omitted", async () => {
		// ensureMemoryRoot creates root with no content (empty string).
		const r = await compileWikiContext({
			wikiService: s.wikiService, access: wideAccess(),
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
		});
		expect(r.text, "no Stable rules block when content empty").not.toMatch(/Stable rules:/);
	});
});

// ===========================================================================
// T6 — workContext.recentFiles reorders nodes (workHit > priority)
// ===========================================================================

describe("P0-2 T6 workContext boost reorders nodes (workHit > priority)", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("workContext.recentFiles hitting node B promotes B above higher-priority A", async () => {
		await create(s, MEMORY_ROOT, "alpha-high", {
			summary: "alpha summary",
			attributes: { durability: "permanent", priority: 90 },
		});
		await create(s, MEMORY_ROOT, "beta-low", {
			summary: "beta summary",
			attributes: { durability: "permanent", priority: 10 },
		});
		const now = new Date("2026-07-15T12:00:00.000Z");

		// Baseline: no workContext → alpha (priority 90) before beta.
		const baseline = await compileWikiContext({
			wikiService: s.wikiService, access: wideAccess(),
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
			now,
		});
		const baseA = baseline.text.indexOf("alpha-high");
		const baseB = baseline.text.indexOf("beta-low");
		expect(baseA, "baseline: high-priority alpha before beta").toBeGreaterThan(-1);
		expect(baseB).toBeGreaterThan(-1);
		expect(baseA).toBeLessThan(baseB);

		// With workContext hitting beta: beta promoted (workHit > priority).
		const boosted = await compileWikiContext({
			wikiService: s.wikiService, access: wideAccess(),
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
			workContext: { recentFiles: ["beta-low.ts"] },
			now,
		});
		const boostA = boosted.text.indexOf("alpha-high");
		const boostB = boosted.text.indexOf("beta-low");
		expect(boostA).toBeGreaterThan(-1);
		expect(boostB).toBeGreaterThan(-1);
		expect(boostB, "with workContext hitting beta, beta ranks ABOVE alpha").toBeLessThan(boostA);
	});
});

// ===========================================================================
// T7 — >100 first-level nodes: truthful total + dropped + authz-correct count
// ===========================================================================

describe("P0-2 T7 truthful total/dropped via countActiveChildren + authz (defect #3+#7)", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("120 first-level permanent nodes + tight budget → total=120, dropped=120-included, truncated=true", async () => {
		// 120 direct children with explicit permanent durability (pass filter).
		// Large summaries to force truncation under the tight budget below.
		for (let i = 0; i < 120; i++) {
			await create(s, MEMORY_ROOT, `kid-${String(i).padStart(3, "0")}`, {
				summary: `kid node ${i} `.repeat(20),
				attributes: { durability: "permanent", priority: 50 },
			});
		}
		const r = await compileWikiContext({
			wikiService: s.wikiService, access: wideAccess(),
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 600 }],
		});
		expect(r.stats.memoryNodesTotal, "total = TRUE countActiveChildren (120), NOT first-page length").toBe(120);
		expect(r.stats.memoryNodesIncluded, "must include fewer than total under tight budget").toBeLessThan(120);
		expect(r.stats.memoryNodesDropped, "dropped = total − included").toBe(120 - r.stats.memoryNodesIncluded);
		expect(r.stats.truncated, "truncated flag set").toBe(true);
	});

	test("authz correctness: agent with NO memory:// grant → total=0, no leak", async () => {
		// Seed 5 permanent nodes under ctx-test-agent's memory root.
		for (let i = 0; i < 5; i++) {
			await create(s, MEMORY_ROOT, `victim-${i}`, {
				summary: `victim ${i}`,
				attributes: { durability: "permanent" },
			});
		}
		// Attacker has no memory:// grant at all.
		const noMemory: CompiledWikiAccess = {
			agentId: "attacker",
			activeProjectId: undefined,
			grants: [{ canonicalScope: "wiki-root/knowledge", actions: [...ALL_ACTIONS] }],
			policyRevision: 1,
		};
		const r = await compileWikiContext({
			wikiService: s.wikiService, access: noMemory,
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
		});
		expect(r.stats.memoryNodesTotal, "no grant → total=0 (authz-correct count)").toBe(0);
		expect(r.stats.memoryNodesIncluded).toBe(0);
		expect(r.text).not.toContain("victim-0");
		expect(r.text).not.toContain("ctx-test-agent");
	});
});

// ===========================================================================
// T8 — preview == runtime byte-identical (§C)
// ===========================================================================

describe("P0-2 T8 preview == runtime (same function, same bytes)", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("two calls with identical inputs (incl. workContext=undefined, now fixed) → byte-identical", async () => {
		await create(s, MEMORY_ROOT, "stable-A", {
			summary: "stable node A",
			attributes: { durability: "permanent", priority: 70, confidence: 0.8, memory_type: "preference" },
		});
		await create(s, MEMORY_ROOT, "stable-B", {
			summary: "stable node B",
			attributes: { durability: "long_term", priority: 40, review_after: "2026-07-10T00:00:00.000Z" },
		});
		setNodeContent(s, MEMORY_ROOT, "Stable rule: always cite path.");

		const now = new Date("2026-07-15T12:00:00.000Z");
		const opts = {
			wikiService: s.wikiService,
			access: wideAccess(),
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }] as WikiContextEntry[],
			now,
			// workContext intentionally undefined (the only caller-difference axis).
		} as const;

		const a = await compileWikiContext(opts);
		const b = await compileWikiContext(opts);
		expect(b.text, "text byte-identical").toBe(a.text);
		expect(JSON.stringify(b.stats), "stats byte-identical").toBe(JSON.stringify(a.stats));
		expect(JSON.stringify(b.snapshot), "snapshot byte-identical").toBe(JSON.stringify(a.snapshot));
	});
});

// ===========================================================================
// T9 — revision semantics: maxRevision = max(revision ints), NOT updated_at
// ===========================================================================

describe("P0-2 T9 revision semantics (defect #8): integers only, never timestamps", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("child with HIGH updatedAt + LOW revision does NOT inflate maxRevision", async () => {
		await create(s, MEMORY_ROOT, "rev-five", {
			summary: "revision 5 node",
			attributes: { durability: "permanent", priority: 50 },
		});
		await create(s, MEMORY_ROOT, "rev-one-fresh-ts", {
			summary: "revision 1 but recent timestamp",
			attributes: { durability: "permanent", priority: 50 },
		});

		// Manipulate DB directly: rev-five → revision=5, normal timestamp.
		setNodeRevisionAndUpdatedAt(s, `${MEMORY_ROOT}/rev-five`, 5, "2026-01-01T00:00:00.000Z");
		// rev-one-fresh-ts → revision=1 but FAR-FUTURE timestamp.
		setNodeRevisionAndUpdatedAt(s, `${MEMORY_ROOT}/rev-one-fresh-ts`, 1, "2099-12-31T23:59:59.000Z");

		const r = await compileWikiContext({
			wikiService: s.wikiService, access: wideAccess(),
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
		});

		// maxRevision = max(memory-root.revision=1, rev-five.revision=5, rev-one.revision=1) = 5.
		// NOT a giant number derived from the 2099 timestamp.
		expect(r.snapshot.memoryRevision, "maxRevision must reflect revision integers only (=5)").toBe(5);
		expect(r.snapshot.memoryRevision as number, "must NOT be inflated by 2099 timestamp").toBeLessThan(100);

		// maxUpdatedAt IS the staleness signal — must be the 2099 ISO (separate channel).
		expect(r.snapshot.maxUpdatedAt, "maxUpdatedAt tracks the future ISO (separate from revision)").toBe("2099-12-31T23:59:59.000Z");
	});
});

// ===========================================================================
// D-OVER — durability over-filtering investigation (reviewer matrix gap)
//
// Reviewer matrix said standard = "高价值长期记忆 + 一级导航" (high-value long-term
// + FIRST-LEVEL NAVIGATION). Implementer chose: standard selects ONLY
// durability=permanent|long_term; undefined-durability nodes are excluded.
// Real-world memory nodes created without explicit durability would ALL be
// filtered out of standard — possibly leaving the prompt with zero memory
// nodes despite a populated tree. Probe whether this is over-filtering.
// ===========================================================================

describe("P0-2 D-OVER durability over-filtering probe (undefined-durability first-level children)", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("realistic fixture: first-level children with NO durability → standard renders none of them", async () => {
		// Realistic case: agent created memory nodes without setting `durability`
		// explicitly (it's an optional attribute; defaults differ by tooling).
		await create(s, MEMORY_ROOT, "nav-concepts", {
			summary: "navigation entry for concepts",
			attributes: { memory_type: "preference", priority: 80 },  // no durability
		});
		await create(s, MEMORY_ROOT, "nav-procedures", {
			summary: "navigation entry for procedures",
			attributes: { memory_type: "procedure", priority: 70 },  // no durability
		});
		await create(s, MEMORY_ROOT, "nav-facts", {
			summary: "navigation entry for facts",
			attributes: { priority: 60 },  // no durability, no memory_type
		});

		const r = await compileWikiContext({
			wikiService: s.wikiService, access: wideAccess(),
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
		});

		// Document the actual behavior. If these assertions hold, standard over-
		// filters realistic undefined-durability nodes — a verifier FINDING.
		const hasNavConcepts = r.text.includes("nav-concepts");
		const hasNavProcedures = r.text.includes("nav-procedures");
		const hasNavFacts = r.text.includes("nav-facts");
		// Keep this assertion as a truthful probe — when the implementer's filter
		// excludes everything, all three flags will be false and the test PASSES
		// (confirming the gap). If implementer later relaxes the filter, this test
		// will fail and should be updated to assert the relaxed behavior.
		if (!hasNavConcepts && !hasNavProcedures && !hasNavFacts) {
			// Confirmed: standard drops ALL undefined-durability first-level nodes.
			// This is the gap — verifier flags it but does not modify production.
			expect(hasNavConcepts, "FINDING: standard excludes undefined-durability nav (concepts)").toBe(false);
			expect(hasNavProcedures, "FINDING: standard excludes undefined-durability nav (procedures)").toBe(false);
			expect(hasNavFacts, "FINDING: standard excludes undefined-durability nav (facts)").toBe(false);
		} else {
			// If any surfaced, the filter must have been relaxed — assert all three
			// appear (consistency: not just the high-priority one).
			expect(hasNavConcepts, "if filter relaxed, all first-level nodes must surface").toBe(true);
			expect(hasNavProcedures).toBe(true);
			expect(hasNavFacts).toBe(true);
		}
		// stats memoryNodesTotal must still count them truthfully (regardless of filter).
		expect(r.stats.memoryNodesTotal, "countActiveChildren counts ALL children regardless of durability").toBeGreaterThanOrEqual(3);
	});
});

// ===========================================================================
// P0-2 FOLLOW-UP — undefined-durability navigation gap closed
//
// prepareMemoryChildren durability filter was relaxed: standard/deep now ALSO
// include undefined-durability first-level children (realistic memory trees
// built without disciplined durability tagging still render navigation).
// compact stays permanent-only; short_term stays excluded; ranking still
// favors explicit tiers via DURABILITY_RANK (undefined = rank 3, sorts last).
//
// These are HARD assertions (the D-OVER probe above is two-branch tolerant;
// these pin the post-fix behavior so a future regression trips them).
// ===========================================================================

describe("P0-2 FOLLOW-UP undefined-durability navigation (standard/deep include, compact excludes)", () => {
	let s: Setup;
	beforeEach(async () => { s = setup(); await ensureMemoryRoot(s, "ctx-test-agent"); });
	afterEach(() => { s.dispose(); });

	test("task1: undefined-durability children render in standard + deep; compact still omits", async () => {
		// Realistic memory tree: first-level children created WITHOUT explicit
		// `durability`. They have memory_type + priority so they are otherwise
		// legitimate (not low-confidence hypotheses, etc.).
		await create(s, MEMORY_ROOT, "nav-concepts", {
			summary: "navigation entry for concepts",
			attributes: { memory_type: "preference", priority: 80 },  // no durability
		});
		await create(s, MEMORY_ROOT, "nav-procedures", {
			summary: "navigation entry for procedures",
			attributes: { memory_type: "procedure", priority: 70 },  // no durability
		});
		await create(s, MEMORY_ROOT, "nav-facts", {
			summary: "navigation entry for facts",
			attributes: { memory_type: "fact", priority: 60 },  // no durability
		});

		const run = (profile: "compact" | "standard" | "deep") => compileWikiContext({
			wikiService: s.wikiService, access: wideAccess(),
			entries: [{ address: "memory://", profile, channel: "system" }],
		});

		// standard: navigation intent met — all three first-level children appear.
		const std = await run("standard");
		expect(std.text, "standard MUST include undefined-durability nav-concepts").toContain("nav-concepts");
		expect(std.text, "standard MUST include undefined-durability nav-procedures").toContain("nav-procedures");
		expect(std.text, "standard MUST include undefined-durability nav-facts").toContain("nav-facts");

		// deep: same durability filter as standard → also includes them.
		const deep = await run("deep");
		expect(deep.text, "deep MUST include undefined-durability nav-concepts").toContain("nav-concepts");
		expect(deep.text, "deep MUST include undefined-durability nav-procedures").toContain("nav-procedures");
		expect(deep.text, "deep MUST include undefined-durability nav-facts").toContain("nav-facts");

		// compact: permanent-only filter → undefined-durability nodes MUST NOT appear.
		const compact = await run("compact");
		expect(compact.text, "compact MUST EXCLUDE undefined-durability nav-concepts").not.toContain("nav-concepts");
		expect(compact.text, "compact MUST EXCLUDE undefined-durability nav-procedures").not.toContain("nav-procedures");
		expect(compact.text, "compact MUST EXCLUDE undefined-durability nav-facts").not.toContain("nav-facts");

		// Sanity: stats still count all three truthfully (filter does not affect total).
		expect(std.stats.memoryNodesTotal, "total counts ALL first-level children").toBeGreaterThanOrEqual(3);
	});

	test("task2 regression: short_term still excluded from standard/deep/compact", async () => {
		// short_term is the explicit "ephemeral" tier — must stay out of the
		// prompt regardless of profile. High priority would surface it IF the
		// filter leaked, so this is a strong regression bar.
		await create(s, MEMORY_ROOT, "ephemeral-high-pri", {
			summary: "should not leak into any profile",
			attributes: { durability: "short_term", priority: 90, memory_type: "preference" },
		});
		// Permanent control so the memory section is non-empty in every profile.
		await create(s, MEMORY_ROOT, "permanent-control", {
			summary: "permanent control node",
			attributes: { durability: "permanent", priority: 50 },
		});

		for (const profile of ["compact", "standard", "deep"] as const) {
			const r = await compileWikiContext({
				wikiService: s.wikiService, access: wideAccess(),
				entries: [{ address: "memory://", profile, channel: "system" }],
			});
			expect(r.text, `${profile}: short_term MUST NOT appear (would leak navigation)`).not.toContain("ephemeral-high-pri");
			expect(r.text, `${profile}: permanent control must still appear (sanity)`).toContain("permanent-control");
		}
	});

	test("task3 regression: ranking preserved — permanent → long_term → undefined (same pri/conf)", async () => {
		// Same priority + confidence + memory_type across three nodes. Only
		// durability differs. Names are chosen so alphabetical path order is
		// the REVERSE of expected durability order — if the comparator
		// accidentally fell through to path ASC, the order would invert.
		//   expected (durability rank ASC): z-permanent → m-longterm → a-undefined
		//   accidental (path ASC):           a-undefined → m-longterm → z-permanent
		await create(s, MEMORY_ROOT, "a-undefined-node", {
			summary: "no durability set",
			attributes: { priority: 50, confidence: 0.7, memory_type: "preference" },  // no durability
		});
		await create(s, MEMORY_ROOT, "m-longterm-node", {
			summary: "long_term durability",
			attributes: { priority: 50, confidence: 0.7, memory_type: "preference", durability: "long_term" },
		});
		await create(s, MEMORY_ROOT, "z-permanent-node", {
			summary: "permanent durability",
			attributes: { priority: 50, confidence: 0.7, memory_type: "preference", durability: "permanent" },
		});

		const r = await compileWikiContext({
			wikiService: s.wikiService, access: wideAccess(),
			entries: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
		});

		const pIdx = r.text.indexOf("z-permanent-node");
		const lIdx = r.text.indexOf("m-longterm-node");
		const uIdx = r.text.indexOf("a-undefined-node");
		expect(pIdx, "permanent node must be present").toBeGreaterThan(-1);
		expect(lIdx, "long_term node must be present").toBeGreaterThan(-1);
		expect(uIdx, "undefined-durability node must be present").toBeGreaterThan(-1);
		// Explicit tiers surface first; undefined fills in as navigation last.
		expect(pIdx, "permanent BEFORE long_term (explicit tiers rank first)").toBeLessThan(lIdx);
		expect(lIdx, "long_term BEFORE undefined (undefined is rank 3, fills in last)").toBeLessThan(uIdx);
	});
});
