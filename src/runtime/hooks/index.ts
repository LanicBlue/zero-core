// runtime/hooks 统一注册入口 —— Step 1B per-loop registry 接线。
//
// # 文件说明书
//
// ## 核心功能
// `registerHooksForLoop(registry, loopKind, deps)` 按 loop 类型往给定 registry 上
// 注册功能钩子。注册顺序敏感(providerOptions 对 PreLLMCall 返回值
// merge 顺序)。分组见 spec §6:
//   - shared (main + delegated): turn-hooks / tool-execution-hooks / durable-hooks
//     / provider-options-hooks
//   - main only:  input-queue-hooks / metrics-hooks (sub-4: notification-hooks
//     removed — workbench 收件箱 replaces it)
//   - delegated only: task-control-hooks
// requirement-hooks 不再注册(§5.5,workflow 域,已退役)。
// sub-7 (work-context 拆解到三通道): workflow-context-hook **删除** —— Project /
// Wiki Baseline / Requirement / Steps Progress 改由 SessionConfig 闭包
// (config.workContextSystemSection / config.stepsProgressSection)直接渲染进
// system 段 / workbench 段,不再走 PreLLMCall memoryContext 误标通道。
// compression-archive-simplify sub-5: extraction-hooks.ts **删除** —— ExtractorA
// 主体被删(wiki 抽取现在由 compressSession 的 Force-档 memory ephemeral turn
// 承担,sub-3c),其退役 no-op stub + 全部 caller wiring 一并清掉。
//
// 各 register*Hooks 子函数收 `registry` 形参(默认 HookRegistry.getInstance(),
// 旧测试/未迁移调用方仍可用)。
//
// ## 输入
// - registry: HookRegistry —— 该 loop 自己的实例
// - loopKind: "main" | "delegated"
// - deps: HookWiringDeps —— 各 hook 需要的 stores/handles
//
// ## 输出
// - 副作用:向 registry 注册多个处理器。Step 1C renamed the agent-execution
//   events to the step-centric set (TurnStart/TurnEnd/TurnError/StepStart/
//   StepEnd + kept PreLLMCall/PostTurnComplete/Tool*). Session-level
//   SessionStart/SessionClose are fired by agent-service (NOT registered here).
//
// ## 定位
// runtime/hooks 的对外门面;新增功能钩子应在此追加调用,而不是让上层各自注册。
//
// ## 依赖
// - 各 register*Hooks 子模块
// - runtime/session-store-interface(ISessionStore)
// - core/hook-registry(HookRegistry)
// - core/logger
//
// ## 维护规则
// - 新增 hook 子模块时:① 让其 register fn 收 `registry` 形参;② 在本文件 import
//   并在 registerHooksForLoop 按 §6 分组追加调用。
// - 调整注册顺序前需评估 PreLLMCall 之间对返回值 merge 的影响。

import type { HookRegistry } from "../../core/hook-registry.js";
// steps-overhaul sub-4: registerCompressionHooks + compression-hooks.ts DELETED.
// The old L1/L2 StepEnd trigger (sub-3 made it a no-op) is gone; the new
// stage-3 compression core (compressSession in server/compression-core.ts)
// is a callable, NOT a hook — sub-5 wires the trigger (StepEnd / PreLLMCall
// preflight / new-turn / reactive) into a NEW hook module. Old compression-
// engine.ts is also deleted (L1/L2/identifyTurns/TurnBoundary all gone).
// compression-archive-simplify sub-5: extraction-hooks.ts is DELETED along
// with ExtractorA (wiki extraction now in compressSession Force-档 memory
// turn, sub-3c). No replacement — extractionDeps is dropped from
// HookWiringDeps and the registerExtractionHooks call is gone.
// steps-overhaul sub-5: compression TRIGGER hooks (cache 冷热判定 + StepEnd cold /
// PreLLMCall preflight+hot / OnLLMError reactive). The callable core lives in
// server/compression-core.ts; this module wires it to the lifecycle triggers.
import {
	registerCompressionTriggerHooks,
	type CompressionTriggerHooksDeps,
} from "./compression-trigger-hooks.js";
// sub-4 (subagent-recovery): notification-hooks.ts DELETED — the workbench
// 收件箱 (running 一直在;终态留到 TaskGet 消费才删) replaces the old addMessage
// notification path. Fewer accumulating message types. The `notified` flag on
// TaskInfo is also removed (no consumer left).
import { registerForceWaitHooks } from "./force-wait-hooks.js";
import { registerProviderOptionsHooks } from "./provider-options-hooks.js";
import { registerTodoCleanupHooks } from "./todo-cleanup-hooks.js";
import { registerTaskControlHooks } from "./task-control-hooks.js";
import { registerTurnHooks } from "./turn-hooks.js";
import { registerInputQueueHooks } from "./input-queue-hooks.js";
// server/ hooks — runtime already depends on server/ stores. Static imports
// here are the same layer-crossing that already exists; no new cycle.
//
// sub-7: workflow-context-hook is GONE. Its job (Project / Wiki Baseline /
// Requirement / Steps Progress injection) moved to SessionConfig closures
// (config.workContextSystemSection / config.stepsProgressSection) built by
// agent-service and rendered directly into the system + workbench sections.
// The runtime layer now never imports the workflow-context stores for prompt
// rendering — they live behind the closures.
import { registerDurableHooks } from "../../server/durable-hooks.js";
import { registerToolExecutionHooks } from "../../server/tool-execution-hooks.js";
import { registerMetricsHooks } from "../../server/metrics-hooks.js";
import type { ISessionStore } from "../session-store-interface.js";
import type { InputQueueStore } from "../../server/input-queue-store.js";
import type { SessionManager } from "../../server/session-manager.js";
import type { SessionDB } from "../../server/session-db.js";
import { log } from "../../core/logger.js";

/**
 * Deps threaded into `registerHooksForLoop`. Each hook reads only the deps it
 * needs; pass `undefined` for ones the loop doesn't carry and the matching hook
 * simply isn't registered (no-op).
 *
 * The shape is intentionally permissive: a per-loop registry is constructed in
 * `agent-service` (main) and `subagent-delegator` (delegated), both of which
 * hold different subsets of these handles. Anything optional here is what the
 * caller MAY legitimately lack (e.g. a delegated sub-loop has no input queue).
 *
 * sub-7: the `workflowContext` field is REMOVED — workflow-context-hook was
 * deleted; the same store access now happens inside SessionConfig closures
 * (agent-service → config.workContextSystemSection / stepsProgressSection).
 */
export interface HookWiringDeps {
	/** Step-level persistence store (turn-hooks). */
	db?: ISessionStore;
	/** Full SessionDB (durable-hooks / tool-execution-hooks). */
	sessionDb?: SessionDB;
	/** C2 input queue (main-only insert_now injection). */
	inputQueue?: InputQueueStore;
	/** Metrics consumer (main-only). */
	sessionManager?: SessionManager;
	/**
	 * steps-overhaul sub-5: compression trigger deps. When sessionDb is present
	 * this is auto-derived; set explicitly only to override (tests).
	 */
	compressionTriggerDeps?: CompressionTriggerHooksDeps;
}

/**
 * Register the full feature hook set onto `registry`, scoped by loop kind.
 *
 * Groups (spec §6):
 *   - shared: turn / tool-execution / durable / provider-options /
 *     extraction / compression / workflow-context(work session)
 *   - main only: notification / input-queue / metrics
 *   - delegated only: task-control
 *
 * requirement-hooks is NOT registered (retired, §5.5).
 *
 * Event names follow the Step 1C step-centric naming (TurnStart/TurnEnd/
 * TurnError/StepStart/StepEnd). SessionStart/SessionClose are agent-service's
 * responsibility (instance lifecycle) — not registered here.
 */
export function registerHooksForLoop(
	registry: HookRegistry,
	loopKind: "main" | "delegated",
	deps: HookWiringDeps,
): void {
	const { db, sessionDb, inputQueue, sessionManager } = deps;
	// steps-overhaul sub-5: compression trigger deps default to a sessionDb-backed
	// config; explicit override wins (tests).
	const compressionTriggerDeps = deps.compressionTriggerDeps ?? (sessionDb ? { sessionDb } : undefined);

	// ── shared (main + delegated) ──────────────────────────────────
	if (db) {
		registerTurnHooks(db, registry);
	}
	if (sessionDb) {
		// Server-side hooks (durable checkpoint + tool-execution audit). They
		// no-op internally when their store capabilities are absent.
		registerDurableHooks(sessionDb, registry);
		registerToolExecutionHooks(sessionDb, registry);
	}
	registerProviderOptionsHooks(registry);
	// steps-overhaul sub-4: registerCompressionHooks(registry) REMOVED — the
	// old StepEnd L1/L2 trigger is deleted. sub-5 lands the new trigger.
	// Clear all-completed todos at the end of the current turn (UI auto-hide).
	registerTodoCleanupHooks(registry);
	// sub-6 (force-Wait): if running background tasks exist when a turn is
	// about to end, nudge the model to Wait (one nudge per turn). Registered
	// for both loop kinds — either can own background tasks via TaskStart.
	registerForceWaitHooks(registry);
	// compression-archive-simplify sub-5: registerExtractionHooks call +
	// extraction-hooks.ts module DELETED — ExtractorA's wiki extraction now
	// lives in compressSession's Force-档 memory ephemeral turn (sub-3c); the
	// M5 no-op stub is gone. No replacement register call here.
	// steps-overhaul sub-5: compression triggers (cache 冷热判定 + StepEnd cold /
	// PreLLMCall preflight+hot / OnLLMError reactive). Registered for every loop
	// kind that owns a SessionDB (main + delegated). Routes through compressSession
	// so fresh-tail protection (owned by the core) is never bypassed.
	if (compressionTriggerDeps) {
		registerCompressionTriggerHooks(compressionTriggerDeps, registry);
	}
	// sub-7: workflow-context-hook DELETED — Project / Wiki Baseline /
	// Requirement / Steps Progress injection moved to SessionConfig closures
	// (config.workContextSystemSection / stepsProgressSection), rendered into
	// the system + workbench sections directly. No PreLLMCall hook here.

	// ── main only ──────────────────────────────────────────────────
	if (loopKind === "main") {
		// sub-4: notification-hooks removed — workbench 收件箱 covers it.
		if (inputQueue) {
			registerInputQueueHooks(inputQueue, registry);
		}
		if (sessionManager) {
			registerMetricsHooks(sessionManager, registry);
		}
	}

	// ── delegated only ─────────────────────────────────────────────
	if (loopKind === "delegated") {
		// task-control injects the request_finish control message into the
		// sub-agent's next step (PrepareStep). Needs the delegated-tasks store.
		if (db) {
			registerTaskControlHooks(db, registry);
		}
	}

	log.debug("hooks", `Hooks registered for loop kind=${loopKind}`);
}

export {
	registerForceWaitHooks,
	registerProviderOptionsHooks,
	registerTodoCleanupHooks,
	registerTaskControlHooks,
	registerTurnHooks,
	registerInputQueueHooks,
	registerCompressionTriggerHooks,
};
export type { CompressionTriggerHooksDeps };
