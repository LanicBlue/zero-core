// 工具执行历史查询、统计、清理与 LLM 错误分析的 REST 入口
//
// # 文件说明书
//
// ## 核心功能
// 提供工具执行历史的查询(/query)、聚合统计(/stats)、按时间清理(/cleanup),以及 /analyze:从 sessionDb 拉取错误统计与最近失败记录,组装 prompt 调用默认 provider 的 generateText 让模型给出诊断建议;没有可用 provider 时返回纯统计的兜底分析。
//
// ## 输入
// - 注入 sessionDb(执行历史读取)、agentService、providerStore、workspaceConfig
// - POST /query 请求体为 ToolExecutionFilter
// - GET /stats query: { agentId? }
// - POST /cleanup 请求体 { maxAgeMs }
// - POST /analyze 请求体 { agentId? }
//
// ## 输出
// - /query 返回执行记录列表;/stats 返回按工具聚合的统计
// - /cleanup 返回清理结果
// - /analyze 返回 { analysis, stats, recentErrors } 或 { error }
//
// ## 定位
// src/server/ 服务层,挂载于 /api/tool-executions,服务于调试面板与工具健康度分析。
//
// ## 依赖
// - express Router
// - ../runtime/provider-factory(resolveModel)
// - 动态 import("ai") 的 generateText
// - ../shared/types(ToolExecutionFilter)
//
// ## 维护规则
// - /analyze 失败要返回 200 + { error } 而非 500,避免阻塞前端展示统计。
// - prompt 模板改动需与中文/英文展示风格保持一致;错误摘要最多取 5 条避免 token 爆炸。
// - 新增分析维度(如按 agent / 时间窗口)时优先扩展 ToolExecutionFilter 与 sessionDb 查询。
//

import { Router } from "express";
import { resolveModel } from "../runtime/provider-factory.js";
import type { ToolExecutionFilter } from "../shared/types.js";

export function createToolExecutionRouter(deps: {
	sessionDb: any;
	agentService: any;
	providerStore: any;
	workspaceConfig: any;
}): Router {
	const router = Router();
	const { sessionDb, agentService, providerStore, workspaceConfig } = deps;

	router.post("/query", (req, res) => {
		res.json(sessionDb.queryToolExecutions(req.body as ToolExecutionFilter));
	});

	router.get("/stats", (req, res) => {
		const agentId = req.query.agentId as string | undefined;
		res.json(sessionDb.getToolExecutionStats(agentId));
	});

	router.post("/cleanup", (req, res) => {
		const maxAgeMs = req.body.maxAgeMs as number;
		res.json(sessionDb.cleanOldToolExecutions(maxAgeMs));
	});

	router.post("/analyze", async (req, res) => {
		const agentId = req.body?.agentId as string | undefined;
		try {
			const stats = sessionDb.getToolExecutionStats(agentId);
			const errorStats = stats.filter((s: any) => s.errorCount > 0);

			if (errorStats.length === 0) {
				return res.json({ analysis: "No tool errors found in the recorded data.", stats, recentErrors: [] });
			}

			const recentErrors = sessionDb.queryToolExecutions({
				success: false,
				agentId,
				limit: 10,
			});

			const statsSummary = errorStats
				.map((s: any) => `- ${s.toolName}: ${s.errorCount}/${s.totalCalls} errors (${(s.errorRate * 100).toFixed(1)}%), avg ${s.avgDurationMs}ms`)
				.join("\n");

			const errorDetails = recentErrors
				.slice(0, 5)
				.map((e: any) => `[${e.toolName}] ${e.errorMessage ?? "unknown error"}`)
				.join("\n");

			const prompt = `Analyze these tool execution errors and provide a brief diagnosis with actionable suggestions:

Error Statistics:
${statsSummary}

Recent Error Details:
${errorDetails}

Provide a concise analysis in 2-3 paragraphs.`;

			const providerName = workspaceConfig.defaultProvider ?? "";
			const modelId = workspaceConfig.defaultModel ?? "";

			if (!providerName || !modelId) {
				return res.json({
					analysis: `AI analysis unavailable: no default provider configured.\n\nError summary:\n${statsSummary}`,
					stats,
					recentErrors,
				});
			}

			const providerConfigs = providerStore.list()
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

			res.json({ analysis: result.text, stats, recentErrors });
		} catch (err: any) {
			res.json({ error: `Analysis failed: ${err.message}` });
		}
	});

	return router;
}
