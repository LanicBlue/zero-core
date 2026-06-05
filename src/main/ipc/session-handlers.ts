// 会话 IPC 处理器
//
// # 文件说明书
//
// ## 核心功能
// 会话相关的 IPC 处理器，处理会话列表、创建、删除等操作。
//
// ## 输入
// - IPC 通道调用
// - IpcContext - 上下文
//
// ## 输出
// - 会话数据
// - 操作结果
//
// ## 定位
// IPC 处理器，被 core.ts 注册。
//
// ## 依赖
// - ./typed-ipc - 类型化 IPC
// - ./types - 类型定义
//
// ## 维护规则
// - 新增会话操作时需同步更新
// - 保持与前端 API 一致
//
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";

export function registerSessionHandlers(_ctx: IpcContext): void {
	typedHandle("sessions:list", "agentService",
		async (ctx, agentId) => ctx.agentService.getDB().listSessions(agentId),
	);

	typedHandle("sessions:new", ["agentService", "agentStore"],
		async (ctx, agentId) => {
			const db = ctx.agentService.getDB();
			const session = db.createSession(agentId);
			db.setMainSession(agentId, session.id);
			const agent = ctx.agentStore.get(agentId);
			ctx.agentService.recreateLoop(agentId, session.id, agent);
			return session;
		},
	);

	typedHandle("sessions:switch", ["agentService"],
		async (ctx, agentId, sessionId) => {
			ctx.agentService.getDB().setMainSession(agentId, sessionId);
			await ctx.agentService.activateSession(agentId, sessionId);
			return { success: true as const, sessionId };
		},
	);

	typedHandle("sessions:activate", "agentService",
		async (ctx, agentId, sessionId) => {
			const sid = await ctx.agentService.activateSession(agentId, sessionId);
			return { success: true as const, sessionId: sid };
		},
	);

	typedHandle("sessions:current", "agentService",
		async (ctx, agentId) => ctx.agentService.getDB().getMainSession(agentId) ?? null,
	);

	typedHandle("sessions:delete", ["agentService", "agentStore"],
		async (ctx, agentId, sessionId) => {
			const db = ctx.agentService.getDB();
			const mainSession = db.getMainSession(agentId);
			db.deleteSession(sessionId);
			if (mainSession?.id === sessionId) {
				const newSession = db.createSession(agentId);
				db.setMainSession(agentId, newSession.id);
				const agent = ctx.agentStore.get(agentId);
				ctx.agentService.recreateLoop(agentId, newSession.id, agent);
				return { success: true as const, newSessionId: newSession.id };
			}
			return { success: true as const };
		},
	);

	typedHandle("sessions:metrics", "agentService",
		async (ctx) => {
			const sm = ctx.agentService.getSessionManager();
			if (!sm) {
				return { totalSessions: 0, activeSessions: 0, busySessions: 0, idleSessions: 0, totalTurns: 0, totalErrors: 0, totalToolCalls: 0, globalAvgTurnLatencyMs: 0, globalAvgToolCallDurationMs: 0, concurrencySnapshot: {}, lastUpdatedAt: Date.now(), sessions: {} };
			}
			const aggregate = sm.getAggregateMetrics();
			const sessions: Record<string, any> = {};
			for (const [id, m] of sm.getAllSessionMetrics()) {
				sessions[id] = { ...m, toolCallCounts: Object.fromEntries(m.toolCallCounts), toolCallErrors: Object.fromEntries(m.toolCallErrors) };
			}
			return { ...aggregate, concurrencySnapshot: Object.fromEntries(Object.entries(aggregate.concurrencySnapshot)), sessions };
		},
	);
}
