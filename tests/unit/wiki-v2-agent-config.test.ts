// wiki-system-redesign sub-05 acceptance — 对抗 (adversarial-edge) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-05 §A「Agent 配置与生命周期」:
//   §A.1  wikiGrants/wikiContext/wikiPolicyRevision create/update/list round-trip。
//   §A.2  fresh DB agents 表含新列 (snake_case 一致性)。
//   §H    列名 camelCase / snake_case 错位陷阱 (AGENT_COLUMNS vs safeAddColumn)。
//
// ## 对抗 probe 焦点
//   - AGENT_COLUMNS { key:"wikiGrants", json:true } (无 column 派生)
//     vs safeAddColumn("wiki_grants") 一致性 — 用 fresh DB round-trip 验,
//     防止 SqliteStore 写入 camelCase 列、读出 snake_case 列导致 NULL 丢失。
//   - JSON 列 round-trip (数组 + 嵌套对象 + null 语义)。
//   - policyRevision 自增持久化 (publish 后 +1 落盘)。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-agent-config-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	return { UNIQUE_DIR: d };
});

import { join } from "node:path";

import { CoreDatabase } from "../../src/server/core-database.js";
import { AgentStore } from "../../src/server/agent-store.js";
import type { WikiGrant, WikiContextEntry } from "../../src/shared/types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function openFreshCoreDb(): CoreDatabase {
	const path = join(UNIQUE_DIR, `core-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
	return new CoreDatabase(path);
}

const grants: WikiGrant[] = [
	{ scope: "memory://", actions: ["read", "search"] },
	{ scope: "project://", actions: ["read"] },
];
const context: WikiContextEntry[] = [
	{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 },
	{ address: "project://", profile: "compact", channel: "system", budgetTokens: 1200 },
];

// ===========================================================================
// §A.1  wikiGrants / wikiContext / wikiPolicyRevision round-trip
// ===========================================================================

describe("wiki-v2 §A.1 wikiGrants/wikiContext/policyRevision round-trip [对抗 lens]", () => {
	let db: CoreDatabase;
	let store: AgentStore;
	beforeEach(() => {
		db = openFreshCoreDb();
		store = new AgentStore(db);
	});
	afterEach(() => { try { db.close(); } catch { /* idempotent */ } });

	test("create with wikiGrants + wikiContext + policyRevision → read back equal", () => {
		const created = store.create({
			name: "rt-agent",
			providerName: "mock", modelId: "m",
			wikiGrants: grants,
			wikiContext: context,
			wikiPolicyRevision: 7,
		} as any);
		const got = store.get(created.id);
		expect(got).toBeDefined();
		expect(got!.wikiGrants).toEqual(grants);
		expect(got!.wikiContext).toEqual(context);
		expect(got!.wikiPolicyRevision).toBe(7);
	});

	test("update agent's wikiGrants replaces prior value", () => {
		const created = store.create({
			name: "upd-agent",
			providerName: "mock", modelId: "m",
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
			wikiPolicyRevision: 1,
		} as any);
		const newGrants: WikiGrant[] = [
			{ scope: "memory://", actions: ["read", "search", "create"] },
			{ scope: "wiki-root/knowledge", actions: ["search"] },
		];
		store.update(created.id, {
			wikiGrants: newGrants,
			wikiPolicyRevision: 2,
		} as any);
		const got = store.get(created.id);
		expect(got!.wikiGrants).toEqual(newGrants);
		expect(got!.wikiPolicyRevision).toBe(2);
	});

	test("update wikiGrants to empty array persists (not coerced to null/undefined)", () => {
		const created = store.create({
			name: "empty-grants",
			providerName: "mock", modelId: "m",
			wikiGrants: [{ scope: "memory://", actions: ["read"] }],
			wikiPolicyRevision: 1,
		} as any);
		store.update(created.id, {
			wikiGrants: [],
			wikiPolicyRevision: 2,
		} as any);
		const got = store.get(created.id);
		expect(got!.wikiGrants).toEqual([]);
		expect(got!.wikiPolicyRevision).toBe(2);
	});

	test("omitted wiki fields on create → read back as null/undefined (no phantom data)", () => {
		const created = store.create({
			name: "no-wiki-fields",
			providerName: "mock", modelId: "m",
		} as any);
		const got = store.get(created.id);
		// Optional fields read back as null/undefined — key invariant is no PHANTOM grants.
		expect(got!.wikiGrants ?? null).toBeNull();
		expect(got!.wikiContext ?? null).toBeNull();
		expect(got!.wikiPolicyRevision ?? null).toBeNull();
	});
});

// ===========================================================================
// §A.2  fresh DB agents table contains the 3 new columns (snake_case)
// ===========================================================================

describe("wiki-v2 §A.2 fresh DB agents table has new columns [对抗 lens]", () => {
	test("agents table contains wiki_grants / wiki_context / wiki_policy_revision columns", () => {
		const sessionDB = openFreshCoreDb();
		try {
			// eslint-disable-next-line no-new
			new AgentStore(sessionDB);
			const raw = sessionDB.getDb();
			const cols = raw.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string; type: string }>;
			const names = cols.map((c) => c.name);
			expect(names, "must have wiki_grants column").toContain("wiki_grants");
			expect(names, "must have wiki_context column").toContain("wiki_context");
			expect(names, "must have wiki_policy_revision column").toContain("wiki_policy_revision");
			const rev = cols.find((c) => c.name === "wiki_policy_revision");
			// SqliteStore.columnDef 写所有未特殊列 TEXT(number: true 只影响
			// 序列化方向,不影响物理类型;SQLite TEXT affinity 仍能 round-trip 数字)。
			// 关键不变量是 round-trip 值正确(已在 column-name consistency test 验)。
			expect(rev?.type?.toUpperCase()).toMatch(/TEXT|INT/);
		} finally {
			sessionDB.close();
		}
	});

	test("[column-name consistency] round-trip survives fresh DB + write + read", () => {
		// 对抗陷阱:AGENT_COLUMNS 写入 wikiGrants (camelCase 派生列 wiki_grants 与
		// safeAddColumn 的 wiki_grants 必须一致)。若错位,read 拿不到 grants。
		const db = openFreshCoreDb();
		try {
			const store = new AgentStore(db);
			const created = store.create({
				name: "Col Test",
				providerName: "mock", modelId: "m",
				wikiGrants: grants,
				wikiContext: [{ address: "memory://", profile: "compact", channel: "system", budgetTokens: 800 }],
				wikiPolicyRevision: 42,
			} as any);
			const got = store.get(created.id);
			expect(got!.wikiGrants, "camelCase key wikiGrants must read back snake_case column").toEqual(grants);
			expect(got!.wikiContext).toEqual([{ address: "memory://", profile: "compact", channel: "system", budgetTokens: 800 }]);
			expect(got!.wikiPolicyRevision).toBe(42);
		} finally {
			db.close();
		}
	});
});

// ===========================================================================
// §A.3  list path returns new wiki fields (no field-stripping on list)
// ===========================================================================

describe("wiki-v2 §A.3 list path returns new wiki fields [对抗 lens]", () => {
	test("list() returns wikiGrants/wikiContext/policyRevision on rows that have them", () => {
		const db = openFreshCoreDb();
		try {
			const store = new AgentStore(db);
			const a = store.create({
				name: "List One",
				providerName: "mock", modelId: "m",
				wikiGrants: grants,
				wikiContext: [{ address: "memory://", profile: "standard", channel: "system", budgetTokens: 1800 }],
				wikiPolicyRevision: 3,
			} as any);
			const b = store.create({
				name: "List Two",
				providerName: "mock", modelId: "m",
			} as any);
			const list = store.list();
			expect(list.length).toBeGreaterThanOrEqual(2);
			const aRow = list.find((x) => x.id === a.id);
			const bRow = list.find((x) => x.id === b.id);
			expect(aRow?.wikiGrants).toEqual(grants);
			expect(aRow?.wikiPolicyRevision).toBe(3);
			expect(bRow?.wikiGrants ?? null).toBeNull();
		} finally {
			db.close();
		}
	});
});
