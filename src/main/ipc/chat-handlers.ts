// 聊天消息 IPC handlers
//
// # 文件说明书
//
// ## 核心功能
// 处理聊天消息发送、会话管理等 IPC 请求
//
// ## 输入
// 用户消息文本、agentId、sessionId
//
// ## 输出
// 调用 agentService 发送消息，返回消息结果
//
// ## 定位
// src/main/ipc/ — 主进程 IPC 层，连接渲染器与 agent 运行时
//
// ## 依赖
// typed-ipc.ts、core.ts（agentService/workspaceConfig）
//
// ## 维护规则
// 聊天相关 IPC 新增通道时在此注册
//
import { homedir } from "node:os";
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import { ensureAgentService, getMainWindow } from "./core.js";

const expandHome = (p: string) => p.startsWith("~") ? p.replace(/^~/, homedir()) : p;

export function registerChatHandlers(ctx: IpcContext): void {
	typedHandle("chat:send", ["agentService", "workspaceConfig", "providerStore", "agentStore"],
		async (_ctx, text, agentId, sessionId?) => {
			const svc = await ensureAgentService();
			const agent = agentId ? _ctx.agentStore.get(agentId) : undefined;

			const wsDir = expandHome(agent?.workspaceDir || _ctx.workspaceConfig.workspaceDir);
			svc.setWorkspaceDir(wsDir);

			const providerConfigs = _ctx.providerStore.list().map((p: any) => ({
				name: p.name,
				type: p.type,
				apiKey: p.apiKey,
				baseUrl: p.baseUrl,
				models: p.models.map((m: any) => ({
					id: m.id,
					name: m.name,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
				})),
				enabled: p.enabled,
				enableConcurrencyLimit: p.enableConcurrencyLimit ?? false,
				maxConcurrency: p.maxConcurrency ?? 1,
			}));
			svc.setProviders(providerConfigs, _ctx.workspaceConfig.defaultModel, _ctx.workspaceConfig.defaultProvider);

			const win = getMainWindow();
			svc.sendPrompt(text, agent, sessionId).catch((err: any) => {
				if (win && !win.isDestroyed()) {
					win.webContents.send("agent:event", { type: "error", error: err.message, agentId: agentId ?? undefined, sessionId });
				}
			});
			return { success: true as const };
		},
	);

	typedHandle("chat:abort", ["agentService"],
		async (_ctx, agentId) => {
			if (_ctx.agentService) await _ctx.agentService.abort();
			return { success: true as const };
		},
	);
}
