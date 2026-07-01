// 工具执行记录 Hook 注册
//
// # 文件说明书
//
// ## 核心功能
// 将工具执行记录注册到 Hook 系统，在 PreToolUse/PostToolUse/PostToolUseFailure 事件中自动采集执行数据
//
// ## 输入
// SessionDB 实例
//
// ## 输出
// 数据库中的工具执行记录
//
// ## 定位
// src/server/ — 服务层，Hook 系统的工具执行记录消费者
//
// ## 依赖
// core/hook-registry.ts、session-db.ts、core/logger.ts
//
// ## 维护规则
// recordToolExecution 参数变更需同步更新此处的字段提取逻辑
//
import { HookRegistry } from "../core/hook-registry.js";
import type { SessionDB } from "./session-db.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Tool execution recording hooks — capture tool timing and results to DB
// Replaces the former inline recordToolExecution in agent-loop.ts
// ---------------------------------------------------------------------------

// Per-invocation start time + args, keyed by toolCallId
const pendingExecutions = new Map<string, { startTime: number; args: unknown }>();

export function registerToolExecutionHooks(sessionDb: SessionDB, registry: HookRegistry = HookRegistry.getInstance()): void {

	registry.register("PreToolUse", async (ctx) => {
		try {
			const toolCallId = ctx.toolCallId as string | undefined;
				const turnSeq = ctx.turnSeq as number | undefined;
			if (!toolCallId) return;
			pendingExecutions.set(toolCallId, { startTime: Date.now(), args: ctx.args });
		} catch (err) {
			log.error("tool-exec-hooks", "PreToolUse hook failed:", (err as Error).message);
		}
	});

	registry.register("PostToolUse", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			const agentId = ctx.agentId as string;
			const toolName = ctx.toolName as string;
			const toolCallId = ctx.toolCallId as string | undefined;
				const turnSeq = ctx.turnSeq as number | undefined;

			const entry = toolCallId ? pendingExecutions.get(toolCallId) : undefined;
			const durationMs = entry ? Date.now() - entry.startTime : 0;
			const input = entry?.args ?? ctx.args;
			if (toolCallId) pendingExecutions.delete(toolCallId);

			// 子代理 sessionId=undefined(隔离父会话,不持久化)——审计表 session_id NOT NULL,
			// 无 session 则跳过写库,工具结果已由 TaskRegistry 持有。详见 project-v08-tool-hardening §3。
			if (!sessionId) return;

			const inputPreview = truncatePreview(input, 500);
			const outputStr = typeof ctx.result === "string" ? ctx.result : JSON.stringify(ctx.result);
			const outputPreview = truncateStr(outputStr, 500);

			sessionDb.recordToolExecution({
				sessionId,
				agentId,
				toolName,
				success: true,
				inputPreview,
				outputPreview,
				durationMs,
			});
		} catch (err) {
			log.error("tool-exec-hooks", "PostToolUse hook failed:", (err as Error).message);
		}
	});

	registry.register("PostToolUseFailure", async (ctx) => {
		try {
			const sessionId = ctx.sessionId as string;
			const agentId = ctx.agentId as string;
			const toolName = ctx.toolName as string;
			const toolCallId = ctx.toolCallId as string | undefined;
				const turnSeq = ctx.turnSeq as number | undefined;

			const entry = toolCallId ? pendingExecutions.get(toolCallId) : undefined;
			const durationMs = entry ? Date.now() - entry.startTime : 0;
			const input = entry?.args ?? ctx.args;
			if (toolCallId) pendingExecutions.delete(toolCallId);

			// 子代理 sessionId=undefined → 跳过审计写库(同 PostToolUse)。
			if (!sessionId) return;

			const inputPreview = truncatePreview(input, 500);
			const errorStr = typeof ctx.error === "string" ? ctx.error : String(ctx.error ?? "");

			sessionDb.recordToolExecution({
				sessionId,
				agentId,
				toolName,
				success: false,
				errorMessage: errorStr,
				inputPreview,
				durationMs,
			});
		} catch (err) {
			log.error("tool-exec-hooks", "PostToolUseFailure hook failed:", (err as Error).message);
		}
	});

	log.db("Tool execution recording hooks registered");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateStr(s: string | undefined, max: number): string | undefined {
	if (!s) return s;
	return s.length > max ? s.slice(0, max) + "..." : s;
}

function truncatePreview(v: unknown, max: number): string | undefined {
	if (v === undefined) return undefined;
	const s = typeof v === "string" ? v : JSON.stringify(v);
	return truncateStr(s ?? "", max);
}
