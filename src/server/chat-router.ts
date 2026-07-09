// Chat REST 入口,把前端输入转发给 AgentService 触发一轮对话或中断
//
// # 文件说明书
//
// ## 核心功能
// 提供 POST /send 与 POST /abort 两个端点,设置 AgentService 的工作目录、注入 Provider 列表并发起一轮对话;abort 用于中止当前正在执行的任务。
//
// ## 输入
// - 请求体 { text, agentId?, sessionId? }: 用户输入文本、可选 agentId 与续接 sessionId
// - AgentStore、ProviderStore、AgentService 与 workspaceConfig 注入
//
// ## 输出
// - POST /send、POST /abort 返回 { success: true } 标志请求已受理
// - 流式输出、工具调用与错误通过 AgentService 订阅事件转发至 WebSocket
//
// ## 定位
// src/server/ 服务层,挂载于 /api/chat,是前端 chat 入口的同步触发器;真正的流式与状态由 AgentService 与 WebSocket 承载。
//
// ## 依赖
// - express Router
// - AgentService.createAgentService、AgentStore、ProviderStore
// - workspaceConfig(工作目录与默认 provider/model)
//
// ## 维护规则
// - 新增预处理(如 agent 选择策略、provider 覆盖、上下文裁剪)时优先放在 AgentService,本路由只做参数装配。
// - 不要在此处直接返回流式数据,保持 fire-and-forget 语义;事件统一走 WebSocket。
//

import { Router } from "express";
import { homedir } from "node:os";
import type { createAgentService } from "./agent-service.js";
import type { AgentStore } from "./agent-store.js";
import type { ProviderStore } from "./provider-store.js";
// multimodal-input sub-4: chat:send carries attachment META only (principle A).
// The renderer uploaded bytes via attachments:upload (sub-1) and now passes just
// AttachmentMeta[] (with diskPath); the backend wraps text + attachments into a
// UserContent and hands it to sendPrompt → loop.run.
import type { AttachmentMeta, UserContent } from "../shared/types.js";

const expandHome = (p: string) => p.startsWith("~") ? p.replace(/^~/, homedir()) : p;

export function createChatRouter(deps: {
	agentService: ReturnType<typeof createAgentService>;
	agentStore: AgentStore;
	providerStore: ProviderStore;
	workspaceConfig: any;
}): Router {
	const router = Router();
	const { agentService, agentStore, providerStore, workspaceConfig } = deps;

	router.post("/send", async (req, res) => {
		const { text, agentId, sessionId, attachments } = req.body as { text: string; agentId?: string; sessionId?: string; attachments?: AttachmentMeta[] };
		const agent = agentId ? agentStore.get(agentId) : undefined;

		const wsDir = expandHome(agent?.workspaceDir || workspaceConfig.workspaceDir);
		agentService.setWorkspaceDir(wsDir);

		const providerConfigs = providerStore.list().map((p: any) => ({
			name: p.name,
			type: p.type,
			apiKey: p.apiKey,
			baseUrl: p.baseUrl,
			models: p.models.map((m: any) => ({
				id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, multimodal: m.multimodal,
			})),
			enabled: p.enabled,
			enableConcurrencyLimit: p.enableConcurrencyLimit ?? false,
			maxConcurrency: p.maxConcurrency ?? 1,
		}));
		agentService.setProviders(providerConfigs, workspaceConfig.defaultModel, workspaceConfig.defaultProvider);

		// multimodal-input sub-4 (principle A): chat:send carries attachment META
		// only (diskPath + kind/size/mime); bytes never enter this body. When
		// attachments are present, wrap text + attachments into a UserContent;
		// otherwise pass the bare string (back-compat / cheapest path).
		const prompt: string | UserContent = Array.isArray(attachments) && attachments.length > 0
			? { text: text ?? "", attachments }
			: (text ?? "");
		agentService.sendPrompt(prompt, agent, sessionId, "user").catch(() => {
			// Error events are forwarded via WebSocket
		});

		res.json({ success: true });
	});

	router.post("/abort", async (req, res) => {
		// Session-scoped abort: only the named session's loop is stopped. The
		// renderer always knows the sessionId of the session the user clicked
		// Stop on — without it we must NOT abort, because the legacy fallback
		// (abort-by-agent / abort-all-busy) would stop OTHER sessions of the
		// same agent (or every running session) — session state is independent.
		const { sessionId } = req.body ?? {};
		if (sessionId) await agentService.abort(undefined, sessionId);
		res.json({ success: true });
	});

	return router;
}
