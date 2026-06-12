// Task notification hook handler
//
// PreLLMCall handler: inject completed background task notifications into session.
// Extracted from agent-loop's injectTaskNotifications() per the hook-driven architecture.
// Also fires the Notification hook for observability.

import { HookRegistry } from "../../core/hook-registry.js";
import { log } from "../../core/logger.js";
import type { AgentSession } from "../session.js";
import type { TaskRegistry } from "../task-registry.js";

export function registerNotificationHooks(): void {
	HookRegistry.getInstance().register("PreLLMCall", async (ctx) => {
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

		// Fire separate Notification hook for observability
		await HookRegistry.getInstance().trigger("Notification", {
			agentId: ctx.agentId,
			sessionId: ctx.sessionId,
			notifications: completedTasks.map((t) => ({ taskId: t.id, status: t.status, result: t.result })),
		});
	});

	log.debug("hooks", "Notification hook registered");
}
