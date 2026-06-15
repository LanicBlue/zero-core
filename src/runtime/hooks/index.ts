// runtime/hooks 统一注册入口：启动时一次性挂上全部功能钩子。
//
// # 文件说明书
//
// ## 核心功能
// registerAllRuntimeHooks 按固定顺序注册 turn 持久化、通知、记忆召回、RAG 注入、provider options、
// 压缩等钩子；由 agent-service.ts 在启动时与 registerDurableHooks 一并调用。注册顺序敏感
// （notification → memory → rag → providerOptions → compression）。
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
import { registerMemoryHooks } from "./memory-hooks.js";
import { registerNotificationHooks } from "./notification-hooks.js";
import { registerProviderOptionsHooks } from "./provider-options-hooks.js";
import { registerRagHooks } from "./rag-hooks.js";
import { registerTurnHooks } from "./turn-hooks.js";
import type { ISessionStore } from "../session-store-interface.js";
import { log } from "../../core/logger.js";

export function registerAllRuntimeHooks(db?: ISessionStore): void {
	if (db) registerTurnHooks(db);
	registerNotificationHooks();
	registerMemoryHooks();
	registerRagHooks();
	registerProviderOptionsHooks();
	registerCompressionHooks();
	log.debug("hooks", "All runtime feature hooks registered");
}
