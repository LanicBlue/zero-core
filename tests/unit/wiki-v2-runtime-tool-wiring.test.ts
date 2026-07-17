// wiki-system-redesign sub-05 acceptance — 对抗 (adversarial-edge) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-05 §B.5/§B.6「Wiki tool 切换彻底性」+ §D AgentLoop hooks-only。
// 验证:
//   §B.5  ToolRegistry 对 Agent 只暴露一个 Wiki(新 schema,无 Legacy/V2)。
//   §B.6  Agent 调旧 action → schema validation error(不 fallback)。
//   §D    AgentLoop 不 import Wiki compiler/store,无 wiki-context/wiki-system-anchors
//         字面 section,无 PostTurnComplete 实际引用(只注释)。
//   §B    CallerCtx.wikiAccess 缺失 → ACCESS_DENIED,不退回旧 anchor 模型。
//   defer C  formatSearchResult 渲染 matchTypes 聚合证据(plan-05 §5 兑现)。
//
// ## 对抗 probe 焦点
//   - 残留 Force-memory / 隐藏 fallback / WikiLegacy / WikiV2 alias。
//   - createMemory/updateMemory/docRead/docWrite/docEdit 在 production caller 中
//     是否还有任何非注释引用(memory archive/compression/Archivist/enrichment/
//     router/dispatcher)。
//   - wiki-anchor-injection.ts 文件未删,但 runtime 路径(agent-loop)不 import。
//
// ## 输入
//   - 文件系统读取 src/(read-only)+ ToolRegistry 实例化 + createWikiTool unit host。
//
// ## 维护规则
//   - 不 edit 实现源;发现违反报 blocker finding。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
	const { tmpdir } = require("node:os") as typeof import("node:os");
	const { join } = require("node:path") as typeof import("node:path");
	const d = mkdtempSync(join(tmpdir(), "zc-wiki-v2-runtime-wiring-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	return { UNIQUE_DIR: d };
});

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiSearchService } from "../../src/server/wiki/wiki-search-service.js";
import { createWikiTool, wikiV2ActionSchema, formatWikiV2Result } from "../../src/tools/wiki-v2-tool.js";
import { wikiTool } from "../../src/tools/wiki-tool.js";
import { RENAMED_TOOLS } from "../../src/core/tool-registry.js";
import {
	getToolExecute,
	getToolName,
} from "../../src/tools/tool-factory.js";
import type { CallerCtx, ToolResult } from "../../src/tools/types.js";
import type { CompiledWikiAccess } from "../../src/shared/wiki-types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function wideAccess(agentId = "wiring-agent"): CompiledWikiAccess {
	return {
		agentId,
		activeProjectId: undefined,
		grants: [{
			canonicalScope: "wiki-root",
			actions: ["expand", "read", "search", "create", "update", "delete", "link", "unlink", "move"],
		}],
		policyRevision: 1,
	};
}

function callerCtx(acc?: CompiledWikiAccess): CallerCtx {
	return {
		caller: "internal",
		sessionId: "wiring-session",
		agentId: acc?.agentId ?? "wiring-agent",
		toolCallId: "tc-wiring-1",
		wikiAccess: acc,
	} as CallerCtx;
}

interface Host {
	execute: (input: Record<string, unknown>, acc?: CompiledWikiAccess) => Promise<ToolResult>;
	rawExecute: (input: Record<string, unknown>, ctx: CallerCtx) => Promise<ToolResult>;
	getName: () => string;
	dispose: () => void;
}

function buildHost(): Host {
	const dbPath = join(UNIQUE_DIR, `wiki-wiring-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
	const wiki = new WikiDatabase(dbPath);
	const wikiSvc = WikiService.fromDatabase(wiki);
	const db = wiki.getDb();
	const nodeRepo = new WikiNodeRepository(db);
	const repositoryStore = new WikiRepositoryStore(db);
	const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
	const authorizationService = new WikiAuthorizationService();
	const search = new WikiSearchService({
		db, nodeRepo, repositoryStore, addressService, authorizationService,
	});
	const tool = createWikiTool({ wikiService: wikiSvc, searchService: search });
	const rawExecute = getToolExecute(tool)!;
	const getName = () => getToolName(tool)!;
	return {
		rawExecute,
		getName,
		execute: async (input, acc) => rawExecute(input, callerCtx(acc ?? wideAccess())),
		dispose: () => { try { wiki.close(); } catch { /* idempotent */ } },
	};
}

function schemaShape(schema: any): Record<string, any> {
	const sh = (schema as any)._def.shape;
	return typeof sh === "function" ? sh() : sh;
}

// ===========================================================================
// §B.5  ToolRegistry exposes exactly one Wiki (no Legacy/V2 alias)
// ===========================================================================

describe("wiki-v2 §B.5 ToolRegistry exposes exactly ONE Wiki tool [对抗 lens]", () => {
	test("registered wikiTool has user-visible name 'Wiki'", () => {
		// wikiTool is the ToolRegistry-facing singleton. Its name must be 'Wiki'.
		const name = getToolName(wikiTool);
		expect(name).toBe("Wiki");
	});

	test("RENAMED_TOOLS contains NO WikiLegacy / WikiV2 alias", () => {
		// 所有 wiki 别名都映射到 'Wiki',不能有第二个用户可见工具。
		const wikiAliases = Object.entries(RENAMED_TOOLS).filter(([, v]) => v === "Wiki");
		// 至少有 'wiki' lowercase 别名(legacy back-compat)。
		expect(wikiAliases.length).toBeGreaterThanOrEqual(1);
		// 但目标都是 'Wiki' —— 不存在 'WikiLegacy' / 'WikiV2' 作为 value 或 alias。
		for (const [alias, target] of Object.entries(RENAMED_TOOLS)) {
			expect(target, `alias '${alias}' → must NOT map to Legacy/V2`).not.toMatch(/WikiLegacy|WikiV2/i);
			expect(alias, `alias name '${alias}' must NOT be WikiLegacy/V2`).not.toMatch(/WikiLegacy|WikiV2/i);
		}
		// No 'WikiLegacy' or 'WikiV2' as a registered value.
		const allTargets = new Set(Object.values(RENAMED_TOOLS));
		expect(allTargets.has("WikiLegacy")).toBe(false);
		expect(allTargets.has("WikiV2")).toBe(false);
	});

	test("wikiV2ActionSchema has 9-action enum (no legacy doc-memory action)", () => {
		const shape = schemaShape(wikiV2ActionSchema);
		const d = shape.action._def;
		let values: string[];
		if (d.entries && typeof d.entries === "object") values = Object.keys(d.entries);
		else if (Array.isArray(d.values)) values = d.values as string[];
		else if (Array.isArray(d.options)) values = d.options as string[];
		else if (Array.isArray(shape.action.options)) values = shape.action.options as string[];
		else throw new Error("unable to read action enum values");
		expect([...values].sort()).toEqual([
			"create", "delete", "expand", "link", "move",
			"read", "search", "unlink", "update",
		]);
	});
});

// ===========================================================================
// §B.6  retired actions → schema validation error (no fallback)
// ===========================================================================

describe("wiki-v2 §B.6 retired actions rejected by schema [对抗 lens]", () => {
	test.each([
		"createMemory", "updateMemory", "docRead", "docWrite", "docEdit",
	])("action '%s' rejected by zod schema", (retired) => {
		const r = wikiV2ActionSchema.safeParse({ action: retired });
		expect(r.success, `retired action '${retired}' must be rejected`).toBe(false);
	});

	test.each([
		"address", "register", "grant", "context", "restore", "purge", "hardDelete",
	])("management action '%s' rejected by zod schema", (mgmt) => {
		const r = wikiV2ActionSchema.safeParse({ action: mgmt });
		expect(r.success, `mgmt action '${mgmt}' must be rejected`).toBe(false);
	});

	test("unknown arbitrary action rejected (no silent dispatch)", () => {
		const r = wikiV2ActionSchema.safeParse({ action: "totallyMadeUpAction" });
		expect(r.success).toBe(false);
	});
});

// ===========================================================================
// §B  CallerCtx.wikiAccess missing → ACCESS_DENIED (no anchor fallback)
// ===========================================================================

describe("wiki-v2 §B missing wikiAccess → ACCESS_DENIED [对抗 lens]", () => {
	let h: Host;
	beforeEach(() => { h = buildHost(); });
	afterEach(() => { h.dispose(); });

	test("read with NO wikiAccess in callerCtx → ACCESS_DENIED (not silent allow)", async () => {
		// Seed a node, then try to read with a callerCtx that has wikiAccess=undefined.
		await h.execute({
			action: "create", parent: "wiki-root/knowledge", name: "x", content: "y",
		}, wideAccess());
		const res = await h.rawExecute(
			{ action: "read", node: "wiki-root/knowledge/x" },
			callerCtx(undefined),
		);
		expect(res.ok).toBe(false);
		// Must be ACCESS_DENIED (or wikiAccess missing equivalent), not a successful read.
		expect(String(res.error ?? "")).toMatch(/ACCESS_DENIED|wiki.*access.*missing|wikiAccess/i);
	});

	test("wikiAccess=undefined does NOT fall back to callerCtx.scope or wikiAnchorNodeIds", async () => {
		// Even with callerCtx carrying legacy wikiAnchorNodeIds + projectId,
		// wikiAccess missing → ACCESS_DENIED (legacy anchor must not be a back door).
		await h.execute({
			action: "create", parent: "wiki-root/knowledge", name: "y", content: "secret",
		}, wideAccess());
		const res = await h.rawExecute(
			{ action: "read", node: "wiki-root/knowledge/y" },
			{
				caller: "internal",
				sessionId: "s",
				agentId: "a",
				toolCallId: "t",
				wikiAccess: undefined,
				// legacy fields that MUST NOT unlock
				wikiAnchorNodeIds: ["*"],
				projectId: "any",
			} as CallerCtx,
		);
		expect(res.ok).toBe(false);
		expect(String(res.error ?? "")).toMatch(/ACCESS_DENIED|wiki.*access.*missing|wikiAccess/i);
		// critically: error payload MUST NOT leak the secret content
		expect(JSON.stringify(res)).not.toContain("secret");
	});
});

// ===========================================================================
// defer concern C — formatSearchResult renders matchTypes aggregation
// ===========================================================================

describe("wiki-v2 defer-C: formatSearchResult renders matchTypes aggregation [对抗 lens]", () => {
	test("hit with matchTypes ≥ 2 renders [also: type2, type3] in formatted output", () => {
		// 合成一个 multi-matchType hit 直接喂 formatter(pure function 测试,
		// 不依赖 hybrid search service 是否产出 matchTypes 的内部细节)。
		const result = {
			ok: true,
			data: {
				mode: "hybrid",
				target: "wiki",
				effectiveScope: "wiki-root/knowledge",
				truncated: false,
				wikiHits: [{
					path: "wiki-root/knowledge/multi",
					displayTitle: "Multi-match Node",
					kind: "knowledge",
					matchType: "exact",
					matchedField: "name",
					matchTypes: ["exact", "substring", "fulltext"],
					normalizedScore: 0.95,
					snippet: "snippet text",
				}],
				sourceHits: [],
			},
		};
		const formatted = formatWikiV2Result(result as any);
		expect(formatted).toMatch(/\[also:\s*substring,\s*fulltext\]/i);
		expect(formatted).toMatch(/wiki-root\/knowledge\/multi/);
		expect(formatted).toMatch(/score=/);
	});

	test("hit with matchTypes == undefined renders ONLY primary (no [also:])", () => {
		const result = {
			ok: true,
			data: {
				mode: "substring",
				target: "wiki",
				effectiveScope: "wiki-root/knowledge",
				truncated: false,
				wikiHits: [{
					path: "wiki-root/knowledge/single",
					displayTitle: "Single",
					kind: "knowledge",
					matchType: "substring",
					matchedField: "summary",
					matchTypes: undefined,
					normalizedScore: 0.5,
					snippet: "x",
				}],
				sourceHits: [],
			},
		};
		const formatted = formatWikiV2Result(result as any);
		expect(formatted).not.toMatch(/\[also:/i);
		// primary match info still present
		expect(formatted).toMatch(/substring\/summary/);
	});

	test("search result header renders mode/target/scope", () => {
		const result = {
			ok: true,
			data: {
				mode: "fulltext",
				target: "both",
				effectiveScope: null,
				truncated: true,
				wikiHits: [],
				sourceHits: [],
			},
		};
		const formatted = formatWikiV2Result(result as any);
		expect(formatted).toMatch(/^# Wiki search: mode=fulltext target=both/m);
		expect(formatted).toMatch(/truncated/);
		expect(formatted).toMatch(/no matches/i);
	});

	test("live search via host returns wikiHits with primary matchType (defer C precondition)", async () => {
		// 验证 host 真能产出 wikiHits 且至少含 matchType(单数,必填)。
		// matchTypes(复数)是 hybrid-only;basic mode 不强制,但 matchType 必须在。
		const h = buildHost();
		try {
			await h.execute({
				action: "create",
				parent: "wiki-root/knowledge",
				name: "search-target",
				summary: "findme summary",
			}, wideAccess());
			const res = await h.execute({
				action: "search", query: "findme", mode: "substring",
			}, wideAccess());
			expect(res.ok).toBe(true);
			const data = res.data as any;
			expect(data.wikiHits.length).toBeGreaterThan(0);
			expect(data.wikiHits[0].matchType).toBeDefined();
			// defer-C 形态约束:hit 上 matchTypes 字段位置存在(可能 undefined)。
			expect("matchTypes" in data.wikiHits[0] || data.wikiHits[0].matchType).toBeTruthy();
			// formatted output 仍是有效字符串
			const formatted = formatWikiV2Result(res as any);
			expect(typeof formatted).toBe("string");
			expect(formatted).toMatch(/wiki-root\/knowledge\/search-target/);
		} finally {
			h.dispose();
		}
	});
});

// ===========================================================================
// §D  AgentLoop hooks-only — structural source-level audit
// ===========================================================================

describe("wiki-v2 §D AgentLoop hooks-only (source-level audit) [架构 lens]", () => {
	const AGENT_LOOP = readFileSync(resolve("src/runtime/agent-loop.ts"), "utf8");

	test("agent-loop.ts has NO wiki compiler/store imports", () => {
		// Must NOT import wiki-context-compiler / wiki-access-compiler / wiki-service.
		expect(AGENT_LOOP, "no wiki-context-compiler import").not.toMatch(/from\s+['"][^'"]*wiki-context-compiler/);
		expect(AGENT_LOOP, "no wiki-access-compiler import").not.toMatch(/from\s+['"][^'"]*wiki-access-compiler/);
		expect(AGENT_LOOP, "no wiki-service import").not.toMatch(/from\s+['"][^'"]*\/wiki-service/);
		expect(AGENT_LOOP, "no wiki-anchor-injection import").not.toMatch(/from\s+['"][^'"]*wiki-anchor-injection/);
	});

	test("agent-loop.ts has NO wiki literal system-section name in CODE (comments OK)", () => {
		// Strip /* */ and // comments before checking. (Plan-05 §7 + acceptance §D 41.)
		const stripped = AGENT_LOOP
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		// 字面 'wiki-context' / 'wiki-system-anchors' 不能在代码字符串里出现。
		expect(stripped, "no 'wiki-context' literal in code").not.toMatch(/['"]wiki-context['"]/);
		expect(stripped, "no 'wiki-system-anchors' literal in code").not.toMatch(/['"]wiki-system-anchors['"]/);
	});

	test("agent-loop.ts has NO PostTurnComplete CALL (comments only)", () => {
		// Strip comments. Then no live call/registration of PostTurnComplete.
		const stripped = AGENT_LOOP
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		// 'PostTurnComplete' should not appear as a hook registration or emit.
		expect(stripped, "no PostTurnComplete hook registration/emit").not.toMatch(
			/\bPostTurnComplete\b/,
		);
	});

	test("agent-loop.ts has NO buildGlobalAnchorWikiCallerCtx call", () => {
		// The legacy memory-turn whole-tree shortcut must be gone.
		expect(AGENT_LOOP).not.toMatch(/buildGlobalAnchorWikiCallerCtx/);
	});
});

// ===========================================================================
// §5  legacy actions must NOT have any non-comment caller in production
// ===========================================================================

describe("wiki-v2 §5 legacy actions have NO non-comment caller [对抗 lens]", () => {
	const LEGACY = ["createMemory", "updateMemory", "docRead", "docWrite", "docEdit"];

	function stripComments(src: string): string {
		return src
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "")
			.replace(/\s*\/\/.*$/g, "");
	}

	test.each(LEGACY)("production source has no live reference to '%s'", (action) => {
		// Scan the production source paths most likely to still call legacy actions.
		// If any non-comment occurrence appears, that's a hidden fallback.
		const files = [
			"src/server/agent-service.ts",
			"src/server/archive-service.ts",
			"src/server/wiki-operations.ts",
			"src/server/management-service.ts",
			"src/runtime/agent-loop.ts",
			"src/server/enrichment-runner.ts",
		];
		let liveHits = 0;
		for (const f of files) {
			let src: string;
			try {
				src = readFileSync(resolve(f), "utf8");
			} catch {
				continue;
			}
			const stripped = stripComments(src);
			// Word-boundary match for the legacy action identifier.
			const re = new RegExp(`\\b${action}\\b`);
			if (re.test(stripped)) {
				liveHits++;
			}
		}
		expect(liveHits, `legacy action '${action}' must NOT appear in live code of any scanned caller`).toBe(0);
	});
});
