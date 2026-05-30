import { tool } from "ai";
import type { ZodSchema } from "zod";
import type { ToolExecutionContext } from "../types.js";
import type { ToolConfigField } from "../../core/tool-registry.js";
import { triggerHooks } from "../../core/hook-registry.js";

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

export type ToolCategory =
	| "runtime"
	| "task"
	| "web"
	| "memory"
	| "thinking"
	| "assistant"
	| "interaction"
	| "agent";

export interface ToolMeta {
	category: ToolCategory;
	isReadOnly: boolean;
	isConcurrencySafe: boolean;
	isDestructive: boolean;
	maxResultSize: number;
	requiresConfirmation: boolean;
}

const DEFAULT_META: ToolMeta = {
	category: "runtime",
	isReadOnly: true,
	isConcurrencySafe: true,
	isDestructive: false,
	maxResultSize: 30000,
	requiresConfirmation: false,
};

// ---------------------------------------------------------------------------
// Result truncation
// ---------------------------------------------------------------------------

export function truncateResult(result: string, maxSize: number): string {
	if (result.length <= maxSize) return result;
	const truncated = result.slice(0, maxSize);
	return truncated + `\n\n[Result truncated: ${result.length} → ${maxSize} characters]`;
}

// ---------------------------------------------------------------------------
// buildTool — factory that wraps AI SDK's tool() with metadata
// ---------------------------------------------------------------------------

export interface BuildToolOptions<T extends ZodSchema> {
	name: string;
	description: string;
	prompt?: string;
	meta?: Partial<ToolMeta>;
	configSchema?: ToolConfigField[];
	inputSchema: T;
	execute: (input: any, ctx: ToolExecutionContext) => Promise<string>;
}

export function buildTool<T extends ZodSchema>(options: BuildToolOptions<T>) {
	const meta: ToolMeta = { ...DEFAULT_META, ...options.meta };

	// AI SDK's description field = full prompt (what the LLM sees)
	// If no separate prompt, description serves as both
	const aiDescription = options.prompt ?? options.description;

	const toolDef = tool({
		description: aiDescription,
		inputSchema: options.inputSchema,
		execute: async (input: any, opts: any) => {
			const ctx = opts?.experimental_context as ToolExecutionContext | undefined;
			const ctxOrEmpty = ctx ?? { workingDir: "", agentId: "", emit: () => {} };

			// PreToolUse hook — can block execution
			const preResult = await triggerHooks("PreToolUse", {
				agentId: ctxOrEmpty.agentId ?? "",
				sessionId: (ctxOrEmpty as any).sessionId,
				toolName: options.name,
				args: input,
			});
			if (preResult && typeof preResult === "object" && "blocked" in preResult) {
				return `Tool blocked: ${(preResult as any).reason}`;
			}

			try {
				const result = await options.execute(input, ctxOrEmpty);
				await triggerHooks("PostToolUse", {
					agentId: ctxOrEmpty.agentId ?? "",
					sessionId: (ctxOrEmpty as any).sessionId,
					toolName: options.name,
					result,
					isError: false,
				});
				return truncateResult(result, meta.maxResultSize);
			} catch (err) {
				await triggerHooks("PostToolUseFailure", {
					agentId: ctxOrEmpty.agentId ?? "",
					sessionId: (ctxOrEmpty as any).sessionId,
					toolName: options.name,
					error: (err as Error).message,
				});
				throw err;
			}
		},
	});

	// Attach metadata as non-enumerable properties so AI SDK doesn't serialize them
	Object.defineProperty(toolDef, "__meta", {
		value: meta,
		enumerable: false,
		writable: false,
	});

	Object.defineProperty(toolDef, "__name", {
		value: options.name,
		enumerable: false,
		writable: false,
	});

	// Short description for UI display
	Object.defineProperty(toolDef, "__description", {
		value: options.description,
		enumerable: false,
		writable: false,
	});

	// Full prompt for LLM context
	if (options.prompt) {
		Object.defineProperty(toolDef, "__prompt", {
			value: options.prompt,
			enumerable: false,
			writable: false,
		});
	}

	if (options.configSchema) {
		Object.defineProperty(toolDef, "__configSchema", {
			value: options.configSchema,
			enumerable: false,
			writable: false,
		});
	}

	return toolDef;
}

// ---------------------------------------------------------------------------
// Helpers to read metadata from tool objects
// ---------------------------------------------------------------------------

export function getToolMeta(toolObj: any): ToolMeta | undefined {
	return toolObj?.__meta;
}

export function getToolName(toolObj: any): string | undefined {
	return toolObj?.__name;
}

export function getToolDescription(toolObj: any): string | undefined {
	return toolObj?.__description;
}

export function getToolPrompt(toolObj: any): string | undefined {
	return toolObj?.__prompt;
}

export function getToolConfigSchema(toolObj: any): ToolConfigField[] | undefined {
	return toolObj?.__configSchema;
}

