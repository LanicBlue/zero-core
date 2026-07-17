// wiki-system-redesign sub-05 acceptance — 对抗 (adversarial-edge) lens.
//
// # 文件说明书
//
// ## 核心功能
// 行为级编码 acceptance-05 §E.1「Memory ephemeral turn 只能写 own Memory,
// 猜测其他 Memory 返回 NOT_FOUND / ACCESS_DENIED」+ plan-05 §8「不再用
// buildGlobalAnchorWikiCallerCtx 或全局 root 让 Memory turn 写全部 Agent/Project」。
//
// round-1 defer;本文件补齐。验证:
//   - 默认 Agent 的 memory ephemeral turn 携带的 CompiledWikiAccess(由真实
//     AgentService.compileWikiAccessForSession 产出 —— 即生产路径给 memory turn
//     的授权)只含 own Memory 全数据面 + Knowledge read,**不含** wiki-root 全树、
//     **不含** project://。
//   - Wiki tool 用该 access:create/read own memory:// → ok;create 到其他 agent
//     的 memory path → ACCESS_DENIED;create 到 project 子树 → ACCESS_DENIED。
//   - production 源码无 buildGlobalAnchorWikiCallerCtx 全树捷径 live caller
//     (plan-05 §8 / acceptance-05 §E)。
//
// ## 对抗 probe 焦点
//   - 是否存在任何让 memory turn 拿到 wiki-root 全树的隐藏路径(fallback / 启发式)。
//   - cross-agent memory 写入是否真能被拒(而非靠 NOT_FOUND「碰巧」挡住 —— 即
//     即便 other-agent root 存在,授权也该拒)。
//
// ## 输入
//   - 真实 wiki.db + AgentService.compileWikiAccessForSession + Wiki v2 tool。
//
// ## 维护规则
//   - 不 edit 实现源;发现违反报 blocker finding。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Per-file filesystem isolation
// ---------------------------------------------------------------------------
const { UNIQUE_DIR } = vi.hoisted(() => {
	const { mkdtempSync: mk } = require("node:fs") as typeof import("node:fs");
	const { tmpdir: td } = require("node:os") as typeof import("node:os");
	const { join: j } = require("node:path") as typeof import("node:path");
	const d = mk(j(td(), "zc-wiki-v2-memory-turn-"));
	process.env.ZERO_CORE_DIR = d;
	process.env.ZERO_CORE_DB_NO_WAL = "1";
	return { UNIQUE_DIR: d };
});

import { CoreDatabase } from "../../src/server/core-database.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { AgentService } from "../../src/server/agent-service.js";
import { WikiDatabase } from "../../src/server/wiki/wiki-database.js";
import { WikiService } from "../../src/server/wiki/wiki-service.js";
import { WikiNodeRepository } from "../../src/server/wiki/wiki-node-repository.js";
import { WikiRepositoryStore } from "../../src/server/wiki/wiki-repository-store.js";
import { WikiAddressService } from "../../src/server/wiki/wiki-address-service.js";
import { WikiAuthorizationService } from "../../src/server/wiki/wiki-authorization-service.js";
import { WikiSearchService } from "../../src/server/wiki/wiki-search-service.js";
import { setWikiRuntime, _resetWikiRuntimeForTests } from "../../src/server/wiki/wiki-runtime.js";
import { createWikiTool } from "../../src/tools/wiki-v2-tool.js";
import { getToolExecute } from "../../src/tools/tool-factory.js";
import type { CompiledWikiAccess } from "../../src/shared/wiki-types.js";
import type { CallerCtx, ToolResult } from "../../src/tools/types.js";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface SvcCtx {
	svc: AgentService;
	agentStore: AgentStore;
	db: CoreDatabase;
	wikiDb: WikiDatabase;
	wikiSvc: WikiService;
	searchSvc: WikiSearchService;
	dir: string;
}

function buildSvc(): SvcCtx {
	const dir = mkdtempSync(join(tmpdir(), "zc-wiki-memturn-"));
	const db = new CoreDatabase(join(dir, "core.db"));
	runMigrations(db);

	const wikiDb = new WikiDatabase(join(dir, "wiki.db"));
	const wikiSvc = WikiService.fromDatabase(wikiDb);
	const wdb = wikiDb.getDb();
	const nodeRepo = new WikiNodeRepository(wdb);
	const repositoryStore = new WikiRepositoryStore(wdb);
	const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
	const authorizationService = new WikiAuthorizationService();
	const searchSvc = new WikiSearchService({
		db: wdb, nodeRepo, repositoryStore, addressService, authorizationService,
	});
	setWikiRuntime({ wikiService: wikiSvc, searchService: searchSvc });

	const svc = new AgentService(dir, db);
	const agentStore = new AgentStore(db);
	svc.setAgentStore(agentStore);
	return { svc, agentStore, db, wikiDb, wikiSvc, searchSvc, dir };
}

function wideCtx(agentId = "seed-admin"): any {
	const access: CompiledWikiAccess = {
		agentId, activeProjectId: undefined,
		grants: [{
			canonicalScope: "wiki-root",
			actions: ["expand", "read", "search", "create", "update", "delete", "link", "unlink", "move"],
		}],
		policyRevision: 1,
	};
	return { access, agentId, activeProjectId: undefined, sessionId: null, requestId: null };
}

function ctxWith(access: CompiledWikiAccess): CallerCtx {
	return {
		caller: "internal",
		sessionId: "mem-turn-session",
		agentId: access.agentId,
		toolCallId: "tc-mem-1",
		wikiAccess: access,
	} as CallerCtx;
}

/** Seed a wiki node idempotently (ignore ALREADY_EXISTS — default containers pre-exist). */
async function seed(parent: string, name: string, content: string, wikiSvc: WikiService): Promise<void> {
	try {
		await wikiSvc.create({ parent, name, content }, wideCtx("seed-admin"));
	} catch (err) {
		const code = (err as { code?: string })?.code ?? "";
		if (!/ALREADY_EXISTS/i.test(code)) throw err;
	}
}

let ctxHolder: SvcCtx | null;
beforeEach(() => { ctxHolder = null; });
afterEach(() => {
	try { ctxHolder?.wikiDb?.close(); } catch { /* ignore */ }
	try { ctxHolder?.db?.close(); } catch { /* ignore */ }
	if (ctxHolder) rmSync(ctxHolder.dir, { recursive: true, force: true });
	_resetWikiRuntimeForTests();
});

// ===========================================================================
// §E.1  memory ephemeral turn authorization boundary
// ===========================================================================

describe("wiki-v2 §E.1 memory-turn own-Memory-only authorization [对抗 lens]", () => {
	test("default agent's compiled access (production path) is own-Memory + Knowledge read ONLY", async () => {
		const c = buildSvc();
		ctxHolder = c;
		// Default agent: no wikiGrants → AgentService.pickDefaultGrants returns
		// DEFAULT_GRANTS_AGENT (round-2 B1: name-agnostic). This is exactly the
		// access a memory ephemeral turn on the agent's own loop would carry
		// (buildCallerCtx bridges config.wikiAccess, which compileWikiAccessForSession set).
		const agent = c.agentStore.create({
			name: "Archivist", // name must NOT widen access (plan-05 §8 / §E)
			provider: "MockProv",
			model: "m",
			toolPolicy: { tools: {} },
		} as any);

		const out = (c.svc as any).compileWikiAccessForSession(agent, `mt-${Date.now()}`, undefined);
		const access: CompiledWikiAccess = out.wikiAccess;
		expect(access).toBeDefined();
		const scopes = access.grants.map((g) => g.canonicalScope);

		// Own memory root present with full data-plane actions.
		expect(scopes).toContain(`wiki-root/memory/${agent.id}`);
		const ownMem = access.grants.find((g) => g.canonicalScope === `wiki-root/memory/${agent.id}`);
		expect(ownMem?.actions).toEqual(expect.arrayContaining(["create", "update", "read", "delete"]));

		// Knowledge read present.
		expect(scopes).toContain("wiki-root/knowledge");

		// §E adversarial: NO whole-tree, NO projects root.
		expect(scopes, "memory turn must NOT carry wiki-root whole-tree").not.toContain("wiki-root");
		expect(scopes.some((s) => s.startsWith("wiki-root/projects")), "memory turn must NOT carry any project grant").toBe(false);
		// NO other agent's memory root.
		expect(scopes.some((s) => s.startsWith("wiki-root/memory/") && s !== `wiki-root/memory/${agent.id}`), "memory turn must NOT reach another agent's memory").toBe(false);
	});

	test("memory turn WRITES own memory:// successfully (create + read round-trip)", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "writer-agent",
			provider: "MockProv", model: "m", toolPolicy: { tools: {} },
		} as any);
		await c.wikiSvc.ensureAgentMemoryRoot(agent.id, agent.name);

		const out = (c.svc as any).compileWikiAccessForSession(agent, `mt-w-${Date.now()}`, undefined);
		const ctx = ctxWith(out.wikiAccess);
		const tool = createWikiTool({ wikiService: c.wikiSvc, searchService: c.searchSvc });
		const exec = getToolExecute(tool)!;

		// Create a memory leaf under own memory root (logical address).
		const created: ToolResult = await exec(
			{ action: "create", parent: "memory://", name: "lesson-1", content: "prefer explicit types" },
			ctx,
		);
		expect(created.ok, `own memory create must succeed (got: ${created.error})`).toBe(true);

		// Read it back via logical address.
		const read: ToolResult = await exec(
			{ action: "read", node: "memory://lesson-1" },
			ctx,
		);
		expect(read.ok, `own memory read must succeed (got: ${read.error})`).toBe(true);
	});

	test("§E.1 adversarial: writing ANOTHER agent's memory path → ACCESS_DENIED (even when that root EXISTS)", async () => {
		// 关键对抗:NOT_FOUND「碰巧挡住」不算数。这里显式预创建 other-agent 的
		// memory root,使越权写入的失败必须来自授权拒绝,而非节点缺失。
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "attacker-agent",
			provider: "MockProv", model: "m", toolPolicy: { tools: {} },
		} as any);
		await c.wikiSvc.ensureAgentMemoryRoot(agent.id, agent.name);

		// Pre-create a DIFFERENT agent's memory root + a leaf, via wide seed ctx.
		const otherId = "victim-agent";
		await c.wikiSvc.ensureAgentMemoryRoot(otherId, "Victim");
		const otherRoot = `wiki-root/memory/${otherId}`;
		await seed(otherRoot, "secret", "top secret", c.wikiSvc);
		// sanity: the victim node really exists.
		expect(new WikiNodeRepository(c.wikiDb.getDb()).getActiveByPath(`${otherRoot}/secret`)).toBeTruthy();

		const out = (c.svc as any).compileWikiAccessForSession(agent, `mt-x-${Date.now()}`, undefined);
		const ctx = ctxWith(out.wikiAccess);
		const tool = createWikiTool({ wikiService: c.wikiSvc, searchService: c.searchSvc });
		const exec = getToolExecute(tool)!;

		// Attempt to CREATE under the victim's memory root. Out-of-scope paths
		// return NOT_FOUND by design (existence hiding — acceptance §E.1 allows
		// NOT_FOUND). The adversarial point: it is DENIED, and existence of the
		// victim node does NOT let the write through.
		const createRes: ToolResult = await exec(
			{ action: "create", parent: otherRoot, name: "pwned", content: "x" },
			ctx,
		);
		expect(createRes.ok).toBe(false);
		expect(String(createRes.error ?? "")).toMatch(/ACCESS_DENIED|NOT_FOUND/i);

		// Attempt to READ the victim's secret leaf.
		const readRes: ToolResult = await exec(
			{ action: "read", node: `${otherRoot}/secret` },
			ctx,
		);
		expect(readRes.ok).toBe(false);
		expect(String(readRes.error ?? "")).toMatch(/ACCESS_DENIED|NOT_FOUND/i);
		// critically: the secret content must NOT leak via the error payload.
		expect(JSON.stringify(readRes)).not.toContain("top secret");
	});

	test("§E.1 adversarial: writing project subtree without project grant → ACCESS_DENIED", async () => {
		const c = buildSvc();
		ctxHolder = c;
		const agent = c.agentStore.create({
			name: "noproj-agent",
			provider: "MockProv", model: "m", toolPolicy: { tools: {} },
		} as any);
		await c.wikiSvc.ensureAgentMemoryRoot(agent.id, agent.name);

		// Pre-create a project subtree so the denial is auth-driven, not absence.
		// (wiki-root/projects is a default container; seed idempotently.)
		await seed("wiki-root/projects", "proj-x", "", c.wikiSvc);

		const out = (c.svc as any).compileWikiAccessForSession(agent, `mt-p-${Date.now()}`, undefined);
		const ctx = ctxWith(out.wikiAccess);
		const tool = createWikiTool({ wikiService: c.wikiSvc, searchService: c.searchSvc });
		const exec = getToolExecute(tool)!;

		const res: ToolResult = await exec(
			{ action: "create", parent: "wiki-root/projects/proj-x", name: "tamper", content: "x" },
			ctx,
		);
		expect(res.ok).toBe(false);
		// Default agent has NO project grant → out-of-scope → NOT_FOUND (existence
		// hiding) per acceptance §E.1; either ACCESS_DENIED or NOT_FOUND is compliant.
		expect(String(res.error ?? "")).toMatch(/ACCESS_DENIED|NOT_FOUND/i);
	});
});

// ===========================================================================
// plan-05 §8 — buildGlobalAnchorWikiCallerCtx 全树捷径必须无 live caller
// ===========================================================================

describe("wiki-v2 §8 buildGlobalAnchorWikiCallerCtx whole-tree shortcut has NO live caller [对抗 lens]", () => {
	function stripComments(src: string): string {
		return src
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "")
			.replace(/\s*\/\/.*$/g, "");
	}

	const PROD_FILES = [
		"src/server/agent-service.ts",
		"src/server/archive-service.ts",
		"src/runtime/agent-loop.ts",
		"src/tools/wiki-tool.ts",
		"src/tools/wiki-v2-tool.ts",
		"src/server/wiki-operations.ts",
		"src/server/management-service.ts",
		"src/server/enrichment-runner.ts",
	];

	test("no production source has a LIVE reference to buildGlobalAnchorWikiCallerCtx", () => {
		let liveHits = 0;
		let hitFile = "";
		for (const f of PROD_FILES) {
			let src: string;
			try {
				src = readFileSync(resolve(f), "utf8");
			} catch {
				continue;
			}
			const stripped = stripComments(src);
			if (/\bbuildGlobalAnchorWikiCallerCtx\b/.test(stripped)) {
				liveHits++;
				hitFile = f;
			}
		}
		expect(liveHits, `buildGlobalAnchorWikiCallerCtx must NOT appear in live code (hit: ${hitFile})`).toBe(0);
	});

	test("memory-turn runner path (agent-service) builds the callerCtx from the agent's own loop wikiAccess, not a global root", () => {
		// Structural guard: the memory turn runs via `loop.run(memoryPrompt, {ephemeral})`
		// on the agent's OWN loop (archiveOneSessionCascade). The loop's callerCtx is
		// built by buildCallerCtx bridging config.wikiAccess — which was compiled by
		// compileWikiAccessForSession (own-memory only for default agents). Assert the
		// agent-service memory-turn runner does NOT construct a wide callerCtx of its
		// own (no new buildGlobalAnchorWikiCallerCtx, no manual wide-memory ctx).
		const src = readFileSync(resolve("src/server/agent-service.ts"), "utf8");
		const stripped = stripComments(src);
		// The memory turn runner must run the memory prompt on the loop (own access).
		expect(stripped).toMatch(/loop\.run\s*\(\s*memoryPrompt/);
		// No global-root shortcut anywhere in agent-service.
		expect(stripped, "agent-service must not reference the retired global-anchor shortcut").not.toMatch(/\bbuildGlobalAnchorWikiCallerCtx\b/);
	});
});
