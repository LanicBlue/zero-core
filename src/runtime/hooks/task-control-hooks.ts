// Task-control injection hook (Phase C2).
//
// # 文件说明书
//
// ## 核心功能
// PrepareStep hook: when a delegated sub-agent's task has been asked to finish
// (request_finish → status="finishing" + controlMessage persisted on the
// delegated_tasks row), inject that control message into the sub-agent's NEXT
// step so it actually sees the wrap-up instruction. Then clear the persisted
// controlMessage (advisory — delivered once).
//
// This is the delivery half of request_finish. The force-stop half (maxTurns
// budget) lives in subagent-delegator.buildSubEventHandler.
//
// ## 为什么是 hook
// request_finish 是 task 管理的事,不是 AgentLoop 的事。AgentLoop 只暴露
// per-step 注入点(PrepareStep);本 hook 按 sessionId 查 delegated_tasks 行
// 读 controlMessage,完全在 hooks/ 下,不内联进 AgentLoop。
//
// ## 输入
// - db: ISessionStore(getDelegatedTask / listDelegatedTasks / updateDelegatedTask)
//
// ## 输出
// - 副作用:向 HookRegistry 注册一个 PrepareStep 处理器
//
import { HookRegistry } from "../../core/hook-registry.js";
import type { ISessionStore } from "../session-store-interface.js";
import { log } from "../../core/logger.js";

/**
 * Register the delegated-task control-message injection hook. Idempotent —
 * safe to call once at startup. No-op when no db is provided.
 */
export function registerTaskControlHooks(db: ISessionStore | undefined, registry: HookRegistry = HookRegistry.getInstance()): void {
	if (!db?.listDelegatedTasks) return;

	registry.register("PrepareStep", async (ctx) => {
		const sessionId = ctx.sessionId as string | undefined;
		if (!sessionId) return;

		// Find a delegated task backing THIS session (the sub-agent's hidden
		// delegated session) that is "finishing" with an unread control message.
		const finishing = db.listDelegatedTasks!({ status: "finishing" });
		const task = finishing.find((t) => t.sessionId === sessionId && t.controlMessage);
		if (!task) return;

		log.debug("hooks", `PrepareStep: injecting control message for task ${task.id}`);
		// Deliver once, then clear so it doesn't repeat every step.
		db.updateDelegatedTask?.(task.id, { controlMessage: undefined });
		return {
			appendMessages: [{ role: "user", content: `[control] ${task.controlMessage}` }],
		};
	});

	log.debug("hooks", "Task-control injection hook registered");
}
