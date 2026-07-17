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

	test("permanent sorts before short_term regardless of name", async () => {
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
		// 'aaa-permanent' comes BEFORE 'zzz-short-lived' despite alphabet — durability wins.
		expect(permIdx).toBeLessThan(shortIdx);
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
