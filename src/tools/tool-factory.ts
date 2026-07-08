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
import type { ToolExecutionContext } from "../runtime/types.js";
import type { ToolConfigField, ToolCategory } from "../core/tool-registry.js";
import { log } from "../core/logger.js";
import { triggerHooks } from "../core/hook-registry.js";
import type { ToolRateLimiter } from "../runtime/tool-rate-limiter.js";
import type { CallerCtx, ToolResult } from "./types.js";

// Re-export so existing consumers (e.g. tools/index.ts) can still import
// ToolCategory from tool-factory. Canonical definition lives in
// core/tool-registry.ts (single source — previously duplicated here, which
// drifted when new categories were added).
export type { ToolCategory };

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

export interface ToolMeta {
	category: ToolCategory;
	isReadOnly: boolean;
	isConcurrencySafe: boolean;
	isDestructive: boolean;
	maxResultSize: number;
	/**
	 * tool-decoupling(决策 4):是否暴露给非 agent host(UI dispatcher / MCP)。
	 * 默认按类别:OS 工具(Read/Bash/Grep)与 app 级工具(Wiki/Platform)暴露;
	 * session 作用域工具(TodoWrite/Task*)仅内部 agent host 用 → exposable=false。
	 *
	 * sub-1 只加字段不强制用 —— 现有 ToolRegistry/UI 工具页仍走 ALL_TOOLS。
	 * sub-5(UI 统一 dispatcher)读此标记决定暴露集合。
	 */
	exposable?: boolean;
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
// tool-decoupling(sub-2 过渡):map the legacy ToolExecutionContext (loop-injected
// grab-bag of services + caller identity) into the target CallerCtx shape
// (caller identity only — services read via singletons). sub-4 deletes this
// once the loop passes CallerCtx directly.
// ---------------------------------------------------------------------------

/**
 * Build a CallerCtx from the fields an AgentLoop currently puts on its
 * ToolExecutionContext. This is the **transitional** mapping: the loop still
 * threads the old ctx, but migrated tools (Platform, sub-2) take CallerCtx as
 * their second parameter and read services through module singletons.
 *
 * Mirrors the design's "loop 调:{sessionId, agentId, caller:"internal",
 * toolCallId, turnSeq, workingDir}" fill. emit is bridged from ctx.emit so
 * streaming-capable migrated tools can still flush progress (none yet, but the
 * field is wired so a future migrated Bash/Wait doesn't need a second edit).
 */
function ctxToCallerCtx(ctx: ToolExecutionContext, toolCallId: string): CallerCtx {
	const callerCtx: CallerCtx = {
		caller: "internal",
		sessionId: ctx.sessionId,
		agentId: ctx.agentId,
		toolCallId: toolCallId || ctx.currentToolCallId,
		turnSeq: ctx.turnSeq,
		workingDir: ctx.workingDir,
		// sub-3 过渡字段(sub-4/5 收敛后删):从旧 ToolExecutionContext 桥过来,
		// 让迁移工具继续读 toolConfig / readScope / wikiAnchorNodeIds / contextBundle /
		// projectId —— 这些字段在最终设计里由 host 在调用点显式填(或并入 scope)。
		toolConfig: (ctx as any).toolConfig,
		readScope: (ctx as any).readScope,
		wikiAnchorNodeIds: (ctx as any).wikiAnchorNodeIds,
		contextBundle: (ctx as any).contextBundle,
		projectId: (ctx as any).projectId,
	};
	// ctx.emit is the loop's streaming channel (runtime events → UI). Bridge it
	// so the emit contract (CallerCtx.emit) reaches migrated streaming tools.
	if (typeof (ctx as any).emit === "function") {
		callerCtx.emit = (ctx as any).emit;
	}
	return callerCtx;
}

// ---------------------------------------------------------------------------
// buildTool — factory that wraps AI SDK's tool() with metadata
// ---------------------------------------------------------------------------

/**
 * 工具原始执行函数。sub-2 起**双签名过渡**:
 *
 * - **未迁移工具**(legacy,多数):`(input, ctx: ToolExecutionContext) => Promise<string>`
 *   —— 直接返文本喂 LLM,buildTool 不调 format。`options.format` 缺省。
 * - **已迁移工具**(migrated,sub-2 起 Platform):`(input, callerCtx: CallerCtx) =>
 *   Promise<ToolResult>` —— 返结构化 JSON,buildTool 套 `format(JSON)` → 文本。
 *   `options.format` 必填。
 *
 * buildTool 据 options.format 是否存在分流。AgentLoop 仍传旧 ToolExecutionContext
 * 作为第二参(过渡);buildTool wrapper 在调 migrated execute 前把旧 ctx 映射成
 * CallerCtx(sub-4 彻底切后再删映射)。
 *
 * 两个变体用判别联合(format 是否存在区分),让未迁移工具的 ctx 仍是
 * ToolExecutionContext(它取 ctx 上几十个字段;若联合成 any 会丢类型检查),
 * migrated 工具的 ctx 是 CallerCtx(只取身份字段)。
 */
export type BuildToolOptions<T extends ZodSchema> =
	| BuildToolOptionsLegacy<T>
	| BuildToolOptionsMigrated<T>;

/** 未迁移工具:string 返值,无 format,ctx = ToolExecutionContext。 */
export interface BuildToolOptionsLegacy<T extends ZodSchema> {
	name: string;
	description: string;
	prompt?: string;
	meta?: Partial<ToolMeta>;
	configSchema?: ToolConfigField[];
	inputSchema: T;
	execute: (input: any, ctx: ToolExecutionContext) => Promise<string>;
	format?: undefined;
}

/** 已迁移工具(migrated):JSON ToolResult 返值 + format,ctx = CallerCtx。 */
export interface BuildToolOptionsMigrated<T extends ZodSchema> {
	name: string;
	description: string;
	prompt?: string;
	meta?: Partial<ToolMeta>;
	configSchema?: ToolConfigField[];
	inputSchema: T;
	/**
	 * 工具原始执行函数(新签名)。返**结构化 JSON**(`ToolResult`);buildTool
	 * wrapper 套 `format(JSON)` → 文本喂 LLM(JSON 不泄露给 LLM)。
	 *
	 * 第二参是 CallerCtx —— buildTool 把 AgentLoop 传的旧 ToolExecutionContext
	 * 映射成 CallerCtx 再调(sub-2 过渡,sub-4 删映射)。
	 */
	execute: (input: any, callerCtx: CallerCtx) => Promise<ToolResult>;
	/**
	 * tool-decoupling(决策 3):工具自带文本 formatter —— 把结构化 JSON 返值转成
	 * 喂 LLM 的文本形态。纯函数,可单测。
	 *
	 * - **agent loop** → execute → `format(JSON)` → 文本喂 LLM。
	 * - **MCP server** → execute → `format(JSON)` → 文本(或 JSON 给外部 client 自决)。
	 * - **UI/REST** → execute → JSON 直渲染(不调 format)。
	 */
	format: (result: ToolResult) => string;
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

				// tool-decoupling(决策 2/3,sub-2 双返值过渡):
				// - **migrated 工具**(options.format 是函数,如 Platform)→ 把旧
				//   ToolExecutionContext 字段映射成 CallerCtx 再调 execute;execute
				//   返结构化 ToolResult,wrapper 套 format → 文本喂 LLM(JSON 不泄露)。
				// - **未迁移工具**(无 format)→ 直传旧 ctx,execute 返 string,旧行为。
				// sub-4 删旧工具后此分支收敛为 migrated-only,ctx 映射也删。
				//
				// The typeof check is the runtime discriminant for the BuildToolOptions
				// union (format present = migrated). Capturing into a local avoids
				// re-narrowing on every options.* access below.
				const fmt = options.format;
				const isMigrated = typeof fmt === "function";
				const raw: string | ToolResult = isMigrated
					? await (options as BuildToolOptionsMigrated<typeof options.inputSchema>).execute(input, ctxToCallerCtx(ctxOrEmpty, toolCallId))
					: await (options as BuildToolOptionsLegacy<typeof options.inputSchema>).execute(input, ctxOrEmpty);

				// Normalize to the LLM-facing text:
				// - migrated: raw is ToolResult → format(JSON)。
				// - legacy:   raw is string → 直传。
				// A migrated tool that returns a string (shouldn't happen, but defensive)
				// is treated as pre-formatted text.
				let result: string;
				// tool-decoupling(sub-3 fix):migrated 工具返 {ok:false} 时按失败语义处理。
				// 此前 wrapper 把 ok:false 当成功(走 PostToolUse + recordToolUsage true),
				// 而 AI SDK 因 execute 没 throw → 发 tool-result 而非 tool-error → agent-loop
				// 的 PostToolUseFailure 路径(含 isError=true 持久化 + tool_execution success=false)
				// 完全不触发。修复:ok:false 时把 format 后的文本包成 Error 抛出,让它走与
				// legacy throw 工具完全相同的失败路径(catch 块)——单点失败语义,无双触发。
				// migrated 工具自身的 "返 JSON" 契约不受影响(execute 仍返 ToolResult);
				// 这里是 host wrapper 层把 "工具自报失败" 翻译成 "工具调用失败"。
				let migratedFailureText: string | undefined;
				if (isMigrated && raw && typeof raw === "object" && typeof (raw as ToolResult).ok === "boolean") {
					result = fmt((raw as ToolResult));
					if ((raw as ToolResult).ok === false) {
						// Prefer the structured error (concise) when present; fall back
						// to the formatted LLM-facing text so the LLM still sees a
						// useful message via AI SDK's tool-error event.
						migratedFailureText = (raw as ToolResult).error ?? result;
					}
				} else if (typeof raw === "string") {
					result = raw;
				} else {
					// Defensive: migrated tool returned a non-ToolResult object without
					// going through format — JSON-dump so the LLM still gets something.
					try { result = JSON.stringify(raw, null, 2); }
					catch { result = String(raw); }
				}

				// Migrated tool reported failure → throw so the catch block runs the
				// unified failure side (PostToolUseFailure + recordToolUsage false +
				// release limiter + rethrow → AI SDK emits tool-error → agent-loop
				// persists isError=true and tool-execution-hooks records success=false).
				if (migratedFailureText !== undefined) {
					throw new Error(migratedFailureText);
				}

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

	// tool-decoupling(决策 3,sub-2): expose format on the tool object so non-
	// agent hosts (MCP server / UI dispatcher, sub-5) can pick it up the same
	// way buildTool's wrapper does. Only present on migrated tools (Platform);
	// absent on legacy string-returning tools. Hosts that need text call
	// getToolFormat(tool)(result) → string; hosts that want JSON skip it.
	if (options.format) {
		Object.defineProperty(toolDef, "__format", {
			value: options.format,
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

export function getToolInputFields(toolObj: any): any[] {
	return toolObj?.__inputFields ?? [];
}

export function getToolExecute(toolObj: any): ((input: any, ctx: any) => Promise<string | ToolResult>) | undefined {
	return toolObj?.__execute;
}

/**
 * tool-decoupling(sub-2): read a migrated tool's format() (decision 3). Returns
 * undefined for legacy string-returning tools (no format attached). Hosts that
 * need the LLM/MCP text face call this + execute; hosts that want JSON (UI
 * dispatcher) skip it.
 */
export function getToolFormat(toolObj: any): ((result: ToolResult) => string) | undefined {
	return toolObj?.__format;
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

