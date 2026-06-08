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
