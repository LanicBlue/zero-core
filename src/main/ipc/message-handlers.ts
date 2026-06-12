// 消息管理 IPC handlers
//
// # 文件说明书
//
// ## 核心功能
// 处理消息清除、会话重置等 IPC 请求
// 支持按 turnGroup 操作（step-level 存储）
//
// ## 输入
// agentId、会话操作参数
//
// ## 输出
// 操作结果（清除/重置确认）
//
// ## 定位
// src/main/ipc/ — 主进程 IPC 层，管理消息生命周期
//
// ## 依赖
// typed-ipc.ts、agentService、agentStore
//
// ## 维护规则
// 消息操作类型变更需同步更新 shared/ipc-api.ts
//
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";

export function registerMessageHandlers(_ctx: IpcContext): void {
	typedHandle("messages:clear", ["agentService", "agentStore"],
		async (ctx, agentId) => {
			const db = ctx.agentService.getDB();
			const session = db.createSession(agentId);
			db.setMainSession(agentId, session.id);
			const agent = ctx.agentStore.get(agentId);
			ctx.agentService.recreateLoop(agentId, session.id, agent);
			return { success: true as const };
		},
	);

	// msgSeq is now a turnGroup value (from UI's `m${turnGroup}` id)
	typedHandle("messages:edit", ["agentService", "agentStore"],
		async (ctx, agentId, msgSeq, newText) => {
			const db = ctx.agentService.getDB();
			const session = db.getMainSession(agentId);
			if (!session) return { error: "session not found" };

			if (db.hasStepSchema()) {
				// Step-level: find user step in this turnGroup and update
				const steps = db.getStepGroup(session.id, msgSeq);
				for (const step of steps) {
					if (step.role === "user") {
						db.updateStepContent(session.id, step.seq, newText);
					}
				}
			} else {
				db.updateTurnContent(session.id, msgSeq, newText);
			}

			// Also update messages table
			const rows = db.getMessagesWithSeq(session.id);
			const target = rows.find((r: any) => r.seq === msgSeq);
			if (target) {
				const msg = JSON.parse(target.msg_json);
				msg.content = newText;
				db.updateMessageContent(session.id, msgSeq, newText, JSON.stringify(msg));
			}
			const agent = ctx.agentStore.get(agentId);
			ctx.agentService.recreateLoop(agentId, session.id, agent);
			return { success: true as const };
		},
	);

	// msgSeq is now a turnGroup value — delete entire group
	typedHandle("messages:delete", ["agentService", "agentStore"],
		async (ctx, agentId, msgSeq) => {
			const db = ctx.agentService.getDB();
			const session = db.getMainSession(agentId);
			if (!session) return { error: "session not found" };

			if (db.hasStepSchema()) {
				// Step-level: delete all steps in the turnGroup
				db.deleteStepGroup(session.id, msgSeq);
			} else {
				db.deleteTurn(session.id, msgSeq);
			}
			db.deleteMessage(session.id, msgSeq);
			const agent = ctx.agentStore.get(agentId);
			ctx.agentService.recreateLoop(agentId, session.id, agent);
			return { success: true as const };
		},
	);
}
