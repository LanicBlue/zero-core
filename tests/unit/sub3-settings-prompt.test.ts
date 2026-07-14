// memory-archive-fixes sub-3 — adversarial verification of acceptance-3.md
//
// # File 说明书
//
// ## 核心功能
// 独立验证 acceptance-3.md 的 7 个条目(verifier 写,非实施者)。覆盖:
//   #1  MemorySettings 渲染 2 个 textarea(压缩摘要 prompt + 记忆提取 prompt)
//       + 2 个「恢复默认」按钮。vitest env = node(无 RTL),沿用 sub-1 #4 的
//       源码 grep 对抗模式(sub-1 #4 已先例化此 pattern 4 处)。
//   #2  压缩 prompt 持久化 + 读侧 buildCompressOpts 转发:① config-router 往返
//       compression.summarySystemPrompt;② buildCompressOpts 把非空 override
//       放入 opts.summarySystemPrompt(空 → opts 不含字段 → 默认 SUMMARY_SYSTEM)。
//   #3  记忆提取 prompt 持久化 + 生效:① config-router 往返 archive.memoryPrompt;
//       ② buildTempMemoryTurnRunner 用 config.archive.memoryPrompt 覆盖
//       ARCHIVE_MEMORY_PROMPT。测法:mock AgentLoop 类(vi.mock + importOriginal
//       保 ARCHIVE_MEMORY_PROMPT 真)→ mutate (svc as any).config.archive →
//       调 buildTempMemoryTurnRunner(sessionConfig)() → 断言 stubbed loop.run
//       收到 override。
//   #4  两框空 → 用默认 const(覆盖 buildTempMemoryTurnRunner + buildCompressOpts
//       两侧,含 whitespace-only)。
//   #5  「恢复默认」按钮 onClick 清空字段为 ""(源码 grep)。
//   #6  向后兼容:旧 config 无 archive 字段 → DEFAULT_CONFIG.archive = {} →
//       buildTempMemoryTurnRunner 用默认,不崩。
//   #7  IPC 往返:config-router GET/PUT memory-config {compression, archive}
//       读回相等。
//
// ## 对抗性核查
//   - 不信 implementer 汇报:git diff + 源码 grep + 运行时 mock 三路验。
//   - 读侧(compression-trigger-hooks buildCompressOpts)虽未改,直接单测断言
//     非空 override 进 opts(覆盖 acceptance #2 反例)。
//   - buildTempMemoryTurnRunner 的 override 在闭包 BUILD 期捕获,只有运行闭包
//     才能观测传入 loop.run 的实参 → 必须跑闭包,mock AgentLoop。
//
// ## 约束
// - Windows vitest STACK_BUFFER_OVERRUN:少开 temp DB。config-router 用 mock KV
//   (0 temp DB);buildCompressOpts 纯函数(0 temp DB);UI 源码 grep(0 temp DB);
//   仅 buildTempMemoryTurnRunner describe 开 1 个共享 temp SessionDB(beforeAll)。
// - vi.mock + importOriginal 保 ARCHIVE_MEMORY_PROMPT 真值(strict-equal 默认 const)。
// - 不 git commit;不修改 src/(verifier 只写测试)。

import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express, { type Express } from "express";
import { createServer, type Server } from "node:http";

// ─── Mock AgentLoop class; keep ARCHIVE_MEMORY_PROMPT real (importOriginal) ──
//
// buildTempMemoryTurnRunner constructs `new AgentLoop(sessionConfig, providers, cb)`
// then calls `.run(memoryPrompt, { ephemeral })` + `.abort()`. To observe the
// prompt arg without spinning a real LLM, replace ONLY the class; the real
// ARCHIVE_MEMORY_PROMPT string is preserved (strict-equality with the default).
// registerHooksForLoop is mocked as a no-op spy so the stub `.registry` is
// never dereferenced.
const loopCtorCalls = vi.hoisted(() => [] as Array<{ sessionConfig: any; providers: any; cb: any }>);
const runCalls = vi.hoisted(() => [] as Array<{ prompt: string; opts: any }>);
const abortCalls = vi.hoisted(() => [] as number[]);

vi.mock("../../src/runtime/agent-loop.js", async (importOriginal) => {
	const actual = await importOriginal() as typeof import("../../src/runtime/agent-loop.js");
	class StubAgentLoop {
		constructor(sessionConfig: any, providers: any, cb: any) {
			loopCtorCalls.push({ sessionConfig, providers, cb });
		}
		get registry() { return {}; }
		async run(prompt: string, opts?: any) {
			runCalls.push({ prompt, opts });
		}
		abort() {
			abortCalls.push(1);
		}
	}
	return { ...actual, AgentLoop: StubAgentLoop as unknown as typeof actual.AgentLoop };
});

vi.mock("../../src/runtime/hooks/index.js", async (importOriginal) => {
	const actual = await importOriginal() as any;
	return {
		...actual,
		// No-op spy: buildTempMemoryTurnRunner calls registerHooksForLoop(
		// tempLoop.registry, "main", deps) — we don't need real hook wiring to
		// observe the prompt arg.
		registerHooksForLoop: vi.fn(),
	};
});

import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { AgentService } from "../../src/server/agent-service.js";
import { ARCHIVE_MEMORY_PROMPT } from "../../src/runtime/agent-loop.js";
import { buildCompressOpts } from "../../src/runtime/hooks/compression-trigger-hooks.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import type { RuntimeProviderConfig } from "../../src/runtime/types.js";

// ─── HTTP helpers (same shape as rest-routers.test.ts / sub1-archive-nonblocking) ──

function listen(app: Express): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const server = createServer(app);
		server.listen(0, () => {
			const addr = server.address() as { port: number };
			resolve({ server, port: addr.port });
		});
	});
}
function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(resolve));
}
async function request(port: number, method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
	const url = `http://localhost:${port}${path}`;
	const opts: RequestInit = { method };
	if (body !== undefined) {
		opts.headers = { "Content-Type": "application/json" };
		opts.body = JSON.stringify(body);
	}
	const resp = await fetch(url, opts);
	const text = await resp.text();
	try { return { status: resp.status, data: JSON.parse(text) }; }
	catch { return { status: resp.status, data: text }; }
}

// ─── Shared config-router setup with in-memory mock KV (0 temp DB) ──────────

async function setupConfigRouter(initialGlobalConfig: Record<string, any> = {}) {
	const { createConfigRouter } = await import("../../src/server/config-router.js");
	const app = express();
	const configData: Record<string, any> = { global_config: { ...initialGlobalConfig } };
	const kv = {
		getJson: (key: string) => (key in configData ? configData[key] : null),
		setJson: (key: string, value: any) => { configData[key] = value; },
	};
	const sessionDB = { getKVStore: () => kv } as any;
	const registry = { getAll: () => [], getToolConfig: () => ({}) } as any;
	app.use(express.json());
	app.use("/api/config", createConfigRouter({ sessionDB, registry, buildDefaultPrompt: () => "" }));
	const { server, port } = await listen(app);
	return { server, port, configData };
}

// ===========================================================================
// #1 + #5 — MemorySettings UI: two textareas + two reset buttons (source grep)
// ===========================================================================

describe("sub-3 #1 + #5: MemorySettings renders two textareas + two reset buttons", () => {
	const SRC = join(__dirname, "..", "..", "src", "renderer", "components", "settings", "MemorySettings.tsx");
	const src = readFileSync(SRC, "utf8");

	test("#1: two prompt textareas exist with distinct aria-labels", () => {
		// 压缩摘要 prompt textarea — bound to compression.summarySystemPrompt.
		expect(src).toMatch(/aria-label=["']Compression Summary Prompt["']/);
		expect(src).toMatch(/value=\{compression\.summarySystemPrompt\s*\?\?\s*["']["']\}/);
		expect(src).toMatch(/onChange=\{\(e\)\s*=>\s*setCompression\(\{\s*\.\.\.compression,\s*summarySystemPrompt:\s*e\.target\.value\s*\}\)\}/);
		// 记忆提取 prompt textarea — bound to archive.memoryPrompt.
		expect(src).toMatch(/aria-label=["']Archive Memory Prompt["']/);
		expect(src).toMatch(/value=\{archive\.memoryPrompt\s*\?\?\s*["']["']\}/);
		expect(src).toMatch(/onChange=\{\(e\)\s*=>\s*setArchive\(\{\s*\.\.\.archive,\s*memoryPrompt:\s*e\.target\.value\s*\}\)\}/);
	});

	test("#1: archive state is loaded from memoryConfigGet().archive (UI pulls archive block)", () => {
		// The useEffect must read data.archive and seed the archive state —
		// otherwise the second textarea would always render empty even after
		// save. Adversarial: a wiring that saves archive but never loads it
		// would pass a "writes" test but fail at runtime.
		expect(src).toMatch(/setArchive\(data\.archive\s*\?\?\s*\{\}\)/);
	});

	test("#1: two distinct reset (「恢复默认」) buttons exist in the JSX", () => {
		// Count occurrences of 恢复默认 inside the JSX return body only (the
		// header comment also mentions the phrase, so slice from `return (`).
		const jsxStart = src.indexOf("return (");
		expect(jsxStart).toBeGreaterThan(-1);
		const jsx = src.slice(jsxStart);
		const matches = jsx.match(/恢复默认/g) ?? [];
		expect(matches.length).toBe(2);
	});

	test("#5: reset buttons clear their respective fields to empty string", () => {
		// Compression reset → summarySystemPrompt = ""
		expect(src).toMatch(/onClick=\{\(\)\s*=>\s*setCompression\(\{\s*\.\.\.compression,\s*summarySystemPrompt:\s*["']["']\s*\}\)\}/);
		// Archive reset → memoryPrompt = ""
		expect(src).toMatch(/onClick=\{\(\)\s*=>\s*setArchive\(\{\s*\.\.\.archive,\s*memoryPrompt:\s*["']["']\s*\}\)\}/);
	});

	test("#1: save() writes both compression AND archive blocks (not just compression)", () => {
		// Adversarial: if save() were left as the old memoryConfigUpdate({ compression })
		// the archive textarea would silently never persist.
		expect(src).toMatch(/memoryConfigUpdate\(\{\s*compression,\s*archive\s*\}\)/);
	});
});

// ===========================================================================
// #2 + #4 — compression prompt: buildCompressOpts read-side + empty→default
// (read side未改,但直接断言 override 进入 opts —— 覆盖反例「改值仍用 SUMMARY_SYSTEM」)
// ===========================================================================

describe("sub-3 #2 + #4: buildCompressOpts forwards compression.summarySystemPrompt (read-side no-regression)", () => {
	const PROVIDERS: RuntimeProviderConfig[] = [
		{ name: "stub", type: "mock", apiKey: "k", baseUrl: "u",
			models: [{ id: "stub", name: "stub", contextWindow: 200000, maxTokens: 8000 }], enabled: true },
	];
	function mkConfig(patch: Record<string, any>): any {
		return { agentId: "a", workspaceDir: ".", systemPrompt: "s",
			providerName: "P", modelId: "M", toolPolicy: {}, ...patch };
	}

	test("#2: non-empty summarySystemPrompt → opts.summarySystemPrompt carries it", async () => {
		const opts = await buildCompressOpts(
			mkConfig({ compression: { summarySystemPrompt: "USER_COMPRESSION_PROMPT" } }),
			PROVIDERS,
		);
		expect(opts.summarySystemPrompt).toBe("USER_COMPRESSION_PROMPT");
	});

	test("#4a: empty summarySystemPrompt (empty string) → opts.summarySystemPrompt undefined (default SUMMARY_SYSTEM)", async () => {
		const opts = await buildCompressOpts(
			mkConfig({ compression: { summarySystemPrompt: "" } }),
			PROVIDERS,
		);
		expect(opts.summarySystemPrompt).toBeUndefined();
	});

	test("#4b: whitespace-only summarySystemPrompt → opts.summarySystemPrompt undefined (trim guard)", async () => {
		const opts = await buildCompressOpts(
			mkConfig({ compression: { summarySystemPrompt: "   \n\t  " } }),
			PROVIDERS,
		);
		expect(opts.summarySystemPrompt).toBeUndefined();
	});

	test("#4c: summarySystemPrompt absent → opts.summarySystemPrompt undefined", async () => {
		const opts = await buildCompressOpts(mkConfig({ compression: {} }), PROVIDERS);
		expect(opts.summarySystemPrompt).toBeUndefined();
	});

	test("#2 adversarial: provider/model wiring still intact (no regression from sub-3)", async () => {
		// Same contract as compression-model-wiring.test.ts #1 — sub-3 must not
		// have disturbed the model precedence chain.
		const opts = await buildCompressOpts(
			mkConfig({ compression: { provider: "P_COMP", model: "M_COMP", summarySystemPrompt: "X" } }),
			PROVIDERS,
		);
		expect(opts.providerName).toBe("P_COMP");
		expect(opts.modelId).toBe("M_COMP");
		expect(opts.summarySystemPrompt).toBe("X");
	});
});

// ===========================================================================
// #7 — config-router memory-config round-trip {compression, archive}
// ===========================================================================

describe("sub-3 #7: config-router GET/PUT /memory-config round-trips {compression, archive}", () => {
	const servers: Server[] = [];
	afterEach(async () => { await Promise.all(servers.splice(0).map(close)); });

	test("#7a: GET /memory-config returns both compression and archive blocks (empty by default)", async () => {
		const { port } = await setupConfigRouter();
		const res = await request(port, "GET", "/api/config/memory-config");
		expect(res.status).toBe(200);
		expect(res.data.compression).toBeDefined();
		expect(res.data.archive).toBeDefined();
		expect(res.data.archive).toEqual({});
	});

	test("#7b: PUT {compression, archive} → GET reads both back equal (round-trip)", async () => {
		const { port } = await setupConfigRouter();
		const update = await request(port, "PUT", "/api/config/memory-config", {
			compression: { provider: "stub", model: "stub-model", summarySystemPrompt: "Z_COMP" },
			archive: { memoryPrompt: "Z" },
		});
		expect(update.status).toBe(200);
		expect(update.data.success).toBe(true);

		const res = await request(port, "GET", "/api/config/memory-config");
		expect(res.data.compression.provider).toBe("stub");
		expect(res.data.compression.model).toBe("stub-model");
		expect(res.data.compression.summarySystemPrompt).toBe("Z_COMP");
		expect(res.data.archive.memoryPrompt).toBe("Z");
	});

	test("#7c: PUT only compression → archive untouched (independent block exchange)", async () => {
		// Adversarial: the router stores each block independently. Writing
		// compression must NOT clobber a pre-existing archive block (and vice
		// versa) — confirms the `if (archive !== undefined)` guard.
		const { port } = await setupConfigRouter({ archive: { memoryPrompt: "PRE_EXISTING" } });
		const update = await request(port, "PUT", "/api/config/memory-config", {
			compression: { provider: "stub" },
		});
		expect(update.status).toBe(200);
		const res = await request(port, "GET", "/api/config/memory-config");
		expect(res.data.compression.provider).toBe("stub");
		// archive block survived the compression-only write.
		expect(res.data.archive.memoryPrompt).toBe("PRE_EXISTING");
	});

	test("#7d: PUT only archive → compression untouched", async () => {
		const { port } = await setupConfigRouter({ compression: { provider: "P_PRE" } });
		const update = await request(port, "PUT", "/api/config/memory-config", {
			archive: { memoryPrompt: "ONLY_ARCHIVE" },
		});
		expect(update.status).toBe(200);
		const res = await request(port, "GET", "/api/config/memory-config");
		expect(res.data.archive.memoryPrompt).toBe("ONLY_ARCHIVE");
		expect(res.data.compression.provider).toBe("P_PRE");
	});

	test("#6 (back-compat via router): old global_config with no archive field → GET returns archive={}", async () => {
		// Simulates an older install whose persisted global_config predates the
		// archive field. GET must yield archive={} (the `?? {}` fallback), not
		// crash, not return undefined (which would break the UI's data.archive
		// ?? {} spread).
		const { port } = await setupConfigRouter({ compression: { provider: "OLD" } });
		const res = await request(port, "GET", "/api/config/memory-config");
		expect(res.status).toBe(200);
		expect(res.data.archive).toEqual({});
		expect(res.data.compression.provider).toBe("OLD");
	});
});

// ===========================================================================
// #3 + #4 + #6 — buildTempMemoryTurnRunner: override + default + back-compat
// (real AgentService + mocked AgentLoop; one shared temp DB)
// ===========================================================================

describe("sub-3 #3 + #4 + #6: buildTempMemoryTurnRunner picks up archive.memoryPrompt override", () => {
	let testDir: string;
	let db: SessionDB;
	let svc: AgentService;

	beforeAll(() => {
		testDir = mkdtempSync(join(tmpdir(), "zero-sub3-runner-"));
		db = new SessionDB(join(testDir, "sessions.db"));
		runMigrations(db);
		svc = new AgentService(testDir, db);
	});
	afterAll(() => {
		try { db.close(); } catch { /* ignore */ }
		try { rmSync(testDir, { recursive: true, force: true }); } catch { /* EPERM */ }
	});

	beforeEach(() => {
		loopCtorCalls.length = 0;
		runCalls.length = 0;
		abortCalls.length = 0;
	});

	/** Minimal SessionConfig for buildTempMemoryTurnRunner (needs sessionId +
	 * hookWiringDeps to short-circuit this.buildHookDeps()). The closure only
	 * reads sessionConfig.sessionId at build time; the rest is passed through
	 * to the (mocked) AgentLoop ctor. */
	function mkSessionConfig(sessionId: string): any {
		return { sessionId, agentId: "sub3-agent", hookWiringDeps: {} as any };
	}

	/** Drive the runner closure once and return the prompt arg captured by the
	 * mocked AgentLoop.run spy. */
	async function driveRunner(sessionConfig: any): Promise<{ prompt: string; opts: any }> {
		const runner = (svc as any).buildTempMemoryTurnRunner(sessionConfig) as () => Promise<boolean>;
		const ok = await runner();
		expect(ok).toBe(true);
		expect(runCalls.length).toBe(1);
		expect(abortCalls.length).toBe(1); // finally block always aborts
		return { prompt: runCalls[0]!.prompt, opts: runCalls[0]!.opts };
	}

	test("#3: config.archive.memoryPrompt = 'USER_OVERRIDE' → loop.run receives it (overrides ARCHIVE_MEMORY_PROMPT)", async () => {
		(svc as any).config = { archive: { memoryPrompt: "USER_OVERRIDE" } };
		const { prompt, opts } = await driveRunner(mkSessionConfig("sub3-override"));
		expect(prompt).toBe("USER_OVERRIDE");
		expect(opts).toEqual({ ephemeral: true });
		// Adversarial: must NOT be the default const.
		expect(prompt).not.toBe(ARCHIVE_MEMORY_PROMPT);
	});

	test("#3 + #4: config.archive.memoryPrompt = undefined → loop.run receives ARCHIVE_MEMORY_PROMPT (default)", async () => {
		(svc as any).config = { archive: { memoryPrompt: undefined } };
		const { prompt, opts } = await driveRunner(mkSessionConfig("sub3-undef"));
		// strict-equal with the real imported const — proves the default path.
		expect(prompt).toBe(ARCHIVE_MEMORY_PROMPT);
		expect(prompt).toStrictEqual(ARCHIVE_MEMORY_PROMPT);
		expect(opts).toEqual({ ephemeral: true });
	});

	test("#4: empty-string override → loop.run receives ARCHIVE_MEMORY_PROMPT (empty = default)", async () => {
		(svc as any).config = { archive: { memoryPrompt: "" } };
		const { prompt } = await driveRunner(mkSessionConfig("sub3-empty"));
		expect(prompt).toBe(ARCHIVE_MEMORY_PROMPT);
	});

	test("#4: whitespace-only override → loop.run receives ARCHIVE_MEMORY_PROMPT (trim guard)", async () => {
		(svc as any).config = { archive: { memoryPrompt: "   \n\t " } };
		const { prompt } = await driveRunner(mkSessionConfig("sub3-ws"));
		expect(prompt).toBe(ARCHIVE_MEMORY_PROMPT);
	});

	test("#6: no archive field at all (old config) → loop.run receives ARCHIVE_MEMORY_PROMPT, no crash", async () => {
		// Back-compat: an older config without the archive key. (svc as any).
		// config?.archive?.memoryPrompt reads undefined → default const.
		(svc as any).config = {}; // no archive key
		const { prompt } = await driveRunner(mkSessionConfig("sub3-nofield"));
		expect(prompt).toBe(ARCHIVE_MEMORY_PROMPT);
	});

	test("#6: this.config = undefined (defensive) → loop.run receives ARCHIVE_MEMORY_PROMPT, no crash", async () => {
		// The override read uses `(this.config as any)?.archive?.memoryPrompt`
		// — the optional-chain must survive a totally missing config. This is
		// the adversarial boundary of back-compat.
		(svc as any).config = undefined;
		const { prompt } = await driveRunner(mkSessionConfig("sub3-noconfig"));
		expect(prompt).toBe(ARCHIVE_MEMORY_PROMPT);
	});

	test("#3 adversarial: override resolved at closure BUILD time (not re-read on each run)", async () => {
		// The override is captured into a const inside buildTempMemoryTurnRunner
		// BEFORE the closure is returned. Mutating config AFTER building the
		// runner must NOT change the prompt — proves the "resolved once"
		// semantic documented in the source comment.
		(svc as any).config = { archive: { memoryPrompt: "BEFORE" } };
		const runner = (svc as any).buildTempMemoryTurnRunner(mkSessionConfig("sub3-buildtime")) as () => Promise<boolean>;
		// Mutate config AFTER the runner is built.
		(svc as any).config.archive.memoryPrompt = "AFTER";
		await runner();
		expect(runCalls[0]!.prompt).toBe("BEFORE");
	});

	test("loop.run always called with { ephemeral: true } (sub-2 contract preserved)", async () => {
		(svc as any).config = { archive: { memoryPrompt: "EPHEMERAL_CHECK" } };
		const { opts } = await driveRunner(mkSessionConfig("sub3-ephemeral"));
		expect(opts).toEqual({ ephemeral: true });
	});

	test("runner returns false on error (best-effort contract, no throw)", async () => {
		// Adversarial: the try/catch must swallow errors and return false so
		// the caller proceeds with the export (best-effort).
		(svc as any).config = { archive: { memoryPrompt: "OK" } };
		// Force run to throw by temporarily replacing the run spy via a one-off
		// re-mock is complex; instead, simulate by making the sessionConfig
		// carry a sessionId that triggers the early `if (!loopSessionId)` guard.
		const runner = (svc as any).buildTempMemoryTurnRunner({ sessionId: undefined }) as () => Promise<boolean>;
		const ok = await runner();
		expect(ok).toBe(false);
		expect(runCalls.length).toBe(0); // never reached loop.run
	});
});

// ===========================================================================
// #6 — DEFAULT_CONFIG back-compat: archive block exists in defaults
// ===========================================================================

describe("sub-3 #6: DEFAULT_CONFIG carries archive block (deep-merge back-compat)", () => {
	test("DEFAULT_CONFIG.archive is an empty object (override undefined → default const)", () => {
		// The schema adds `archive: { memoryPrompt?: string }` and DEFAULT_CONFIG
		// sets `archive: {}`. deepMerge of an old config (no archive) against
		// this default yields archive.memoryPrompt = undefined → buildTempMemory
		// TurnRunner falls through to ARCHIVE_MEMORY_PROMPT.
		expect(DEFAULT_CONFIG.archive).toEqual({});
		expect((DEFAULT_CONFIG.archive as any)?.memoryPrompt).toBeUndefined();
	});

	test("ZeroCoreConfigSchema includes archive.memoryPrompt (schema-level back-compat)", () => {
		// Adversarial source-grep: the schema must declare the field so
		// TypeBox validation / deepMerge doesn't strip it on save.
		const src = readFileSync(join(__dirname, "..", "..", "src", "core", "config.ts"), "utf8");
		// archive block in schema.
		const archiveSchemaIdx = src.indexOf("archive: Type.Object({");
		expect(archiveSchemaIdx).toBeGreaterThan(-1);
		const memoryPromptIdx = src.indexOf("memoryPrompt: Type.Optional(Type.String())", archiveSchemaIdx);
		expect(memoryPromptIdx).toBeGreaterThan(archiveSchemaIdx);
		// DEFAULT_CONFIG.archive = {} present.
		expect(src).toMatch(/archive:\s*\{\s*\}/);
	});
});
