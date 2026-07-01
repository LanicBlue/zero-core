// 工具工厂
//
// # 文件说明书
//
// ## 核心功能
// 工具注册和构建，提供工具元数据和执行函数。
//
// ## 输入
// - 工具定义
// - 配置字段
//
// ## 输出
// - 工具注册信息
// - 执行函数
//
// ## 定位
// 工具模块核心，被 runtime 和其他模块使用。
//
// ## 依赖
// - ai - AI SDK
// - zod - 数据验证
// - ../types - 运行时类型
//
// ## 维护规则
// - 新增工具类型时需更新
// - 保持工具注册一致性
//
import { tool } from "ai";
import type { ZodSchema } from "zod";
import type { ToolExecutionContext } from "../types.js";
import type { ToolConfigField } from "../../core/tool-registry.js";
import { log } from "../../core/logger.js";
import { triggerHooks } from "../../core/hook-registry.js";
import type { ToolRateLimiter } from "../tool-rate-limiter.js";

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
	| "agent"
	| "management"
	| "workflow";

export interface ToolMeta {
	category: ToolCategory;
	isReadOnly: boolean;
	isConcurrencySafe: boolean;
	isDestructive: boolean;
	maxResultSize: number;
}

const DEFAULT_META: ToolMeta = {
	category: "runtime",
	isReadOnly: true,
	isConcurrencySafe: true,
	isDestructive: false,
	maxResultSize: 30000,
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
// Tool usage logging (v0.8 P3 §7.7 #4) — best-effort per-call log
// ---------------------------------------------------------------------------

/**
 * Record one tool invocation to the tool_usage table. Best-effort: any error
 * is swallowed (logging must never break the tool path). Params are redacted
 * to a short summary to avoid write amplification + avoid leaking secrets in
 * inputs (e.g. Read/Write path strings).
 *
 * The ToolUsageStore is injected through ctx.toolUsageStore (only present on
 * sessions that wired it — server mode). When absent, this is a no-op.
 */
function recordToolUsage(
	toolName: string,
	input: unknown,
	startTs: number,
	ctx: ToolExecutionContext | { agentId?: string; sessionId?: string },
	success: boolean,
	_errorMsg?: string,
): void {
	try {
		const store = (ctx as any)?.toolUsageStore as
			| { record: (input: any) => unknown }
			| undefined;
		if (!store) return;
		store.record({
			toolName,
			agentId: (ctx as any).agentId,
			sessionId: (ctx as any).sessionId,
			calledAt: new Date(startTs).toISOString(),
			params: summarizeParams(input),
			success,
			durationMs: Date.now() - startTs,
		});
	} catch {
		// best-effort — never break the tool call on logging failure
	}
}

/**
 * Reduce a tool input to a compact, secret-safe summary for the usage log.
 * Strategy: keep action + a few scalar identifiers, drop large blobs
 * (system prompts, doc bodies, etc.). Capped at ~500 chars.
 */
function summarizeParams(input: unknown): unknown {
	if (input == null || typeof input !== "object") return input;
	const src = input as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(src)) {
		if (v == null) continue;
		if (typeof v === "string") {
			out[k] = v.length > 200 ? v.slice(0, 200) + "…(truncated)" : v;
		} else if (typeof v === "number" || typeof v === "boolean") {
			out[k] = v;
		} else {
			// objects/arrays — store a length hint only (avoid leaking nested
			// prompt content / large toolPolicy blobs).
			try {
				const json = JSON.stringify(v);
				out[k] = json.length > 200 ? `(${json.length} chars)` : JSON.parse(json);
			} catch {
				out[k] = "(unserializable)";
			}
		}
	}
	return out;
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
			const toolCallId = (opts?.toolCallId ?? opts?.id ?? "") as string;
			// v0.8 (P3 §7.7 #4): wall-clock the tool call for tool_usage log.
			const startTs = Date.now();

			// PreToolUse hook — can block execution
			const preResult = await triggerHooks("PreToolUse", {
				agentId: ctxOrEmpty.agentId ?? "",
				sessionId: ctxOrEmpty.sessionId,
				turnSeq: ctxOrEmpty.turnSeq,
				toolName: options.name,
				args: input,
				toolCallId,
				});
			if (preResult?.blocked) {
				return `Tool blocked: ${preResult.reason}`;
			}

			// Rate limiting — acquire slot before execution
			const limiter = ctxOrEmpty.rateLimiter;
			const rlConfig = ctxOrEmpty.toolConfig?.[options.name];
			if (limiter && rlConfig && (rlConfig.minInterval > 0 || rlConfig.maxConcurrent > 0)) {
				log.debug("rate-limit", options.name + ": minInterval=" + rlConfig.minInterval + " maxConcurrent=" + rlConfig.maxConcurrent);
				await limiter.acquire(options.name, {
					minInterval: rlConfig.minInterval,
					maxConcurrent: rlConfig.maxConcurrent,
				});
			}

			try {
				// Step 2E: surface this invocation's toolCallId to the tool so
				// delegation tools (Agent/Orchestrate) can stamp the resulting
				// delegated task with its parent tool-call id.
				ctxOrEmpty.currentToolCallId = toolCallId || undefined;
				const result = await options.execute(input, ctxOrEmpty);
				await triggerHooks("PostToolUse", {
					agentId: ctxOrEmpty.agentId ?? "",
					sessionId: ctxOrEmpty.sessionId,
					turnSeq: ctxOrEmpty.turnSeq,
					toolName: options.name,
					result,
					isError: false,
					args: input,
					toolCallId,
				});
				if (limiter && rlConfig) limiter.release(options.name);
				recordToolUsage(options.name, input, startTs, ctxOrEmpty, true);
				return truncateResult(result, meta.maxResultSize);
			} catch (err) {
				await triggerHooks("PostToolUseFailure", {
					agentId: ctxOrEmpty.agentId ?? "",
					sessionId: ctxOrEmpty.sessionId,
					turnSeq: ctxOrEmpty.turnSeq,
					toolName: options.name,
					error: (err as Error).message,
					args: input,
					toolCallId,
				});
				if (limiter && rlConfig) limiter.release(options.name);
				recordToolUsage(options.name, input, startTs, ctxOrEmpty, false, (err as Error).message);
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

	Object.defineProperty(toolDef, "__inputFields", {
		value: extractInputFields(options.inputSchema),
		enumerable: false,
		writable: false,
	});

	Object.defineProperty(toolDef, "__execute", {
		value: options.execute,
		enumerable: false,
		writable: false,
	});

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

export function getToolInputFields(toolObj: any): any[] {
	return toolObj?.__inputFields ?? [];
}

export function getToolExecute(toolObj: any): ((input: any, ctx: ToolExecutionContext) => Promise<string>) | undefined {
	return toolObj?.__execute;
}

// ---------------------------------------------------------------------------
// Zod schema introspection for input form generation
// ---------------------------------------------------------------------------

function extractInputFields(schema: any): Array<{ key: string; type: string; required: boolean; description?: string; enum?: string[] }> {
	if (!schema?._def?.shape) return [];
	const shape = typeof schema._def.shape === "function" ? schema._def.shape() : schema._def.shape;
	return Object.entries(shape).map(([key, field]: [string, any]) => {
		let inner = field;
		let required = true;
		// Zod v4: _def.type === "optional", v3: _def.typeName === "ZodOptional"
		if (inner._def?.type === "optional" || inner._def?.typeName === "ZodOptional") {
			inner = inner._def.innerType;
			required = false;
		}
		const typeName = inner._def?.type ?? inner._def?.typeName ?? "";
		let type = "string";
		if (typeName === "number" || typeName === "ZodNumber") type = "number";
		else if (typeName === "boolean" || typeName === "ZodBoolean") type = "boolean";
		else if (typeName === "enum" || typeName === "ZodEnum") type = "select";
		const result: any = { key, type, required };
		if (inner._def?.description) result.description = inner._def.description;
		// Zod v4: _def.options, v3: _def.values
		if (typeName === "enum" || typeName === "ZodEnum") {
			result.enum = inner.options ?? inner._def?.options ?? inner._def?.values ?? [];
		}
		return result;
	});
}

