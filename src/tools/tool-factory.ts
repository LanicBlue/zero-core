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
import type { CallerCtx, ToolResult, TodoAccessor, TaskRegistryAccessor, DelegateFns, AgentResolvers } from "./types.js";
// todo state lives in a leaf module (no imports from the tools/runtime graph) so
// it can be imported STATICALLY here without the tool-factory ↔ todo-write
// cycle that forced the old lazy `require` (undefined under ESM).
import { getSessionTodos, setSessionTodosForCtx } from "./todo-state.js";

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
// tool-decoupling sub-5(B2):ctxToCallerCtx + 4 accessor builders DELETED.
// AgentLoop now constructs CallerCtx directly (see AgentLoop.buildCallerCtx).
// The wrapper reads callerCtx from experimental_context.buildCallerCtx(toolCallId);
// legacy callers (tests / server tool-execute) that pass a bare ToolExecutionContext
// get a fallback callerCtx via callerCtxFromLegacyCtx below.
// ---------------------------------------------------------------------------

/**
 * Build a CallerCtx from a legacy ToolExecutionContext (fallback path).
 *
 * Production (AgentLoop) passes `experimental_context.buildCallerCtx(toolCallId)`
 * — the loop owns callerCtx construction (B2). Tests and the server tool-execute
 * endpoint still pass a bare ToolExecutionContext as experimental_context; this
 * helper bridges it into a CallerCtx with the FULL field set (identity +
 * transitional fields + delegateFns + agentResolvers + todos/taskRegistry
 * accessors + project-flow session state), mirroring the deleted ctxToCallerCtx.
 *
 * Without this, Task-family / Orchestrate / Flow tools would see missing
 * delegateFns in test/server paths and degrade (those tools are exercised by
 * sub-4/sub-10 tests via bare-ctx runTool).
 */
function callerCtxFromLegacyCtx(ctx: ToolExecutionContext, toolCallId: string): CallerCtx {
	const sessionId = ctx.sessionId;
	const agentId = ctx.agentId;

	const todos: TodoAccessor = {
		list: () => {
			if (!sessionId && !agentId) return [];
			return getSessionTodos(sessionId ?? agentId ?? "_default");
		},
		set: (items) => {
			setSessionTodosForCtx(sessionId, agentId, items);
		},
	};

	const taskRegistry: TaskRegistryAccessor | undefined =
		(ctx.listTasks || ctx.getTaskResult)
			? {
				list: (filter) => {
					const all = ctx.listTasks?.(filter) ?? [];
					return all.map((t: any) => ({
						id: t.id, type: t.type, task: t.task, status: t.status,
						targetAgentId: t.targetAgentId,
					}));
				},
				get: (taskId) => {
					const t = ctx.getTaskResult?.(taskId);
					if (!t) return null;
					return {
						id: t.id, type: t.type, task: t.task, status: t.status,
						targetAgentId: t.targetAgentId,
					};
				},
			}
			: undefined;

	const delegateFns: DelegateFns = {
		delegateTask: ctx.delegateTask,
		delegateTaskBackground: ctx.delegateTaskBackground,
		getTaskResult: ctx.getTaskResult,
		listTasks: ctx.listTasks,
		stopTask: ctx.stopTask,
		abandonTask: ctx.abandonTask,
		acknowledgeTask: ctx.acknowledgeTask,
		requestTaskFinish: ctx.requestTaskFinish,
		resumeTaskBackground: ctx.resumeTaskBackground,
		getTaskRecentCalls: ctx.getTaskRecentCalls,
		runBackground: ctx.runBackground,
		suspendUntilWake: ctx.suspendUntilWake,
		beginWait: ctx.beginWait,
		endWait: ctx.endWait,
		setWaitStartedAt: ctx.setWaitStartedAt,
		setToolCallTaskId: ctx.setToolCallTaskId,
	};

	const agentResolvers: AgentResolvers = {
		resolveAgent: (ctx as any).resolveAgent,
		resolveSubagentTarget: (ctx as any).resolveSubagentTarget,
		subagents: (ctx as any).subagents,
	};

	const callerCtx: CallerCtx = {
		caller: "internal",
		sessionId: ctx.sessionId,
		agentId: ctx.agentId,
		toolCallId: toolCallId || ctx.currentToolCallId,
		turnSeq: ctx.turnSeq,
		workingDir: ctx.workingDir,
		// transitional fields (B4 collapses):
		toolConfig: (ctx as any).toolConfig,
		readScope: (ctx as any).readScope,
		contextBundle: (ctx as any).contextBundle,
		projectId: (ctx as any).projectId,
		todos,
		taskRegistry,
		delegateFns,
		agentResolvers,
		// project-flow / Orchestrate session state:
		flowActions: (ctx as any).flowActions,
		orchestratePlanStore: (ctx as any).orchestratePlanStore,
		orchestrateManifestStore: (ctx as any).orchestrateManifestStore,
		gitIntegration: (ctx as any).gitIntegration,
		activeRequirementId: (ctx as any).activeRequirementId,
		featureWorkspace: (ctx as any).featureWorkspace,
	};
	if (typeof (ctx as any).emit === "function") {
		callerCtx.emit = (ctx as any).emit;
	}
	return callerCtx;
}


// ---------------------------------------------------------------------------
// buildTool — factory that wraps AI SDK's tool() with metadata
// ---------------------------------------------------------------------------

/**
 * 工具构建选项(tool-decoupling sub-5 收敛后单一形态)。
 *
 * sub-2 起的过渡期里 buildTool 同时认两种签名(legacy string 返值 / migrated
 * ToolResult + format),用判别联合 `BuildToolOptionsLegacy | BuildToolOptionsMigrated`
 * 区分。sub-5 把所有工具迁完(sub-2..sub-5,A 把 agent-registry/web-search/
 * sequential-thinking 收尾),过渡期结束 —— buildTool 只剩 migrated 形态:
 *
 * - `execute: (input, callerCtx: CallerCtx) => Promise<ToolResult>` —— 返结构化 JSON。
 * - `format: (result: ToolResult) => string` —— 必填,把 JSON 转 LLM 文本。
 *
 * AgentLoop 仍传旧 ToolExecutionContext 作为 AI SDK experimental_context(过渡);
 * buildTool wrapper 在调 execute 前把它经 `ctxToCallerCtx` 映射成 CallerCtx。
 * sub-5 B2 把这步搬进 AgentLoop 直建 callerCtx,届时 `ctxToCallerCtx` 删。
 */
export interface BuildToolOptions<T extends ZodSchema> {
	name: string;
	description: string;
	prompt?: string;
	meta?: Partial<ToolMeta>;
	configSchema?: ToolConfigField[];
	inputSchema: T;
	/**
	 * 工具原始执行函数。返**结构化 JSON**(`ToolResult`);buildTool wrapper 套
	 * `format(JSON)` → 文本喂 LLM(JSON 不泄露给 LLM)。
	 *
	 * 第二参是 CallerCtx(host 注入的调用者身份 + per-session 访问器)。
	 * sub-2..sub-4 过渡期 buildTool 把 AgentLoop 传的旧 ToolExecutionContext 经
	 * `ctxToCallerCtx` 映射成 CallerCtx 再调;sub-5 B2 起 AgentLoop 直建 callerCtx。
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
			// tool-decoupling sub-5(B2):experimental_context 现在是 AgentLoop 直建
			// 的 host 对象 {ctx: ToolExecutionContext, buildCallerCtx: (id)=>CallerCtx}。
			// 旧 ctx 仍是 wrapper 的 hook / rate-limit / usage-log 源;callerCtx 由
			// AgentLoop 直建(不再经 ctxToCallerCtx 桥)。两路回退:旧调用方传纯
			// ToolExecutionContext(测试 / server tool-execute)→ 兜底空 callerCtx。
			const host = opts?.experimental_context;
			const ctx = (host && typeof host === "object" && "ctx" in host
				? (host as { ctx: ToolExecutionContext }).ctx
				: host) as ToolExecutionContext | undefined;
			const ctxOrEmpty = ctx ?? { workingDir: "", agentId: "", emit: () => {} };
			const buildCallerCtx = (host && typeof host === "object" && "buildCallerCtx" in host
				? (host as { buildCallerCtx: (id: string) => CallerCtx }).buildCallerCtx
				: null);
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

				// tool-decoupling(决策 2/3,sub-5 收敛):
				// 所有工具都 migrated —— execute 返 ToolResult,wrapper 套 format(JSON)
				// → 文本喂 LLM(JSON 不泄露给 LLM)。callerCtx 由 AgentLoop 直建
				// (B2:experimental_context.buildCallerCtx);旧 ctx 仅供 wrapper 的
				// hook / rate-limit / usage-log 读。
				//
				// Fallback:测试 / server tool-execute 直传旧 ToolExecutionContext
				// (无 buildCallerCtx)→ callerCtxFromLegacyCtx 桥完整 callerCtx
				// (身份 + transitional + delegateFns + agentResolvers + 访问器 +
				// session 状态),等同 sub-4 前 ctxToCallerCtx。
				const callerCtx: CallerCtx = buildCallerCtx
					? buildCallerCtx(toolCallId)
					: callerCtxFromLegacyCtx(ctxOrEmpty, toolCallId);
				const raw = await options.execute(input, callerCtx);

				// tool-decoupling(sub-3 fix):工具返 {ok:false} 时按失败语义处理。
				// 此前 wrapper 把 ok:false 当成功(走 PostToolUse + recordToolUsage true),
				// 而 AI SDK 因 execute 没 throw → 发 tool-result 而非 tool-error → agent-loop
				// 的 PostToolUseFailure 路径(含 isError=true 持久化 + tool_execution success=false)
				// 完全不触发。修复:ok:false 时把 format 后的文本包成 Error 抛出,让它走与
				// 抛错工具完全相同的失败路径(catch 块)——单点失败语义,无双触发。
				// 工具自身的 "返 JSON" 契约不受影响(execute 仍返 ToolResult);
				// 这里是 host wrapper 层把 "工具自报失败" 翻译成 "工具调用失败"。
				let result: string;
				let failureText: string | undefined;
				if (raw && typeof raw === "object" && typeof (raw as ToolResult).ok === "boolean") {
					result = options.format(raw as ToolResult);
					if ((raw as ToolResult).ok === false) {
						// Prefer the structured error (concise) when present; fall back
						// to the formatted LLM-facing text so the LLM still sees a
						// useful message via AI SDK's tool-error event.
						failureText = (raw as ToolResult).error ?? result;
					}
				} else if (typeof raw === "string") {
					// Defensive: a tool returned a string instead of ToolResult
					// (shouldn't happen post-migration). Treat as pre-formatted text.
					result = raw;
				} else {
					// Defensive: tool returned a non-ToolResult object — JSON-dump so
					// the LLM still gets something.
					try { result = JSON.stringify(raw, null, 2); }
					catch { result = String(raw); }
				}

				// Tool reported failure → throw so the catch block runs the unified
				// failure side (PostToolUseFailure + recordToolUsage false + release
				// limiter + rethrow → AI SDK emits tool-error → agent-loop persists
				// isError=true and tool-execution-hooks records success=false).
				if (failureText !== undefined) {
					throw new Error(failureText);
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

	// tool-decoupling(决策 3):expose format on the tool object so non-agent hosts
	// (MCP server / UI dispatcher) can pick it up the same way buildTool's wrapper
	// does. Hosts that need text call getToolFormat(tool)(result) → string; hosts
	// that want JSON skip it. Post-sub-5 collapse this is always present.
	Object.defineProperty(toolDef, "__format", {
		value: options.format,
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

export function getToolExecute(toolObj: any): ((input: any, callerCtx: any) => Promise<ToolResult>) | undefined {
	return toolObj?.__execute;
}

/**
 * tool-decoupling(决策 3):read a tool's format() —— 把结构化 ToolResult 转 LLM 文本。
 * sub-5 收敛后所有工具都 migrated,format 总在。Hosts that need the LLM/MCP text
 * face call this + execute; hosts that want JSON (UI dispatcher) skip it.
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

