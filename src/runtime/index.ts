// runtime 模块公共入口
//
// # 文件说明书
//
// ## 核心功能
// runtime 模块的统一导出入口，向外暴露 AgentLoop、核心类型和 Provider 工厂
//
// ## 输入
// runtime 内部子模块（agent-loop、types、provider-factory）
//
// ## 输出
// AgentLoop 类、StreamEvent 等核心类型、resolveModel 和 clearProviderCache 函数
//
// ## 定位
// src/runtime/ — runtime 模块公共 API 层，被 src/index.ts 和外部消费者引用
//
// ## 依赖
// ./agent-loop、./types、./provider-factory
//
// ## 维护规则
// 新增 runtime 公共 API 需在此文件中导出
// 内部实现细节不应从此入口暴露
//
export { AgentLoop } from "./agent-loop.js";
export type {
	StreamEvent,
	RuntimeProviderConfig,
	SessionConfig,
	RuntimeCallbacks,
	AgentRuntime,
	RuntimeState,
	ToolExecutionContext,
	ModelMessage,
} from "./types.js";
export { resolveModel, clearProviderCache } from "./provider-factory.js";
