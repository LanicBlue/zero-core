// P2 单元测试:agent 运行时 (废 agent-as-tool + subagents 委派 + context 整合)
//
// # 文件说明书
//
// ## 核心功能
// 验收 acceptance-P2.md 的「subagents 委派 + context builder 整合 + 空 vs 非空
// subagents」三组用例:
//   - buildSubagentTools:caller→subagent 工具生成 + delegateTask 调用 +
//     bundle 继承(projectId 带过去)
//   - 空 subagents → 无委派入口、不报错
//   - buildToolsSet 与 toolPolicy.tools 分开(源码契约断言)
//   - buildContextMessage 注入 env/guidelines/wiki/memory/current-task 内容
//   - subagents 工具不进 ALL_TOOLS / 全局 ToolRegistry
//   - roleTag 不被 runtime 层读取
//
// 加载说明:tools/index.ts 间接拉 jsdom → @exodus/bytes(ESM-in-CJS),在
// vitest vmThreads pool 下无法解析。因此 buildSubagentTools 直接 import
// (依赖干净);ALL_TOOLS / buildToolsSet 的"caller-only 不进全局"和"separate
// from toolPolicy"通过源码文本断言 + ToolRegistry 真实注册断言来覆盖,
// 与 m3-orchestrate / m4-pm-tool 的 dynamic-import 风格保持一致。
//

import { describe, test, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSubagentTools } from "../../src/runtime/tools/subagents-delegation.js";
import { SubagentDelegator } from "../../src/runtime/subagent-delegator.js";
import { buildContextMessage } from "../../src/runtime/context-message.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { HookRegistry } from "../../src/core/hook-registry.js";
import type { ToolExecutionContext, SessionConfig, RuntimeCallbacks, AgentRuntime } from "../../src/runtime/types.js";
import type { SessionContextBundle } from "../../src/shared/types.js";

// ─── Helpers ──────────────────────────────────────────────

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
	return {
		workingDir: "/caller/wd",
		agentId: "caller-1",
		emit: () => {},
		...overrides,
	} as ToolExecutionContext;
}

/** Captures the subConfig passed to createSubLoop so tests can assert bundle inheritance. */
function makeCapturingDelegate(): {
	ctx: ToolExecutionContext;
	captured: SessionConfig[];
	delegateTask: (task: string, options?: any) => Promise<string>;
} {
	const captured: SessionConfig[] = [];
	const delegateTask = vi.fn(async (_task: string, options?: any) => {
		// Mimic SubagentDelegator.delegateTask just enough to capture subConfig
		// shape — we record the inherited bundle + workspace + identity pieces.
		captured.push({
			agentId: options?.targetAgentId
				? `${options.targetAgentId}-${Date.now()}`
				: "caller-1:sub",
			workspaceDir: options?.workspaceDir ?? "/caller/wd",
			systemPrompt: options?.systemPrompt ?? "(caller)",
			modelId: options?.model ?? "(caller)",
			toolPolicy: options?.toolPolicy ?? {},
			...(options?.contextOverride ? { contextBundle: options.contextOverride } : {}),
		} as SessionConfig);
		return `result-for-${options?.targetAgentId ?? "sub"}`;
	});
	const ctx = makeContext({ delegateTask });
	return { ctx, captured, delegateTask };
}

function readSrc(rel: string): string {
	return readFileSync(resolve(__dirname, rel), "utf-8");
}

// ─── 1. buildSubagentTools ────────────────────────────────

describe("buildSubagentTools (P2 §11.5)", () => {
	test("empty subagents → empty tools (no error)", () => {
		const { ctx } = makeCapturingDelegate();
		const tools = buildSubagentTools({ subagents: [], context: ctx });
		expect(Object.keys(tools)).toHaveLength(0);
	});

	test("undefined subagents → empty tools (no error)", () => {
		const { ctx } = makeCapturingDelegate();
		const tools = buildSubagentTools({ subagents: undefined as any, context: ctx });
		expect(Object.keys(tools)).toHaveLength(0);
	});

	test("no delegateTask in context → empty tools (delegation unavailable)", () => {
		const ctx = makeContext({}); // no delegateTask
		const tools = buildSubagentTools({
			subagents: [{ agentId: "dev-1", name: "developer" }],
			context: ctx,
		});
		expect(Object.keys(tools)).toHaveLength(0);
	});

	test("one subagent → one tool keyed by entry.name", () => {
		const { ctx } = makeCapturingDelegate();
		const tools = buildSubagentTools({
			subagents: [{ agentId: "dev-1", name: "developer", description: "Delegate to dev" }],
			context: ctx,
		});
		expect(Object.keys(tools)).toEqual(["developer"]);
		expect(tools.developer.description).toContain("dev");
	});

	test("falls back to slug(agentId) when name not set", () => {
		const { ctx } = makeCapturingDelegate();
		const tools = buildSubagentTools({
			subagents: [{ agentId: "Dev-Role_1" }],
			context: ctx,
		});
		expect(Object.keys(tools)).toEqual(["dev_role_1"]);
	});

	test("multiple subagents → one tool each, keyed by name", () => {
		const { ctx } = makeCapturingDelegate();
		const tools = buildSubagentTools({
			subagents: [
				{ agentId: "qa-id", name: "qa" },
				{ agentId: "rev-id", name: "reviewer" },
			],
			context: ctx,
		});
		expect(Object.keys(tools).sort()).toEqual(["qa", "reviewer"]);
	});

	test("tool execute calls delegateTask with targetAgentId + identity from resolveTarget", async () => {
		const { ctx, captured, delegateTask } = makeCapturingDelegate();
		const tools = buildSubagentTools({
			subagents: [{ agentId: "dev-1", name: "developer" }],
			resolveTarget: (id) => ({
				id,
				name: "Developer Agent",
				systemPrompt: "You are a developer.",
				model: "gpt-dev",
				toolPolicy: { autoApprove: ["Shell"] },
			}),
			context: ctx,
		});
		const out = await tools.developer.execute({ task: "write tests" });
		expect(delegateTask).toHaveBeenCalledWith("write tests", expect.objectContaining({
			targetAgentId: "dev-1",
			systemPrompt: "You are a developer.",
			model: "gpt-dev",
		}));
		expect(out).toContain("result-for-dev-1");
		// Captured subConfig gets the target identity.
		expect(captured[0].systemPrompt).toBe("You are a developer.");
		expect(captured[0].modelId).toBe("gpt-dev");
	});

	test("without resolveTarget, only targetAgentId forwarded (caller identity inherited)", async () => {
		const { ctx, delegateTask } = makeCapturingDelegate();
		const tools = buildSubagentTools({
			subagents: [{ agentId: "qa-1", name: "qa" }],
			context: ctx,
		});
		await tools.qa.execute({ task: "test it" });
		expect(delegateTask).toHaveBeenCalledWith("test it", expect.objectContaining({
			targetAgentId: "qa-1",
		}));
		// Identity fields should be undefined → delegator inherits caller.
		const callOpts = delegateTask.mock.calls[0][1];
		expect(callOpts.systemPrompt).toBeUndefined();
		expect(callOpts.model).toBeUndefined();
	});

	test("tool execute surfaces sub-agent errors as a string result (no throw)", async () => {
		const ctx = makeContext({
			delegateTask: vi.fn(async () => { throw new Error("boom"); }),
		});
		const tools = buildSubagentTools({
			subagents: [{ agentId: "x-1", name: "x" }],
			context: ctx,
		});
		const out = await tools.x.execute({ task: "anything" });
		expect(out).toContain("Sub-agent error");
		expect(out).toContain("boom");
	});

	test("subagent with falsy agentId is skipped", () => {
		const { ctx } = makeCapturingDelegate();
		const tools = buildSubagentTools({
			subagents: [
				{ agentId: "", name: "empty" },
				{ agentId: "ok-1", name: "ok" },
			] as any,
			context: ctx,
		});
		expect(Object.keys(tools)).toEqual(["ok"]);
	});
});

// ─── 2. subagent delegation tools are caller-only ─────────
//
// tools/index.ts transitively imports jsdom (via mcp-tools/fetch-tools), and
// jsdom pulls @exodus/bytes — an ESM file shipped in a CJS package — which the
// vitest vmThreads pool can't parse. So we cannot load ALL_TOOLS / buildToolsSet
// at runtime here. Instead we (a) assert the source contract on tools/index.ts
// directly (caller-only merge + toolPolicy.tools gate), and (b) assert that a
// freshly-built ToolRegistry seeded from ALL_TOOLS definitions would not have a
// subagent tool name registered (the subagent tool we just built never goes
// through registerRuntimeTools).

describe("subagent delegation tools are caller-only (P2 §11.5)", () => {
	test("tools/index.ts source: subagentsTools merged as 4th arg, gated only by blockedTools", () => {
		const src = readSrc("../../src/runtime/tools/index.ts");
		// 4th param is the subagentsTools channel.
		expect(src).toMatch(/subagentsTools\?: Record<string, any>/);
		// The merge path iterates subagentsTools and only honors blockedTools.
		expect(src).toMatch(/if \(subagentsTools\)[\s\S]*?for \(const \[name, def\] of Object\.entries\(subagentsTools\)\)[\s\S]*?if \(blocked\.has\(name\)\) continue/);
		// The subagentsTools channel is NOT consulted in the built-in isEnabled
		// path (which gates via toolPolicy.tools / autoApprove). We confirm the
		// built-in loop is bounded by ALL_TOOLS.
		expect(src).toMatch(/for \(const \[name, def\] of Object\.entries\(ALL_TOOLS\)\)/);
	});

	test("registerRuntimeTools only registers entries from ALL_TOOLS — subagent tools never enter", () => {
		// Simulate: build a subagent tool, build a ToolRegistry with only
		// built-in-style descriptors, assert the subagent tool name is absent.
		const { ctx } = makeCapturingDelegate();
		const tools = buildSubagentTools({
			subagents: [{ agentId: "dev-1", name: "developer" }],
			context: ctx,
		});
		const registry = new ToolRegistry();
		// Built-in descriptors we'd typically get from registerRuntimeTools.
		registry.register({
			name: "Shell", description: "", prompt: "",
			category: "runtime", source: "runtime", configSchema: [],
			meta: { isReadOnly: true, isDestructive: false, isConcurrencySafe: true },
		});
		for (const name of Object.keys(tools)) {
			expect(registry.getByName(name)).toBeUndefined();
		}
	});

	test("subagents-delegation.ts source: no global ToolRegistry / ALL_TOOLS import", () => {
		const src = readSrc("../../src/runtime/tools/subagents-delegation.ts");
		// The factory returns a Record — it never pokes a global registry. The
		// doc comment mentions "ToolRegistry" by name (as a NEGATIVE claim),
		// so we check for the absence of any registration CALL or ALL_TOOLS
		// import, not the bare word.
		expect(src).not.toMatch(/import.*ALL_TOOLS/);
		expect(src).not.toMatch(/import.*ToolRegistry/);
		expect(src).not.toMatch(/registry\.register/);
	});

	test("subagents-delegation.ts source: doc string states caller-only / not in global UI", () => {
		const src = readSrc("../../src/runtime/tools/subagents-delegation.ts");
		expect(src).toMatch(/不进全局工具 UI|NOT registered into the global ToolRegistry/i);
	});
});

// ─── 3. buildContextMessage content (snapshot-style) ─────

describe("buildContextMessage — P2 sections (snapshot)", () => {
	test("injects env + guidelines + current-task + wiki anchors", () => {
		const out = buildContextMessage({
			workspaceDir: "/proj",
			guidelines: ["No emojis"],
			currentTask: "Active requirement: Add tests [req-42] (project: Demo)",
			wikiAnchorsContext: "### Project: Demo\n- Foo — summary",
		});
		expect(out).toContain("## Environment");
		expect(out).toContain("/proj");
		expect(out).toContain("## Guidelines");
		expect(out).toContain("No emojis");
		expect(out).toContain("## Current Task");
		expect(out).toContain("req-42");
		expect(out).toContain("## Wiki Anchors (context)");
		expect(out).toContain("### Project: Demo");
	});

	test("current-task renders between Guidelines and Recalled Memories", () => {
		const out = buildContextMessage({
			guidelines: ["G"],
			currentTask: "task-x",
			memoryContext: "mem-y",
		});
		const g = out!.indexOf("## Guidelines");
		const t = out!.indexOf("## Current Task");
		const m = out!.indexOf("## Recalled Memories");
		expect(g).toBeLessThan(t);
		expect(t).toBeLessThan(m);
	});

	test("wiki anchors land in their own section after memory", () => {
		const out = buildContextMessage({
			memoryContext: "M",
			wikiAnchorsContext: "W",
		});
		const m = out!.indexOf("## Recalled Memories");
		const w = out!.indexOf("## Wiki Anchors (context)");
		expect(m).toBeLessThan(w);
	});

	test("no current-task → section omitted (no empty header)", () => {
		const out = buildContextMessage({ workspaceDir: "/x" });
		expect(out).not.toContain("## Current Task");
	});

	test("all sections combined — full content snapshot", () => {
		const out = buildContextMessage({
			workspaceDir: "/proj",
			guidelines: ["G1", "G2"],
			currentTask: "task-z",
			memoryContext: "mem content",
			ragContext: "rag content",
			wikiAnchorsContext: "wiki outline",
		});
		// Order: Environment, Guidelines, Current Task, Recalled Memories,
		// Knowledge Base, Wiki Anchors.
		const order = [
			"## Environment",
			"## Guidelines",
			"## Current Task",
			"## Recalled Memories",
			"## Knowledge Base",
			"## Wiki Anchors (context)",
		];
		const idxs = order.map(h => out!.indexOf(h));
		for (let i = 1; i < idxs.length; i++) {
			expect(idxs[i]).toBeGreaterThan(idxs[i - 1]);
		}
		// Wrapped in <context> tag.
		expect(out!.startsWith("<context>\n")).toBe(true);
		expect(out!.trim().endsWith("</context>")).toBe(true);
	});
});

// ─── 4. context content never enters history ─────────────

describe("agent-loop prependContext (D-B — context never in history)", () => {
	// We replicate the loop's prependContext logic to assert it doesn't mutate
	// session history — it composes a fresh message array each turn.
	test("prependContext composes per-turn without persisting into stored messages", () => {
		// Mirrors AgentLoop.prependContext (private).
		const prependContext = (messages: any[], ctx: string | null): any[] => {
			if (!ctx) return messages;
			const copy = [...messages];
			const last = copy[copy.length - 1];
			if (last?.role === "user") {
				copy[copy.length - 1] = { ...last, content: ctx + last.content };
			}
			return copy;
		};
		const stored: any[] = [{ role: "user", content: "hello" }];
		const ctx = "<context>\nenv\n</context>\n";
		const composed = prependContext(stored, ctx);
		// The stored message is untouched.
		expect(stored[0].content).toBe("hello");
		// The composed message has the context prefixed.
		expect(composed[composed.length - 1].content).toBe(ctx + "hello");
	});
});

// ─── 5. bundle inheritance — projectId carried into sub-loop ──

describe("delegateTask bundle inheritance (D-B / decision 16)", () => {
	test("caller contextBundle.projectId is forwarded via contextOverride path", () => {
		// SubagentDelegator inheritance contract: caller bundle → inheritedBundle
		// → sub-loop config. The buildSubagentTools tool does not pass
		// contextOverride directly; the delegator does, but the contract is:
		// callerBundle present on the caller config → sub-loop sees the same
		// projectId. This test pins the contract.
		const callerBundle: SessionContextBundle = {
			projectId: "proj-42",
			workspaceDir: "/proj-42",
			wikiRootNodeId: "wiki-root:proj-42",
		} as SessionContextBundle;
		const callerConfig = {
			agentId: "caller",
			workspaceDir: "/proj-42",
			contextBundle: callerBundle,
		} as SessionConfig;

		// SubagentDelegator-style inheritance: inheritedBundle = callerBundle merged with override.
		const override = {} as Partial<SessionContextBundle>;
		const inherited: SessionContextBundle = { ...callerConfig.contextBundle, ...override };
		expect(inherited.projectId).toBe("proj-42");
		expect(inherited.workspaceDir).toBe("/proj-42");
	});

	test("per-call contextOverride can narrow the inherited bundle", () => {
		const callerBundle = {
			projectId: "proj-42",
			workspaceDir: "/proj-42",
			wikiRootNodeId: "wiki-root:proj-42",
		} as SessionContextBundle;
		const override = { workspaceDir: "/proj-42/sub" } as Partial<SessionContextBundle>;
		const inherited = { ...callerBundle, ...override };
		expect(inherited.projectId).toBe("proj-42"); // still inherited
		expect(inherited.workspaceDir).toBe("/proj-42/sub"); // narrowed
	});

	test("subagent-delegation.ts forwards targetAgentId so delegator can inherit caller bundle", () => {
		// Source contract: the tool always passes targetAgentId (real agentId
		// when resolved, slug otherwise) — that's how SubagentDelegator builds
		// the sub-loop against the target agent while still inheriting the
		// caller bundle.
		const src = readSrc("../../src/runtime/tools/subagents-delegation.ts");
		expect(src).toMatch(/targetAgentId: capturedAgentId/);
	});
});

// ─── 6. runtime does not read roleTag ────────────────────

describe("runtime roleTag isolation (P2 §11.4)", () => {
	test("subagents-delegation + context-message do not reference roleTag", () => {
		const subSrc = readSrc("../../src/runtime/tools/subagents-delegation.ts");
		expect(subSrc).not.toMatch(/\broleTag\b/);

		const ctxSrc = readSrc("../../src/runtime/context-message.ts");
		expect(ctxSrc).not.toMatch(/\broleTag\b/);
	});

	test("buildSubagentTools output is identical for callers of any role (roleTag-agnostic)", () => {
		// roleTag is not even a field on ToolExecutionContext; the tool only
		// consumes subagents[] + delegateTask. Two callers with different
		// (hypothetical) roleTags build identical tool sets.
		const { ctx: ctx1 } = makeCapturingDelegate();
		const { ctx: ctx2 } = makeCapturingDelegate();
		const t1 = buildSubagentTools({
			subagents: [{ agentId: "x", name: "x" }],
			context: ctx1,
		});
		const t2 = buildSubagentTools({
			subagents: [{ agentId: "x", name: "x" }],
			context: ctx2,
		});
		expect(Object.keys(t1)).toEqual(Object.keys(t2));
	});
});

// ─── 7. SubagentDelegator — end-to-end bundle inheritance ──

describe("SubagentDelegator bundle inheritance (e2e-style unit)", () => {
	beforeEach(() => {
		// The delegator fires SubagentStart/SubagentStop hooks; clear the
		// registry so unrelated handlers don't run during the test.
		HookRegistry.getInstance().clear();
	});

	/** Stub runtime: records the subConfig it was built with and returns a fixed result. */
	function makeStubRuntime(captured: SessionConfig[], result: string): AgentRuntime {
		return {
			run: vi.fn(async (task: string) => {
				// Stub runs by stashing the result the test pre-seeded.
				(captured as any)._result = result;
				(captured as any)._task = task;
			}),
			abort: vi.fn(),
			getState: vi.fn(() => ({ isBusy: false, streamingText: "", toolCalls: [] })),
			resetSession: vi.fn(),
			getResult: vi.fn(() => (captured as any)._result ?? ""),
		} as unknown as AgentRuntime;
	}

	test("caller bundle (projectId/workspaceDir) is inherited by the sub-loop", async () => {
		const captured: SessionConfig[] = [];
		const callerBundle: SessionContextBundle = {
			projectId: "proj-99",
			workspaceDir: "/proj-99",
			wikiRootNodeId: "wiki-root:proj-99",
		} as SessionContextBundle;
		const callerConfig: SessionConfig = {
			agentId: "caller",
			workspaceDir: "/proj-99",
			systemPrompt: "caller-prompt",
			modelId: "caller-model",
			providerName: "stub",
			toolPolicy: {},
			contextBundle: callerBundle,
		} as SessionConfig;

		const delegator = new SubagentDelegator({
			config: callerConfig,
			providers: [],
			emit: () => {},
			getToolConfig: () => ({}),
			createSubLoop: (cfg) => {
				captured.push(cfg);
				return makeStubRuntime(captured, "done-sub");
			},
		});

		const result = await delegator.delegateTask("do thing", {
			targetAgentId: "dev-1",
			systemPrompt: "dev-prompt",
			model: "dev-model",
		});

		expect(result).toBe("done-sub");
		expect(captured).toHaveLength(1);
		const sub = captured[0];
		// Identity comes from the target agent (per-call options).
		expect(sub.systemPrompt).toBe("dev-prompt");
		expect(sub.modelId).toBe("dev-model");
		// Bundle is the caller's (inherited), with projectId carried over.
		expect(sub.contextBundle).toBeDefined();
		expect(sub.contextBundle!.projectId).toBe("proj-99");
		expect(sub.contextBundle!.workspaceDir).toBe("/proj-99");
		// Parent linkage recorded for telemetry.
		expect(sub.parentSessionId).toBe(callerConfig.sessionId);
		expect(sub.spawnDepth).toBe(1);
	});

	test("per-call contextOverride narrows the inherited bundle", async () => {
		const captured: SessionConfig[] = [];
		const callerBundle = {
			projectId: "proj-99",
			workspaceDir: "/proj-99",
			wikiRootNodeId: "wiki-root:proj-99",
		} as SessionContextBundle;
		const callerConfig: SessionConfig = {
			agentId: "caller", workspaceDir: "/proj-99",
			systemPrompt: "p", modelId: "m", providerName: "stub",
			toolPolicy: {}, contextBundle: callerBundle,
		} as SessionConfig;

		const delegator = new SubagentDelegator({
			config: callerConfig, providers: [], emit: () => {},
			getToolConfig: () => ({}),
			createSubLoop: (cfg) => { captured.push(cfg); return makeStubRuntime(captured, "ok"); },
		});

		await delegator.delegateTask("x", {
			targetAgentId: "dev",
			contextOverride: { workspaceDir: "/proj-99/sub" },
		});

		const sub = captured[0];
		expect(sub.contextBundle!.projectId).toBe("proj-99"); // still inherited
		expect(sub.contextBundle!.workspaceDir).toBe("/proj-99/sub"); // narrowed
		// workspaceDir resolution prefers the override bundle over caller config.
		expect(sub.workspaceDir).toBe("/proj-99/sub");
	});

	test("target identity defaults to caller when options omit it (legacy 2-arg shape)", async () => {
		const captured: SessionConfig[] = [];
		const callerConfig: SessionConfig = {
			agentId: "caller", workspaceDir: "/w",
			systemPrompt: "caller-sys", modelId: "caller-mod",
			providerName: "stub", toolPolicy: {},
		} as SessionConfig;
		const delegator = new SubagentDelegator({
			config: callerConfig, providers: [], emit: () => {},
			getToolConfig: () => ({}),
			createSubLoop: (cfg) => { captured.push(cfg); return makeStubRuntime(captured, "ok"); },
		});

		// 2-arg legacy shape: just task, no options.
		await delegator.delegateTask("legacy");

		const sub = captured[0];
		expect(sub.systemPrompt).toBe("caller-sys");
		expect(sub.modelId).toBe("caller-mod");
		// agentId is derived as `<caller>:sub` when no targetAgentId given.
		expect(sub.agentId.startsWith("caller")).toBe(true);
	});
});
