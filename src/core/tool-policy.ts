// 工具调用策略
//
// # 文件说明书
//
// ## 核心功能
// 评估工具调用请求，根据配置决定是否批准、阻止或自动执行。
//
// ## 输入
// - ZeroCoreConfig - 配置
// - toolName - 工具名称
//
// ## 输出
// - ToolCallDecision - 决策结果（block, autoApprove 等）
//
// ## 定位
// 核心策略模块，被 agent-loop 调用。
//
// ## 依赖
// - ./config - 配置类型
//
// ## 维护规则
// - 策略变更时需同步更新文档
// - 保持决策逻辑一致性
//
import type { ZeroCoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Tool call evaluation
// ---------------------------------------------------------------------------

export interface ToolCallDecision {
	block: boolean;
	reason?: string;
	autoApprove?: boolean;
}

// ---------------------------------------------------------------------------
// NOTE: evaluateToolCall / requiresApproval were removed — they were dead code
// (exported but never called). The actual tool filter is buildToolsSet
// (src/runtime/tools/index.ts), which reads blockedTools once when building the
// toolset passed to the LLM. There is no separate runtime re-check.

// ---------------------------------------------------------------------------
// Tool result transform
// ---------------------------------------------------------------------------

export interface ToolResultTransform {
	content?: unknown;
	details?: unknown;
	isError?: boolean;
}

export function transformToolResult(
	config: ZeroCoreConfig,
	toolName: string,
	content: unknown,
	details?: unknown,
	isError?: boolean,
): ToolResultTransform | undefined {
	const maxTokens = config.toolPolicy.resultMaxTokens;
	if (!maxTokens) return undefined;

	// Truncate text content if it exceeds maxTokens
	const text = extractText(content);
	if (!text) return undefined;

	const estimatedTokens = Math.ceil(text.length / 4);
	if (estimatedTokens <= maxTokens) return undefined;

	// Truncate at char level (4 chars ≈ 1 token)
	const maxChars = maxTokens * 4;
	const truncated = text.substring(0, maxChars) +
		`\n\n... [truncated: ${estimatedTokens} tokens → ${maxTokens} token limit]`;

	return {
		content: truncated,
		details,
		isError,
	};
}

function extractText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null)
			.map((b) => b.type === "text" && b.text ? b.text : "")
			.filter(Boolean)
			.join("\n") || null;
	}
	return null;
}
