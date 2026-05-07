import type { ZeroCoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Tool call evaluation
// ---------------------------------------------------------------------------

export interface ToolCallDecision {
	block: boolean;
	reason?: string;
}

export function evaluateToolCall(
	config: ZeroCoreConfig,
	toolName: string,
): ToolCallDecision {
	const blocked = config.toolPolicy.blockedTools;
	if (blocked?.length && blocked.includes(toolName)) {
		return { block: true, reason: `Tool "${toolName}" is blocked by zero-core policy` };
	}

	return { block: false };
}

export function requiresApproval(config: ZeroCoreConfig, toolName: string): boolean {
	// Check toolCategories first
	const categories = config.toolPolicy.toolCategories;
	if (categories) {
		for (const cat of Object.values(categories)) {
			if (cat.requireApproval && cat.blocked !== true) continue;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Tool result transform
// ---------------------------------------------------------------------------

export interface ToolResultTransform {
	content?: unknown;
	details?: unknown;
	isError?: boolean;
}

export function transformToolResult(
	_config: ZeroCoreConfig,
	_toolName: string,
	_content: unknown,
	_details?: unknown,
	_isError?: boolean,
): ToolResultTransform | undefined {
	// Default: no transform. Extensions can override by adding specific rules.
	return undefined;
}
