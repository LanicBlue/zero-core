import { tool } from "ai";
import type { ZodSchema } from "zod";
import type { ToolExecutionContext } from "../types.js";
import type { ToolConfigField } from "../../core/tool-registry.js";

// ---------------------------------------------------------------------------
// Tool metadata — inspired by Claude Code's buildTool pattern
// ---------------------------------------------------------------------------

export type ToolCategory =
	| "runtime"
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
	userDescription?: string;
	meta?: Partial<ToolMeta>;
	configSchema?: ToolConfigField[];
	inputSchema: T;
	execute: (input: any, ctx: ToolExecutionContext) => Promise<string>;
}

export function buildTool<T extends ZodSchema>(options: BuildToolOptions<T>) {
	const meta: ToolMeta = { ...DEFAULT_META, ...options.meta };

	const toolDef = tool({
		description: options.description,
		inputSchema: options.inputSchema,
		execute: async (input: any, opts: any) => {
			const ctx = opts?.experimental_context as ToolExecutionContext | undefined;
			const ctxOrEmpty = ctx ?? { workingDir: "", agentId: "", emit: () => {} };
			const result = await options.execute(input, ctxOrEmpty);
			return truncateResult(result, meta.maxResultSize);
		},
	});

	// Attach metadata as non-enumerable property so AI SDK doesn't serialize it
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

	if (options.configSchema) {
		Object.defineProperty(toolDef, "__configSchema", {
			value: options.configSchema,
			enumerable: false,
			writable: false,
		});
	}

	if (options.userDescription) {
		Object.defineProperty(toolDef, "__userDescription", {
			value: options.userDescription,
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

export function getToolConfigSchema(toolObj: any): ToolConfigField[] | undefined {
	return toolObj?.__configSchema;
}

export function getToolUserDescription(toolObj: any): string | undefined {
	return toolObj?.__userDescription;
}
