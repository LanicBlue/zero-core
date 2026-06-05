// 工具执行 IPC 处理器
//
// # 文件说明书
//
// ## 核心功能
// 工具执行记录的查询、统计、清理和 AI 分析 IPC 处理器。
//
// ## 输入
// - IPC 通道调用
// - IpcContext - 上下文
//
// ## 输出
// - 工具执行记录列表
// - 工具执行统计数据
// - 清理结果
// - AI 分析结果
//
// ## 定位
// IPC 处理器，被 ipc.ts 注册。
//
// ## 依赖
// - ./typed-ipc - 类型化 IPC
// - ../../runtime/provider-factory - provider 解析
//
// ## 维护规则
// - 新增工具执行操作时需同步更新
// - 保持与前端 API 一致
//
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import type { ToolExecutionFilter, ToolExecutionStats, ToolExecutionRecord } from "../../shared/types.js";
import { resolveModel } from "../../runtime/provider-factory.js";

export function registerToolExecutionHandlers(ctx: IpcContext): void {
	typedHandle("tool-executions:query", "sessionDb",
		(_ctx, filter: ToolExecutionFilter) => {
			return _ctx.sessionDb.queryToolExecutions(filter);
		},
	);

	typedHandle("tool-executions:stats", "sessionDb",
		(_ctx, agentId?: string) => {
			return _ctx.sessionDb.getToolExecutionStats(agentId);
		},
	);

	typedHandle("tool-executions:cleanup", "sessionDb",
		(_ctx, maxAgeMs: number) => {
			return _ctx.sessionDb.cleanOldToolExecutions(maxAgeMs);
		},
	);

	typedHandle("tool-executions:analyze", ["sessionDb", "agentService"],
		async (_ctx, agentId?: string) => {
			try {
				const stats = _ctx.sessionDb.getToolExecutionStats(agentId);
				const errorStats = stats.filter(s => s.errorCount > 0);

				if (errorStats.length === 0) {
					return { analysis: "No tool errors found in the recorded data.", stats, recentErrors: [] };
				}

				// Get recent error records for context
				const recentErrors = _ctx.sessionDb.queryToolExecutions({
					success: false,
					agentId,
					limit: 10,
				});

				// Build analysis prompt
				const statsSummary = errorStats
					.map(s => `- ${s.toolName}: ${s.errorCount}/${s.totalCalls} errors (${(s.errorRate * 100).toFixed(1)}%), avg ${s.avgDurationMs}ms`)
					.join("\n");

				const errorDetails = recentErrors
					.slice(0, 5)
					.map(e => `[${e.toolName}] ${e.errorMessage ?? "unknown error"}`)
					.join("\n");

				const prompt = `Analyze these tool execution errors and provide a brief diagnosis with actionable suggestions:

Error Statistics:
${statsSummary}

Recent Error Details:
${errorDetails}

Provide a concise analysis in 2-3 paragraphs.`;

				// Resolve provider and model for AI analysis
				const providerName = _ctx.workspaceConfig.defaultProvider ?? "";
				const modelId = _ctx.workspaceConfig.defaultModel ?? "";

				if (!providerName || !modelId) {
					// No provider configured — return data without AI analysis
					return {
						analysis: `AI analysis unavailable: no default provider configured.\n\nError summary:\n${statsSummary}`,
						stats,
						recentErrors,
					};
				}

				// Build provider configs from providerStore (same pattern as core.ts)
				const providerConfigs = _ctx.providerStore.list()
					.filter((p: any) => p.enabled)
					.map((p: any) => ({
						name: p.name, type: p.type, apiKey: p.apiKey, baseUrl: p.baseUrl,
						models: p.models.map((m: any) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
						enabled: p.enabled,
						enableConcurrencyLimit: p.enableConcurrencyLimit ?? false,
						maxConcurrency: p.maxConcurrency ?? 1,
					}));

				const model = resolveModel(providerConfigs, providerName, modelId);
				const { generateText } = await import("ai");
				const result = await generateText({ model, prompt });

				return { analysis: result.text, stats, recentErrors };
			} catch (err: any) {
				return { error: `Analysis failed: ${err.message}` };
			}
		},
	);
}
