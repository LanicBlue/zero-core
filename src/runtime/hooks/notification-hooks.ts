// PreLLMCall 钩子：把已完成的后台任务结果作为通知注入会话，并触发 Notification 观测钩子。
//
// # 文件说明书
//
// ## 核心功能
// registerNotificationHooks 在 PreLLMCall 检查 TaskRegistry 中已完成且未通知的任务，构造
// <task-notification> XML 片段以 user 消息形式塞回 session，标记已通知，并额外触发 Notification
// 钩子供 UI/日志订阅。任务结果超 2000 字会被截断。
//
// ## 输入
// - Hook 上下文：session、taskRegistry（可选）
// - TaskRegistry.getCompletedUnnotified() 返回的完成任务列表
//
// ## 输出
// - 副作用：向 session 追加一条 user 消息；调用 taskRegistry.markNotified；触发 Notification 钩子
//
// ## 定位
// runtime/hooks 层，把后台子任务结果回灌给主 agent；由 hooks/index.ts 统一注册。
//
// ## 依赖
// - core/hook-registry、core/logger
// - runtime/session、runtime/task-registry
//
// ## 维护规则
// - 通知 XML 结构若调整，需同步消费方（UI Notification 订阅者、agent prompt 提示）。
// - 截断阈值或字段（result/error/task_id）变更后注意保持向后兼容。

import { HookRegistry } from "../../core/hook-registry.js";
import { log } from "../../core/logger.js";
import type { AgentSession } from "../session.js";
import type { TaskRegistry } from "../task-registry.js";

export function registerNotificationHooks(registry: HookRegistry = HookRegistry.getInstance()): void {
	registry.register("PreLLMCall", async (ctx) => {
		const session = ctx.session as AgentSession;
		const taskRegistry = ctx.taskRegistry as TaskRegistry | undefined;
		if (!taskRegistry) return;

		const completedTasks = taskRegistry.getCompletedUnnotified();
		if (completedTasks.length === 0) return;

		const notifications = completedTasks.map((t) => {
			taskRegistry.markNotified(t.id);
			const r = t.result && t.result.length > 2000 ? t.result.slice(0, 2000) + "..." : t.result;
			const lines = [
				"<task-notification>",
				"<task_id>" + t.id + "</task_id>",
				"<status>" + t.status + "</status>",
				"<task>" + t.task + "</task>",
			];
			if (r) lines.push("<result>" + r + "</result>");
			if (t.error) lines.push("<error>" + t.error + "</error>");
			lines.push("</task-notification>");
			return lines.join("\n");
		});

		session.addMessage({ role: "user", content: notifications.join("\n\n") });

		// Fire separate Notification hook for observability on the same
		// per-loop registry (so observers scoped to this loop see it).
		await registry.trigger("Notification", {
			agentId: ctx.agentId,
			sessionId: ctx.sessionId,
			notifications: completedTasks.map((t) => ({ taskId: t.id, status: t.status, result: t.result })),
		});
	});

	log.debug("hooks", "Notification hook registered");
}
