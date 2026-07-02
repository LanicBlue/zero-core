// runtime/hooks 统一注册入口 —— Step 1B per-loop registry 接线。
//
// # 文件说明书
//
// ## 核心功能
// `registerHooksForLoop(registry, loopKind, deps)` 按 loop 类型往给定 registry 上
// 注册功能钩子。注册顺序敏感(notification → providerOptions → compression
// 对 PreLLMCall 返回值 merge 顺序)。分组见 spec §6:
//   - shared (main + delegated): turn-hooks / tool-execution-hooks / durable-hooks
//     / provider-options-hooks / extraction-hooks / compression-hooks
//     / workflow-context-hook(work session)
//   - main only:  notification-hooks / input-queue-hooks / metrics-hooks
//   - delegated only: task-control-hooks
// requirement-hooks 不再注册(§5.5,workflow 域,已退役)。
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
import { registerCompressionHooks } from "./compression-hooks.js";
import { registerExtractionHooks, type ExtractionHooksDeps } from "./extraction-hooks.js";
import { registerNotificationHooks } from "./notification-hooks.js";
import { registerProviderOptionsHooks } from "./provider-options-hooks.js";
import { registerTodoCleanupHooks } from "./todo-cleanup-hooks.js";
import { registerTaskControlHooks } from "./task-control-hooks.js";
import { registerTurnHooks } from "./turn-hooks.js";
import { registerInputQueueHooks } from "./input-queue-hooks.js";
// server/ hooks — runtime already depends on server/ stores (compression-hooks
// → wiki-node-store, extraction-hooks → extractor-*). Static imports here are
// the same layer-crossing that already exists; no new cycle.
import { registerDurableHooks } from "../../server/durable-hooks.js";
import { registerToolExecutionHooks } from "../../server/tool-execution-hooks.js";
import { registerMetricsHooks } from "../../server/metrics-hooks.js";
import { registerWorkflowContextHook } from "../../server/workflow-context-hook.js";
import type { ISessionStore } from "../session-store-interface.js";
import type { InputQueueStore } from "../../server/input-queue-store.js";
import type { SessionManager } from "../../server/session-manager.js";
import type { SessionDB } from "../../server/session-db.js";
import type { ProjectStore } from "../../server/project-store.js";
import type { ProjectWikiStore } from "../../server/project-wiki-store.js";
import type { RequirementStore } from "../../server/requirement-store.js";
import type { TaskStepStore } from "../../server/task-step-store.js";
import type { ProjectWorkStore } from "../../server/project-work-store.js";
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
 */
export interface HookWiringDeps {
	/** Step-level persistence store (turn-hooks). */
	db?: ISessionStore;
	/** Full SessionDB (durable-hooks / tool-execution-hooks). */
	sessionDb?: SessionDB;
	/** M5 extractor deps (incremental extraction at PostTurnComplete). */
	extractionDeps?: ExtractionHooksDeps;
	/** C2 input queue (main-only insert_now injection). */
	inputQueue?: InputQueueStore;
	/** Metrics consumer (main-only). */
	sessionManager?: SessionManager;
	/** Workflow-context (T2) deps — only for work sessions. */
	workflowContext?: {
		projectStore: ProjectStore;
		requirementStore: RequirementStore;
		wikiStore: ProjectWikiStore;
		taskStepStore: TaskStepStore;
		projectWorkStore?: ProjectWorkStore;
	};
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
	const { db, sessionDb, extractionDeps, inputQueue, sessionManager, workflowContext } = deps;

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
	registerCompressionHooks(registry);
	// Clear all-completed todos at the end of the current turn (UI auto-hide).
	registerTodoCleanupHooks(registry);
	if (extractionDeps) {
		registerExtractionHooks(extractionDeps, registry);
	}
	if (workflowContext) {
		// workflow-context-hook lives in server/ but is plain pre-LLM-call
		// injection; import it lazily so the runtime layer doesn't gain a
		// static dep on server/.
		registerWorkflowContextHook({ ...workflowContext, hookRegistry: registry });
	}

	// ── main only ──────────────────────────────────────────────────
	if (loopKind === "main") {
		registerNotificationHooks(registry);
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
	registerCompressionHooks,
	registerExtractionHooks,
	registerNotificationHooks,
	registerProviderOptionsHooks,
	registerTodoCleanupHooks,
	registerTaskControlHooks,
	registerTurnHooks,
	registerInputQueueHooks,
};
export type { ExtractionHooksDeps };
