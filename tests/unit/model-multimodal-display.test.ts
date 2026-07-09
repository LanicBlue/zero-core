// 单元测试: multimodal-input sub-6 (模型模态显示)
//
// # 文件说明书
//
// ## 核心功能
// 验证 context-usage 旁模态标识的完整数据通路:
//   1. provider-factory.getMultimodalTri: tri-state 解析(true/false/undefined),
//      与 D3 路径 getMultimodal(布尔,undefined→false)对照。
//   2. AgentLoop.getModelMultimodalTri: 委托 getMultimodalTri(读当前 config 的
//      provider/model),与 getModelId 同路径。
//   3. ProviderStore.updateModel: 手填 multimodal 持久化到 ProviderModel
//      (覆盖 OpenRouter 未覆盖的模型;真实 SessionDB)。
//   4. chat-store ContextInfo.modelMultimodal: 字段流转 + updateContextInfo
//      merge 语义(streaming token 刷新不覆盖)。
//
// ## 范围
// - sessionsGetInit payload 的 modelMultimodal 字段(agent-service 静态类型已加,
//   payload 构造调用 loop.getModelMultimodalTri;此处经 AgentLoop getter 间接覆盖)。
// - ContextInfo.modelMultimodal 三态(true 显示 image / undefined 显示未知 /
//   false 不显标识)由 ChatPanel 渲染分支保证,本测聚焦数据层。
//
// ## 不做
// - ChatPanel DOM 渲染(sub-7 E2E)。
// - getMessages inline 路径(sub-3 已覆盖)。

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getMultimodal, getMultimodalTri } from "../../src/runtime/provider-factory.js";
import type { RuntimeProviderConfig } from "../../src/runtime/types.js";
import { SessionDB } from "../../src/server/session-db.js";
import { ProviderStore } from "../../src/server/provider-store.js";
import { runMigrations } from "../../src/server/db-migration.js";
import {
	useChatStore,
	selectContextInfo,
} from "../../src/renderer/store/chat-store.js";
import type { ContextInfo } from "../../src/renderer/store/chat-store.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<RuntimeProviderConfig> = {}): RuntimeProviderConfig {
	return {
		name: "TestProvider",
		type: "mock",
		apiKey: "test-key",
		baseUrl: "fixture",
		enabled: true,
		models: [{ id: "test-model", name: "Test", contextWindow: 64000 }],
		...overrides,
	} as RuntimeProviderConfig;
}

// ── 1. provider-factory.getMultimodalTri ────────────────────────────────────

describe("sub-6: getMultimodalTri (tri-state image capability)", () => {
	test("returns true when model.multimodal === true", () => {
		const providers = [makeProvider({
			models: [{ id: "vision-model", name: "Vision", contextWindow: 128000, multimodal: true }],
		})];
		expect(getMultimodalTri(providers, "TestProvider", "vision-model")).toBe(true);
	});

	test("returns false when model.multimodal === false (explicit)", () => {
		const providers = [makeProvider({
			models: [{ id: "text-model", name: "Text", contextWindow: 128000, multimodal: false }],
		})];
		expect(getMultimodalTri(providers, "TestProvider", "text-model")).toBe(false);
	});

	test("returns undefined when model.multimodal is unset (manually configured / OpenRouter-uncovered)", () => {
		// No multimodal field at all — the default for hand-added models.
		const providers = [makeProvider({
			models: [{ id: "manual-model", name: "Manual", contextWindow: 128000 }],
		})];
		expect(getMultimodalTri(providers, "TestProvider", "manual-model")).toBeUndefined();
	});

	test("returns undefined when model not found in provider", () => {
		const providers = [makeProvider()];
		expect(getMultimodalTri(providers, "TestProvider", "missing-model")).toBeUndefined();
	});

	test("returns undefined when provider not found", () => {
		const providers = [makeProvider()];
		expect(getMultimodalTri(providers, "OtherProvider", "any")).toBeUndefined();
	});

	test("differs from D3-path getMultimodal for undefined (which merges to false)", () => {
		const providers = [makeProvider({
			models: [{ id: "manual-model", name: "Manual", contextWindow: 128000 }],
		})];
		// Tri-state preserves undefined for UI; D3 boolean path coalesces to false
		// (safe default → meta-info injection). The two functions MUST disagree
		// here — that's the whole point of the split (UI needs 3 states, getMessages
		// needs a boolean).
		expect(getMultimodalTri(providers, "TestProvider", "manual-model")).toBeUndefined();
		expect(getMultimodal(providers, "TestProvider", "manual-model")).toBe(false);
	});

	test("agrees with D3-path getMultimodal for explicit true/false", () => {
		const providers = [makeProvider({
			models: [
				{ id: "vision", name: "V", contextWindow: 128000, multimodal: true },
				{ id: "text", name: "T", contextWindow: 128000, multimodal: false },
			],
		})];
		expect(getMultimodalTri(providers, "TestProvider", "vision")).toBe(true);
		expect(getMultimodal(providers, "TestProvider", "vision")).toBe(true);
		expect(getMultimodalTri(providers, "TestProvider", "text")).toBe(false);
		expect(getMultimodal(providers, "TestProvider", "text")).toBe(false);
	});

	test("normalizes provider name (case/space insensitive), same as getMultimodal", () => {
		const providers = [makeProvider({
			name: "OpenAI",
			models: [{ id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, multimodal: true }],
		})];
		// provider-factory normalizes names; tri-state rides the same path.
		expect(getMultimodalTri(providers, "openai", "gpt-4o")).toBe(true);
		expect(getMultimodal(providers, "openai", "gpt-4o")).toBe(true);
	});
});

// ── 2. AgentLoop.getModelMultimodalTri ──────────────────────────────────────
// Drives the real provider-factory (no mock) so the getter's delegation is
// exercised end-to-end. The loop is constructed with providers carrying
// multimodal; the getter reads this.config's provider/model.

describe("sub-6: AgentLoop.getModelMultimodalTri delegates to getMultimodalTri", () => {
	let tmpDir: string;
	let sessionDB: SessionDB;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-mm-loop-"));
		sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
		runMigrations(sessionDB);
	});

	afterEach(() => {
		sessionDB.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns raw multimodal for the loop's current model", async () => {
		const { AgentLoop } = await import("../../src/runtime/agent-loop.js");
		const providers: RuntimeProviderConfig[] = [makeProvider({
			name: "TestProvider",
			models: [
				{ id: "vision", name: "V", contextWindow: 128000, multimodal: true },
				{ id: "text", name: "T", contextWindow: 128000, multimodal: false },
				{ id: "manual", name: "M", contextWindow: 128000 },
			],
		})];
		const makeConfig = (modelId: string) => ({
			agentId: "mm-agent", workspaceDir: tmpDir, systemPrompt: "x",
			modelId, providerName: "TestProvider", sessionId: "mm-session",
			db: sessionDB as any, toolPolicy: { tools: {} },
		} as any);
		const callbacks = { onEvent: () => {} };

		const loopVision = new AgentLoop(makeConfig("vision"), providers, callbacks as any);
		expect(loopVision.getModelMultimodalTri()).toBe(true);
		const loopText = new AgentLoop(makeConfig("text"), providers, callbacks as any);
		expect(loopText.getModelMultimodalTri()).toBe(false);
		const loopManual = new AgentLoop(makeConfig("manual"), providers, callbacks as any);
		expect(loopManual.getModelMultimodalTri()).toBeUndefined();
	});
});

// ── 3. ProviderStore.updateModel (hand-set multimodal persistence) ──────────

describe("sub-6: ProviderStore.updateModel persists hand-set multimodal", () => {
	let tmpDir: string;
	let sessionDB: SessionDB;
	let store: ProviderStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "zero-mm-store-"));
		sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
		runMigrations(sessionDB);
		store = new ProviderStore(sessionDB);
	});

	afterEach(() => {
		sessionDB.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("patches multimodal=true onto a model that had none (OpenRouter-uncovered)", () => {
		const created = store.create({
			name: "ManualProvider", type: "openai-compatible", apiKey: "k",
			baseUrl: "http://x", enabled: true, isSystem: false,
			models: [{ id: "manual-1", name: "Manual 1", contextWindow: 32000 }],
		} as any);
		const before = created.models.find((m) => m.id === "manual-1");
		expect(before?.multimodal).toBeUndefined();

		const updated = store.updateModel(created.id, "manual-1", { multimodal: true });
		const after = updated.models.find((m) => m.id === "manual-1");
		expect(after?.multimodal).toBe(true);
		// Other fields preserved.
		expect(after?.name).toBe("Manual 1");
		expect(after?.contextWindow).toBe(32000);
	});

	test("flips multimodal from true to false", () => {
		const created = store.create({
			name: "P2", type: "openai-compatible", apiKey: "k",
			baseUrl: "http://x", enabled: true, isSystem: false,
			models: [{ id: "m", name: "M", contextWindow: 8000, multimodal: true }],
		} as any);
		const updated = store.updateModel(created.id, "m", { multimodal: false });
		expect(updated.models.find((mm) => mm.id === "m")?.multimodal).toBe(false);
	});

	test("persists across store reload (real DB round-trip)", () => {
		const created = store.create({
			name: "P3", type: "openai-compatible", apiKey: "k",
			baseUrl: "http://x", enabled: true, isSystem: false,
			models: [{ id: "persist-m", name: "Persist", contextWindow: 16000 }],
		} as any);
		store.updateModel(created.id, "persist-m", { multimodal: true });

		// New store instance over the same DB file → reads persisted value.
		const reloaded = new ProviderStore(sessionDB);
		const provider = reloaded.get(created.id);
		expect(provider?.models.find((m) => m.id === "persist-m")?.multimodal).toBe(true);
	});

	test("does not mutate the model id (immutable identity)", () => {
		const created = store.create({
			name: "P4", type: "openai-compatible", apiKey: "k",
			baseUrl: "http://x", enabled: true, isSystem: false,
			models: [{ id: "id-stable", name: "Stable", contextWindow: 4000 }],
		} as any);
		// Even if a rogue patch tried to change id, updateModel must preserve it.
		const updated = store.updateModel(created.id, "id-stable", { id: "tampered", multimodal: true } as any);
		const model = updated.models.find((m) => m.name === "Stable");
		expect(model?.id).toBe("id-stable");
		expect(model?.multimodal).toBe(true);
	});

	test("throws when model not found", () => {
		const created = store.create({
			name: "P5", type: "openai-compatible", apiKey: "k",
			baseUrl: "http://x", enabled: true, isSystem: false,
			models: [],
		} as any);
		expect(() => store.updateModel(created.id, "nope", { multimodal: true })).toThrow(/Model not found/);
	});
});

// ── 4. chat-store ContextInfo.modelMultimodal flow ──────────────────────────

describe("sub-6: ContextInfo.modelMultimodal field flow", () => {
	function reset() {
		useChatStore.setState({
			contextInfoBySession: {},
			activeSessionId: null,
		});
	}

	beforeEach(reset);

	test("updateContextInfo sets modelMultimodal (tri-state preserved)", () => {
		reset();
		useChatStore.getState().updateContextInfo("s1", {
			modelMultimodal: true,
			contextWindow: 128000,
			usage: 0,
			usedTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		});
		let ci: ContextInfo | null = selectContextInfo(useChatStore.getState());
		expect(ci).toBeNull(); // no activeSessionId yet → selector returns null

		useChatStore.setState({ activeSessionId: "s1" });
		ci = selectContextInfo(useChatStore.getState());
		expect(ci?.modelMultimodal).toBe(true);
	});

	test("undefined passes through (UI renders 模态未知)", () => {
		reset();
		useChatStore.getState().updateContextInfo("s2", { modelMultimodal: undefined });
		useChatStore.setState({ activeSessionId: "s2" });
		// undefined must round-trip as undefined (NOT coalesced to false), so the
		// ChatPanel branch `=== undefined` fires for the 模态未知 badge.
		expect(selectContextInfo(useChatStore.getState())?.modelMultimodal).toBeUndefined();
	});

	test("false passes through (UI renders no badge)", () => {
		reset();
		useChatStore.getState().updateContextInfo("s3", { modelMultimodal: false });
		useChatStore.setState({ activeSessionId: "s3" });
		expect(selectContextInfo(useChatStore.getState())?.modelMultimodal).toBe(false);
	});

	test("merge semantics: streaming token refresh does NOT clobber modelMultimodal", () => {
		// Mirrors the existing `model` field invariant — message_end/usage events
		// don't carry modelMultimodal, so a replace would lose it. updateContextInfo
		// merges (Partial<ContextInfo>); omitting modelMultimodal preserves it.
		reset();
		useChatStore.getState().updateContextInfo("s4", { modelMultimodal: true, contextWindow: 128000 });
		// Simulate a streaming token refresh that only carries token counts.
		useChatStore.getState().updateContextInfo("s4", {
			inputTokens: 500, outputTokens: 200, totalTokens: 700, usage: 0.5,
		});
		useChatStore.setState({ activeSessionId: "s4" });
		const ci = selectContextInfo(useChatStore.getState());
		expect(ci?.modelMultimodal).toBe(true); // preserved
		expect(ci?.inputTokens).toBe(500); // updated
	});

	test("payload shape: sessionsGetInit-style object maps cleanly onto ContextInfo", () => {
		// This is the contract between agent-service.getSessionInitPayload and
		// the renderer. The payload carries modelMultimodal (tri-state); the
		// ChatPanel pull effect forwards it verbatim to updateContextInfo.
		reset();
		const payload = {
			modelMultimodal: undefined,
			contextWindow: 200000,
			contextUsage: 0.1,
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 150,
			model: { providerName: "Anthropic", modelId: "claude-3-5" },
		};
		useChatStore.getState().updateContextInfo("s5", {
			usedTokens: payload.inputTokens,
			contextWindow: payload.contextWindow,
			usage: payload.contextUsage,
			inputTokens: payload.inputTokens,
			outputTokens: payload.outputTokens,
			totalTokens: payload.totalTokens,
			model: payload.model,
			modelMultimodal: payload.modelMultimodal, // pass-through, no coalesce
		});
		useChatStore.setState({ activeSessionId: "s5" });
		const ci = selectContextInfo(useChatStore.getState());
		expect(ci?.modelMultimodal).toBeUndefined();
		expect(ci?.model?.modelId).toBe("claude-3-5");
		expect(ci?.contextWindow).toBe(200000);
	});
});
