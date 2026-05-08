import type { ZeroCoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Tool call evaluation
// ---------------------------------------------------------------------------

export interface ToolCallDecision {
	block: boolean;
	reason?: string;
	autoApprove?: boolean;
}

export function evaluateToolCall(
	config: ZeroCoreConfig,
	toolName: string,
): ToolCallDecision {
	const policy = config.toolPolicy;

	// 1. Blocked tools — hard deny
	if (policy.blockedTools?.length && policy.blockedTools.includes(toolName)) {
		return { block: true, reason: `Tool "${toolName}" is blocked by policy` };
	}

	// 2. Allowed list — if set, only these are permitted
	if (policy.allowedTools?.length && !policy.allowedTools.includes(toolName)) {
		return { block: true, reason: `Tool "${toolName}" is not in the allowed list` };
	}

	// 3. Category-level block
	if (policy.toolCategories) {
		for (const [, cat] of Object.entries(policy.toolCategories)) {
			if (cat.blocked) {
				// Category-level block applies to tools matching the category name
				// (categories are matched by prefix, e.g. "bash" blocks "bash" tool)
				if (toolName.startsWith(Object.keys(policy.toolCategories).find(
					(k) => policy.toolCategories![k] === cat,
				) ?? "")) {
					return { block: true, reason: `Tool "${toolName}" is in a blocked category` };
				}
			}
		}
	}

	// 4. Auto-approve
	const autoApprove = policy.autoApprove?.includes(toolName) ?? false;

	return { block: false, autoApprove };
}

export function requiresApproval(config: ZeroCoreConfig, toolName: string): boolean {
	// If explicitly auto-approved, no approval needed
	if (config.toolPolicy.autoApprove?.includes(toolName)) {
		return false;
	}

	// Check toolCategories for requireApproval
	if (config.toolPolicy.toolCategories) {
		for (const [catName, cat] of Object.entries(config.toolPolicy.toolCategories)) {
			if (cat.requireApproval && toolName.startsWith(catName)) {
				return true;
			}
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
