// tool-decoupling sub-5(决策 4):UI 统一 dispatcher。
//
// UI 经 IPC `tool:run` → 本 dispatcher → getToolExecute(tool)(input, callerCtx)
// → JSON 返 UI。取代 UI 用的所有 REST(sessions:parents / provider:stats /
// runtime-tasks / tool-execute 等)。agent / MCP / UI 三 host 全部调同一
// `getToolExecute`(原始 execute,返 ToolResult JSON);agent 还在它外面套
// buildTool wrapper(hook / rate-limit / format),UI 跳过 wrapper 直拿 JSON。
//
// # 文件说明书
// ## 核心功能
// dispatch({tool, input, scope?, workingDir?}) —— 调一个已迁工具的原始 execute,
// 返结构化结果(UI 直渲染)。错误捕获 → {ok:false, error}(UI 不崩)。
// ## 输入
// DispatchRequest {tool, input, scope?, workingDir?}。
// ## 输出
// DispatchResponse {ok, result?, error?, elapsedMs}。result 是 ToolResult
// (工具 execute 的 JSON 返值);UI 直接渲染 result.data。
// ## 定位
// src/server/ —— UI host 的统一入口,被 server/index.ts 的 /api/tool-run REST
// 路由 + ipc-proxy 的 tool:run 通道共用。
// ## 维护规则
// - 新工具自动可用(全暴露,无可见性策略 —— 决策 4:UI 可信端)。
// - session 作用域工具(TodoWrite/Task*)在 UI 调用时 callerCtx 无真实 loop
// 状态 → 工具返默认/示例值(G1)。
// - 工具抛错 → 结构化错误(UI 不崩);不要调 toolDef.execute(AI SDK wrapper,
// migrated 失败会 throw 走 agent 失败路径,UI 不该走那条)。

import { ALL_TOOLS } from "../tools/index.js";
import { getToolExecute } from "../tools/tool-factory.js";
import type { CallerCtx, CallerScope } from "../tools/types.js";

/**
 * UI 调工具的请求体。`tool` 是工具名(如 "Wiki"/"WebSearch");`input` 是
 * LLM-visible schema 描述的输入(做什么);`scope?`/`workingDir?` 是 host
 * 解析后注入的身份/沙箱(决策 G5,工具不自查)。
 *
 * `toolConfig?` 是 per-tool 默认配置(Read.max_lines / Grep.head_limit /
 * WebSearch.provider …)—— server 侧从 registry 的 toolPolicy 解出后注入,
 * UI 本身无 toolPolicy。工具 execute 读 callerCtx.toolConfig 取默认值
 * (sub-5 B4 正名保留此字段)。
 */
export interface DispatchRequest {
	tool: string;
	input: Record<string, unknown>;
	/** 可选:限定 projectId / readOnly / allowedTools(MCP token 解析风格)。 */
	scope?: CallerScope;
	/** 可选:工作目录(影响 Read/Write/Grep 等的相对路径解析)。 */
	workingDir?: string;
	/** 可选:per-tool 默认配置(Read.max_lines 等);server 从 toolPolicy 注入。 */
	toolConfig?: Record<string, Record<string, any>>;
	/** 可选:文件访问范围;server 从 workspaceConfig.readScope 注入。 */
	readScope?: "filesystem" | "workspace";
}

/**
 * UI 调工具的响应。成功 → `result` 是 ToolResult(工具 execute 的 JSON 返值);
 * 失败 → `error` 字符串。`elapsedMs` 总在(便于 UI 显示耗时)。结构向后兼容
 * 旧 tool-execute REST({ok, result, elapsedMs} / {ok:false, error, elapsedMs})。
 */
export interface DispatchResponse {
	ok: boolean;
	result?: unknown;
	error?: string;
	elapsedMs: number;
}

/**
 * 列出 dispatcher 暴露的所有工具(供 UI 工具选择 / schema 渲染)。决策 4:全工具
 * 暴露,无可见性策略。返名 → 工具句柄的 map;调用方用 getToolExecute 取 execute。
 */
export function listDispatchableTools(): Record<string, unknown> {
	return ALL_TOOLS;
}

/**
 * 调一个已迁工具的原始 execute(input, callerCtx) → ToolResult JSON。
 *
 * - callerCtx = {caller:"ui", scope?, workingDir?} —— UI host 的身份注入。
 *   不带 loop 状态(todos/taskRegistry/delegateFns 缺失),所以 session 作用域
 *   工具(TodoWrite/Task*)返默认/示例值(G1)。
 * - 走 `getToolExecute(tool)`(原始 execute,返 ToolResult JSON),**不**调
 *   `toolDef.execute`(AI SDK wrapper —— migrated 失败会 throw 走 agent 失败
 *   路径,UI 不该走那条)。sub-3 验证 agent 的 note 已强调这点。
 * - 工具抛错 → 捕获 → {ok:false, error}(UI 不崩)。
 * - 工具返 {ok:false}(自报失败)→ 原样转发给 UI(UI 看 result.ok=false 自行
 *   显示错误);**不**throw(那是 agent wrapper 的翻译,UI dispatcher 不做)。
 */
export async function dispatchTool(req: DispatchRequest): Promise<DispatchResponse> {
	const toolName = req.tool;
	const toolDef = ALL_TOOLS[toolName];
	if (!toolDef) {
		return { ok: false, error: `Tool not found: ${toolName}`, elapsedMs: 0 };
	}

	const execute = getToolExecute(toolDef);
	if (!execute) {
		return { ok: false, error: `Tool not executable: ${toolName}`, elapsedMs: 0 };
	}

	// Build the UI callerCtx. No loop state → session-scoped tools degrade to
	// defaults/examples (G1: "UI 也可调 session 工具,工具返默认/示例值供预览").
	// scope/workingDir/toolConfig/readScope passed through verbatim (host-resolved, G5).
	const callerCtx: CallerCtx = {
		caller: "ui",
		...(req.scope ? { scope: req.scope } : {}),
		...(req.workingDir ? { workingDir: req.workingDir } : {}),
		...(req.toolConfig ? { toolConfig: req.toolConfig } : {}),
		...(req.readScope ? { readScope: req.readScope } : {}),
	};

	const t0 = Date.now();
	try {
		const result = await execute(req.input, callerCtx);
		return { ok: true, result, elapsedMs: Date.now() - t0 };
	} catch (err: any) {
		return {
			ok: false,
			error: err?.message ?? String(err),
			elapsedMs: Date.now() - t0,
		};
	}
}
