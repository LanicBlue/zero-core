// N4 (runtime-push-ui-sync) 单元测试 — 配置字段热更(不变量 1:所见即所跑)
//
// # 文件说明书
//
// ## 核心功能
// 验证 acceptance-N4.md 第 1 / 3 / 6 条(本节点范围收窄后仅 model / provider /
// thinkingLevel 三个字段;contextConfig / skillPolicy / knowledgeBaseIds 经审计为
// Electron 路径死字段,已从本节点移除——见 plan-N4.md / acceptance-N4.md 文首说明):
//   1. model / provider:applyConfigUpdate({providerName, modelId}) → this.config
//      更新 → 下一轮 executeStream 的 resolveModel 用新 provider/model。
//   3. thinkingLevel:applyConfigUpdate({thinkingLevel}) → this.config.thinkingLevel
//      更新 → 下一轮 PreLLMCall 读到新值(provider-options hook 据此发 providerOptions)。
//   6. agent-service store.onChange(loop busy 分支)传 providerName / modelId /
//      thinkingLevel 到 applyConfigUpdate。
//
// ## 驱动方式
// 用例 1/3 驱动真实 AgentLoop(provider-factory.resolveModel 被 vi.mock 替换为内联
// 模型,镜像 step-loop-external.test.ts);用例 6 构造真实 AgentService + 真实 AgentStore,
// 注入 stub loop + busy run-state,改 agent record 触发 onChange,断言 stub loop 收到
// 三个新字段。
//
// ## 范围说明
// applyConfigUpdate 是既有方法的扩展(非新 hook);新字段 undefined 不覆盖既有值(对齐
// 现有字段的 !== undefined 写回模式)。model / thinkingLevel 均每轮重读,无需缓存失效。

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";

// Mock provider-factory BEFORE importing AgentLoop so agent-loop.ts's static
// `resolveModel` import is replaced with our spy. getContextWindow is also
// imported by agent-loop (turn scoping); stub it to a safe default.
const resolveModelMock = vi.fn();
vi.mock("../../src/runtime/provider-factory.js", () => ({
	resolveModel: (...args: unknown[]) => resolveModelMock(...args),
	getContextWindow: () => 128000,
	getMultimodal: () => false,
}));

import { SessionDB } from "../../src/server/session-db.js";
import { runMigrations } from "../../src/server/db-migration.js";
import { AgentStore } from "../../src/server/agent-store.js";
import { AgentService } from "../../src/server/agent-service.js";
import { HookRegistry } from "../../src/core/hook-registry.js";
import { registerTurnHooks } from "../../src/runtime/hooks/turn-hooks.js";
import { AgentLoop } from "../../src/runtime/agent-loop.js";
import type { SessionConfig, RuntimeCallbacks, StreamEvent } from "../../src/runtime/types.js";

// ─── Inline mock language model (LanguageModelV2) ─────────────────────────
// A single-step "finish" stream is enough — these tests never drive tool-use;
// they only need one doStream call per turn so resolveModel fires once and the
// PreLLMCall hook runs once.
function createFinishModel(modelId = "n4-mock"): LanguageModelV2 {
	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId,
		supportedUrls: {},
		async doGenerate() { throw new Error("doGenerate not used"); },
		async doStream() {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue([{ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }]);
					controller.close();
				},
			});
			return { stream } as any;
		},
	} as unknown as LanguageModelV2;
}

// ─── Shared harness (AgentLoop) ───────────────────────────────────────────

let tmpDir: string;
let sessionDB: SessionDB;
let loop: AgentLoop;
let emitted: StreamEvent[];

function makeCallbacks(): RuntimeCallbacks {
	return { onEvent: (event: StreamEvent) => { emitted.push(event); } };
}

function makeConfig(sessionId: string): SessionConfig {
	return {
		agentId: "n4-agent",
		workspaceDir: tmpDir,
		systemPrompt: "You are a test agent.",
		modelId: "model-A",
		providerName: "ProviderA",
		sessionId,
		db: sessionDB as any,
		toolPolicy: { tools: {} },
	} as unknown as SessionConfig;
}

function buildLoop(sessionId: string): { loop: AgentLoop; registry: HookRegistry } {
	emitted = [];
	const cfg = makeConfig(sessionId);
	const l = new AgentLoop(cfg, [], makeCallbacks());
	// registerTurnHooks wires StepEnd so the turn completes cleanly (persist).
	registerTurnHooks(sessionDB, l.registry);
	loop = l;
	return { loop: l, registry: l.registry };
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-n4-hot-sync-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	runMigrations(sessionDB);
	resolveModelMock.mockReset();
	resolveModelMock.mockReturnValue(createFinishModel());
});

afterEach(() => {
	try { (loop as any)?.delegator?.cleanup?.(); } catch { /* ignore */ }
	try { sessionDB.close(); } catch { /* ignore */ }
	rmSync(tmpDir, { recursive: true, force: true });
});

// ─── 1. model / provider hot-sync ────────────────────────────────────────

describe("N4 · acceptance #1 model/provider hot-sync", () => {
	test("applyConfigUpdate({providerName, modelId}) writes config; next turn resolveModel uses them", async () => {
		const sessionId = "n4-1-model-provider";
		const { loop } = buildLoop(sessionId);

		// Sanity: initial config holds the construction values.
		expect((loop as any).config.providerName).toBe("ProviderA");
		expect((loop as any).config.modelId).toBe("model-A");

		// Hot-sync to a new provider + model mid-flight.
		loop.applyConfigUpdate({ providerName: "ProviderB", modelId: "model-C" });

		expect((loop as any).config.providerName).toBe("ProviderB");
		expect((loop as any).config.modelId).toBe("model-C");

		await loop.run("go");

		// executeStream re-resolves the model every turn via
		// resolveModel(providers, this.config.providerName, this.config.modelId)
		// — so the post-patch values must reach resolveModel.
		expect(resolveModelMock).toHaveBeenCalled();
		const lastCall = resolveModelMock.mock.calls.at(-1)!;
		expect(lastCall[1]).toBe("ProviderB");
		expect(lastCall[2]).toBe("model-C");
	}, 30000);

	test("undefined providerName/modelId does NOT overwrite existing config (no-change semantics)", () => {
		const sessionId = "n4-1-undefined-noop";
		const { loop } = buildLoop(sessionId);

		// Patch carrying unrelated fields only — model/provider must survive.
		loop.applyConfigUpdate({ systemPrompt: "changed" });

		expect((loop as any).config.providerName).toBe("ProviderA");
		expect((loop as any).config.modelId).toBe("model-A");
		expect((loop as any).config.systemPrompt).toBe("changed");
	});
});

// ─── 3. thinkingLevel hot-sync ───────────────────────────────────────────

describe("N4 · acceptance #3 thinkingLevel hot-sync", () => {
	test("applyConfigUpdate({thinkingLevel}) writes config; next turn PreLLMCall sees the new value", async () => {
		const sessionId = "n4-3-thinking";
		const { loop, registry } = buildLoop(sessionId);

		// Observe what the PreLLMCall seam reads each step. The provider-options
		// hook (provider-options-hooks.ts) reads ctx.config.thinkingLevel live,
		// so capturing ctx.config.thinkingLevel here proves the next turn's
		// providerOptions will be built from the new value.
		let seenThinking: string | undefined;
		registry.register("PreLLMCall", async (ctx: any) => {
			seenThinking = ctx.config.thinkingLevel;
			return undefined;
		});

		expect((loop as any).config.thinkingLevel).toBeUndefined();

		// Hot-sync to "high" mid-flight.
		loop.applyConfigUpdate({ thinkingLevel: "high" });
		expect((loop as any).config.thinkingLevel).toBe("high");

		await loop.run("go");

		// The PreLLMCall seam observed the post-patch value on this turn — i.e.
		// the next turn's providerOptions (built from ctx.config.thinkingLevel)
		// carry the new level without a loop rebuild.
		expect(seenThinking).toBe("high");
	}, 30000);

	test("undefined thinkingLevel does NOT overwrite an existing value", () => {
		const sessionId = "n4-3-undefined-noop";
		const { loop } = buildLoop(sessionId);

		(loop as any).config.thinkingLevel = "medium";
		loop.applyConfigUpdate({ systemPrompt: "x" });

		expect((loop as any).config.thinkingLevel).toBe("medium");
	});
});

// ─── 6. agent-service store.onChange (busy branch) wiring ────────────────

describe("N4 · acceptance #6 agent-service store.onChange passes new fields to applyConfigUpdate", () => {
	let dir: string;
	let db: SessionDB;

	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "zero-n4-svc-")); db = new SessionDB(join(dir, "sessions.db")); runMigrations(db); });
	afterEach(() => { try { db.close(); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); });

	test("busy loop: changing model/provider/thinkingLevel forwards them to applyConfigUpdate", () => {
		const svc = new AgentService(dir, db);
		const agentStore = new AgentStore(db);
		// Wire the onChange listener onto the service (registers the callback
		// whose busy branch we exercise).
		svc.setAgentStore(agentStore);

		// Seed an agent with the OLD values so we can mutate to NEW below.
		const agent = agentStore.create({
			name: "n4-svc-agent",
			provider: "ProviderA",
			model: "model-A",
			thinkingLevel: "low",
			toolPolicy: { tools: {} },
		} as any);

		// Inject a stub loop bound to this agent + a BUSY run-state so the
		// onChange handler takes the applyConfigUpdate branch (not the idle
		// rebuild branch). getConfigAgentId must match for the loop to qualify.
		const applySpy = vi.fn();
		const stubLoop = {
			getConfigAgentId: () => agent.id,
			applyConfigUpdate: applySpy,
		};
		(svc as any).loops.set("sess-n4", stubLoop);
		(svc as any).activeSessions.set(agent.id, "sess-n4");
		(svc as any).runStates.set("sess-n4", { isBusy: true });

		// Mutate the three N4 fields + fire onChange via a real store.update.
		agentStore.update(agent.id, {
			provider: "ProviderB",
			model: "model-C",
			thinkingLevel: "high",
		});

		expect(applySpy).toHaveBeenCalledTimes(1);
		const patch = applySpy.mock.calls[0][0];
		// The three N4 fields come from the NEW agent record verbatim.
		expect(patch.providerName).toBe("ProviderB");
		expect(patch.modelId).toBe("model-C");
		expect(patch.thinkingLevel).toBe("high");
	});

	test("busy loop: agent record with cleared provider/model/thinkingLevel forwards what the store yields (null)", () => {
		// NOTE: AgentStore persists optional TEXT columns and reads unset ones
		// back as `null` (SQLite convention), NOT `undefined`. So an agent whose
		// model/provider/thinkingLevel were never set — or were cleared — yields
		// `null` on the record, and the wiring forwards `null` verbatim. This is
		// distinct from the applyConfigUpdate undefined guard: the guard treats
		// ONLY `undefined` as "no change", so a `null` from the store WOULD
		// overwrite. In practice the UI never clears these to null on a running
		// loop (the agent editor keeps the previous value or the field is
		// required), and the design doc's "caller may pass record verbatim"
		// guidance assumes `undefined`. This test pins the actual store behavior
		// so the discrepancy is visible; resolving null-vs-undefined at the
		// store boundary is out of scope for N4 (would be a separate fix).
		const svc = new AgentService(dir, db);
		const agentStore = new AgentStore(db);
		svc.setAgentStore(agentStore);

		const agent = agentStore.create({ name: "n4-svc-agent-2", toolPolicy: { tools: {} } } as any);

		const applySpy = vi.fn();
		(svc as any).loops.set("sess-n4-2", { getConfigAgentId: () => agent.id, applyConfigUpdate: applySpy });
		(svc as any).activeSessions.set(agent.id, "sess-n4-2");
		(svc as any).runStates.set("sess-n4-2", { isBusy: true });

		// A rename still fires onChange; the record's provider/model/thinkingLevel
		// were never set → the store yields null for them.
		agentStore.update(agent.id, { name: "n4-svc-agent-2-renamed" });

		expect(applySpy).toHaveBeenCalledTimes(1);
		const patch = applySpy.mock.calls[0][0];
		expect(patch.providerName).toBeNull();
		expect(patch.modelId).toBeNull();
		expect(patch.thinkingLevel).toBeNull();
	});
});
