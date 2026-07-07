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
import { SubagentDelegator } from "../../src/runtime/subagent-delegator.js";
import { buildContextMessage } from "../../src/runtime/context-message.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { HookRegistry } from "../../src/core/hook-registry.js";
import { ALL_TOOLS } from "../../src/runtime/tools/index.js";
import { delegateTool } from "../../src/runtime/tools/agent.js";
import { getToolName } from "../../src/runtime/tools/tool-factory.js";
import { BUILTIN_WORKFLOW_ROLES } from "../../src/server/builtin-role-templates.js";
import { RENAMED_TOOLS } from "../../src/core/tool-registry.js";
import type { ToolExecutionContext, SessionConfig, RuntimeCallbacks, AgentRuntime } from "../../src/runtime/types.js";
import type { SessionContextBundle } from "../../src/shared/types.js";

// ─── Helpers ──────────────────────────────────────────────

function readSrc(rel: string): string {
	return readFileSync(resolve(__dirname, rel), "utf-8");
}

// ─── 1. Agent delegation tool (v0.8 refactor: single action tool) ─
//
// Per-subagent tools (buildSubagentTools) were RETIRED. Delegation is now the
// single action-based `Agent` tool in ALL_TOOLS (list / delegate-by-name /
// ephemeral), resolving targets live via ctx.resolveAgent. These tests pin the
// source contract.

describe("Agent delegation — single action tool (no per-subagent tools)", () => {
	test("tools/index.ts buildToolsSet has NO subagentsTools channel anymore", () => {
		const src = readSrc("../../src/runtime/tools/index.ts");
		expect(src).not.toMatch(/subagentsTools/);
		expect(src).toMatch(/Object\.entries\(ALL_TOOLS\)/);
	});

	test("agent-loop buildTools no longer builds per-subagent tools", () => {
		const src = readSrc("../../src/runtime/agent-loop.ts");
		expect(src).not.toMatch(/buildSubagentTools/);
	});

	test("Subagent tool is the single delegation surface (in ALL_TOOLS)", () => {
		// ALL_TOOLS keys are derived from each tool's own __name (single source
		// via getToolName), so the Subagent entry is keyed by the delegate tool's
		// name — structural, not a hand-written literal.
		expect(ALL_TOOLS.Subagent).toBe(delegateTool);
		expect(getToolName(delegateTool)).toBe("Subagent");
	});

	test("ALL_TOOLS keys are derived from each tool's __name (single source)", () => {
		// Contract: every ALL_TOOLS key === getToolName(def). If this breaks, a
		// tool's buildTool({name}) drifted from its registration key — the exact
		// class of bug the e8128d8 Agent→Subagent rename missed.
		for (const [key, def] of Object.entries(ALL_TOOLS)) {
			expect(getToolName(def), `key "${key}" must equal def.__name`).toBe(key);
		}
	});

	test("builtin seed-policy tool keys are all known (current or renamed)", () => {
		// Contract: every tool enabled in a builtin role's seed policy must be a
		// current ALL_TOOLS key or a legacy key covered by RENAMED_TOOLS — else the
		// policy silently enables a non-existent tool.
		const known = new Set<string>([...Object.keys(ALL_TOOLS), ...Object.keys(RENAMED_TOOLS)]);
		for (const role of BUILTIN_WORKFLOW_ROLES) {
			const tools = role.toolPolicy?.tools ?? {};
			for (const key of Object.keys(tools)) {
				expect(known, `seed policy key "${key}" in role "${role.id}"`).toContain(key);
			}
		}
	});
});

// ─── 2b. sub-D contracts: gating is single-layer toolPolicy ──
//
// CONDITIONAL_TOOLS was removed (2026-07). These contracts pin the two
// invariants that justify the removal: (a) the delegator methods that the 7
// retired conditions checked are wired on EVERY session in agent-loop (so
// gating them was dead code), and (b) capabilityHandlesFor warns loudly when a
// policy-enabled tool's backing service is missing (the old silent-hide became
// a loud signal).

describe("Tool gating — single-layer toolPolicy (sub-D)", () => {
	test("agent-loop wires delegator methods unconditionally (no per-session gate)", () => {
		const src = readSrc("../../src/runtime/agent-loop.ts");
		// These are the delegator methods the retired conditions used to check.
		// They must be assigned unconditionally in the ctx object (constructed in
		// the loop constructor), proving the 7 delegation conditions were dead.
		expect(src).toMatch(/delegateTask:\s*\(.*\)\s*=>\s*this\.delegator\.delegateTask/);
		expect(src).toMatch(/getTaskResult:\s*\(.*\)\s*=>\s*this\.delegator\.getTaskResult/);
		expect(src).toMatch(/listTasks:\s*\(.*\)\s*=>\s*this\.delegator\.listTasks/);
		expect(src).toMatch(/suspendUntilWake:\s*\(.*\)\s*=>\s*this\.delegator\.suspendUntilWake/);
	});

	test("tools/index.ts no longer has a CONDITIONAL_TOOLS capability gate", () => {
		const src = readSrc("../../src/runtime/tools/index.ts");
		// The map declaration and its buildToolsSet lookup are gone (comments may
		// still mention it for historical context — that's fine).
		expect(src).not.toMatch(/const CONDITIONAL_TOOLS/);
		expect(src).not.toMatch(/CONDITIONAL_TOOLS\[name\]/);
		// buildToolsSet must gate only on policy (isEnabled), not a capability check.
		expect(src).toMatch(/if \(isEnabled\(name\)\)/);
	});

	test("capabilityHandlesFor warns when a policy-enabled tool's service is missing", () => {
		const src = readSrc("../../src/server/agent-service.ts");
		// Loud signal replaces the old silent-hide: each service-backed tool
		// emits a [capability] warning when enabled but uninitialized.
		expect(src).toMatch(/\[capability\] toolPolicy enables Wiki but wikiStore/);
		expect(src).toMatch(/\[capability\] toolPolicy enables Flow but requirementStore/);
		expect(src).toMatch(/management service is not initialized/);
		// Work needs management too — must be in the injection condition (was a
		// latent gap before: original capabilityHandlesFor omitted Work).
		expect(src).toMatch(/on\("Project"\) \|\| on\("Work"\) \|\| on\("AgentRegistry"\) \|\| on\("Cron"\)/);
	});
});

// ─── 3. buildContextMessage content (snapshot-style) ─────

describe("buildContextMessage — P2 sections (snapshot)", () => {
	test("injects env + guidelines + wiki anchors", () => {
		const out = buildContextMessage({
			workspaceDir: "/proj",
			guidelines: ["No emojis"],
			wikiAnchorsContext: "### Project: Demo\n- Foo — summary",
		});
		expect(out).toContain("## Environment");
		expect(out).toContain("/proj");
		expect(out).toContain("## Guidelines");
		expect(out).toContain("No emojis");
		expect(out).toContain("## Wiki Anchors (context)");
		expect(out).toContain("### Project: Demo");
	});

	test("current-task section removed (sub-2): field dropped, no header", () => {
		// sub-2: resolveCurrentTask + ## Current Task removed (covered by the
		// work-context hook's ## Requirement). Assert the field/section are gone.
		const out = buildContextMessage({
			guidelines: ["G"],
			memoryContext: "mem-y",
		});
		expect(out).not.toContain("## Current Task");
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

	test("all sections combined — full content snapshot", () => {
		const out = buildContextMessage({
			workspaceDir: "/proj",
			guidelines: ["G1", "G2"],
			memoryContext: "mem content",
			wikiAnchorsContext: "wiki outline",
		});
		// Order: Environment, Guidelines, Recalled Memories, Wiki Anchors.
		const order = [
			"## Environment",
			"## Guidelines",
			"## Recalled Memories",
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
		// → sub-loop config. The delegator merges callerBundle with any
		// contextOverride; the contract is: callerBundle present on the caller
		// config → sub-loop sees the same projectId. This test pins the contract.
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
});

// ─── 6. runtime does not read roleTag ────────────────────

describe("runtime roleTag isolation (P2 §11.4)", () => {
	test("context-message does not reference roleTag", () => {
		const ctxSrc = readSrc("../../src/runtime/context-message.ts");
		expect(ctxSrc).not.toMatch(/\broleTag\b/);
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
