// Zero Core - Custom Agent Runtime
//
// # 文件说明书
//
// ## 核心功能
// 导出 zero-core 的公共 API，包括配置、核心逻辑、运行时和类型。
//
// ## 输入
// 无 - 此文件仅导出模块。
//
// ## 输出
// - 配置相关：loadConfig, DEFAULT_CONFIG, ZeroCoreConfigSchema 等
// - 核心逻辑：buildSystemPrompt
// - 运行时：AgentLoop, StreamEvent, RuntimeProviderConfig 等
//
// ## 定位
// 项目入口点，供外部应用导入使用。
//
// ## 依赖
// - ./core/config.js - 配置管理
// - ./core/system-prompt.js - 系统提示词
// - ./runtime/agent-loop.js - Agent 循环
// - ./runtime/types.js - 类型定义
//
// ## 维护规则
// - 新增公共 API 时必须在此导出
// - 保持导出与实际模块功能一致
//
// Usage:
//   import { createAgentService } from "zero-core/server/agent-service.js";

// Core configuration
export { loadConfig, DEFAULT_CONFIG, ZeroCoreConfigSchema, ZERO_CORE_DIR, getGlobalConfigPath, resolveEffective } from "./core/config.js";
export type { ZeroCoreConfig } from "./core/config.js";

// Core logic
// compression-archive-simplify sub-5: shouldPrune / pruneMessages re-exports
// DELETED — context-manager.ts (and compaction.ts) were dead modules (no live
// callers); only this re-export kept them nominally public. Live pruning now
// happens via AgentLoop's internal pruneIfNeeded (turn-recorder), not these.
export { buildSystemPrompt } from "./core/system-prompt.js";
export { transformToolResult } from "./core/tool-policy.js";

// Runtime
export { AgentLoop } from "./runtime/agent-loop.js";
export type {
	StreamEvent,
	RuntimeProviderConfig,
	SessionConfig,
	RuntimeCallbacks,
	AgentRuntime,
	RuntimeState,
	ToolExecutionContext,
	ModelMessage,
} from "./runtime/types.js";
export { resolveModel, clearProviderCache } from "./runtime/provider-factory.js";
