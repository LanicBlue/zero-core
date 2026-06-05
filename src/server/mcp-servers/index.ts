// MCP 服务器注册入口，向后兼容导出
//
// # 文件说明书
//
// ## 核心功能
// MCP 服务器统一注册入口，从 runtime/mcp-tools 向后兼容地重新导出内置 MCP 工具（fetch、memory、sequential-thinking、assistant）
//
// ## 输入
// runtime/mcp-tools 下的工具模块
//
// ## 输出
// webFetchTool、memoryReadTool、memoryWriteTool、sequentialThinkingTool、createAssistantTools
//
// ## 定位
// src/server/mcp-servers/ — 服务层 MCP 工具注册，被 mcp-manager 和外部消费者引用
//
// ## 依赖
// ../../runtime/mcp-tools/fetch-tools、memory-tools、sequential-thinking-tools、assistant-tools
//
// ## 维护规则
// 此文件为向后兼容层，新代码应直接从 runtime/mcp-tools 导入
// 新增内置 MCP 工具需在此文件中添加重新导出
//
// Re-exports from runtime/mcp-tools — kept for backward compatibility.
export { webFetchTool as web_fetch } from "../../runtime/mcp-tools/fetch-tools.js";
export { memoryReadTool, memoryWriteTool } from "../../runtime/mcp-tools/memory-tools.js";
export { sequentialThinkingTool } from "../../runtime/mcp-tools/sequential-thinking-tools.js";
export { createAssistantTools } from "../../runtime/mcp-tools/assistant-tools.js";
