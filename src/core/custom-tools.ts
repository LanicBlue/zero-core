// 自定义工具定义与注册
//
// # 文件说明书
//
// ## 核心功能
// 定义自定义工具的类型接口和注册机制
//
// ## 输入
// ZeroCoreConfig 中的自定义工具配置
//
// ## 输出
// CustomToolDefinition 接口，描述工具名称、描述和执行函数
//
// ## 定位
// src/core/ — 核心层，为 tool-registry 提供自定义工具支持
//
// ## 依赖
// config.ts
//
// ## 维护规则
// 自定义工具新增能力（如参数校验）时需更新接口定义
//
import type { ZeroCoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Custom tool definitions
// ---------------------------------------------------------------------------

export interface CustomToolDefinition {
	name: string;
	description: string;
	handler: (args: Record<string, unknown>) => Promise<string>;
}

// Registry for custom tools added at runtime
const registry = new Map<string, CustomToolDefinition>();

/**
 * Register a custom tool that can be invoked by the agent.
 */
export function registerCustomTool(tool: CustomToolDefinition): void {
	registry.set(tool.name, tool);
}

/**
 * Get all registered custom tools.
 */
export function getCustomTools(): CustomToolDefinition[] {
	return Array.from(registry.values());
}

/**
 * Execute a custom tool by name.
 */
export async function executeCustomTool(
	name: string,
	args: Record<string, unknown>,
): Promise<string | null> {
	const tool = registry.get(name);
	if (!tool) return null;
	return tool.handler(args);
}
