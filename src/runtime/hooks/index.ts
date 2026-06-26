// runtime/hooks 统一注册入口：启动时一次性挂上全部功能钩子。
//
// # 文件说明书
//
// ## 核心功能
// registerAllRuntimeHooks 按固定顺序注册 turn 持久化、通知、RAG 注入、provider options、
// 压缩等钩子；由 agent-service.ts 在启动时与 registerDurableHooks 一并调用。注册顺序敏感
// （notification → rag → providerOptions → compression）。
//
// v0.8 (P2 §11.6): registerMemoryHooks 已废 (memory 合并到 wiki per-agent 子树,
// 召回改由 wiki-anchor-injection 注入 + Wiki(search) 查询)。memoryContext 不再由
// 独立 hook 注入 —— 上下文构建见 buildContextMessage + renderContextAnchors。
//
// ## 输入
// - 可选 db：ISessionStore，仅在传入时注册 turn-hooks（步骤级持久化）
//
// ## 输出
// - 副作用：向 HookRegistry 注册多个 PreLLMCall / PostTurnComplete 处理器
//
// ## 定位
// runtime/hooks 的对外门面；新增功能钩子应在此追加调用，而不是让上层各自注册。
//
// ## 依赖
// - 各 register*Hooks 子模块
// - runtime/session-store-interface（ISessionStore 类型）
// - core/logger
//
// ## 维护规则
// - 新增 hook 子模块时必须在本文件 import 并按依赖顺序调用，避免随机顺序导致上下文相互覆盖。
// - 调整注册顺序前需评估 PreLLMCall 之间对返回值 merge 的影响（memoryContext / ragContext / providerOptions）。

import { registerCompressionHooks } from "./compression-hooks.js";
import { registerExtractionHooks, type ExtractionHooksDeps } from "./extraction-hooks.js";
import { registerNotificationHooks } from "./notification-hooks.js";
import { registerProviderOptionsHooks } from "./provider-options-hooks.js";
import { registerRagHooks } from "./rag-hooks.js";
import { registerTodoCleanupHooks } from "./todo-cleanup-hooks.js";
import { registerTurnHooks } from "./turn-hooks.js";
import type { ISessionStore } from "../session-store-interface.js";
import { log } from "../../core/logger.js";

/**
 * Optional M5 extraction deps. When omitted, M5 extraction hooks are not
 * registered (the system runs in pre-M5 mode). Pass them to enable
 * mechanism 2 (incremental extraction) + close flush.
 */
export function registerAllRuntimeHooks(db?: ISessionStore, extractionDeps?: ExtractionHooksDeps): void {
	if (db) registerTurnHooks(db);
	registerNotificationHooks();
	// v0.8 (P2 §11.6): registerMemoryHooks() removed — memory now lives in
	// wiki per-agent subtrees and is injected via wiki-anchor-injection +
	// renderContextAnchors. No standalone recall hook.
	registerRagHooks();
	registerProviderOptionsHooks();
	registerCompressionHooks();
	// Clear all-completed todos at the end of the current turn (UI auto-hide).
	registerTodoCleanupHooks();
	if (extractionDeps) registerExtractionHooks(extractionDeps);
	log.debug("hooks", "All runtime feature hooks registered");
}
