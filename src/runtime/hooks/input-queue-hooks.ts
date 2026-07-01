// Input-queue injection hook (Phase C2).
//
// # 文件说明书
//
// ## 核心功能
// PrepareStep hook: inject "insert_now" queued inputs into the next step of a
// running session. This is the "立即插入" path — the user's message reaches
// the agent at the next agent-loop boundary without interrupting the current
// step and without waiting for the whole run to finish. "queued" items are
// NOT consumed here (they drain as next turns after run() returns, in
// agent-service.sendPrompt).
//
// ## 为什么是 hook
// 注入是 per-step 的事,走 PrepareStep 点位;队列数据在 server InputQueueStore。
// 本 hook 在 hooks/ 下,不内联 AgentLoop。
//
// ## 输入
// - inputQueue: InputQueueStore(consumeInsertNow)
//
import { HookRegistry } from "../../core/hook-registry.js";
import type { InputQueueStore } from "../../server/input-queue-store.js";
import { log } from "../../core/logger.js";

/**
 * Register the input-queue insert_now injection hook. Idempotent.
 */
export function registerInputQueueHooks(inputQueue: InputQueueStore, registry: HookRegistry = HookRegistry.getInstance()): void {
	registry.register("PrepareStep", async (ctx) => {
		const sessionId = ctx.sessionId as string | undefined;
		if (!sessionId) return;
		const extra = inputQueue.consumeInsertNow(sessionId);
		if (extra.length === 0) return;
		log.debug("hooks", `PrepareStep: injecting ${extra.length} insert_now input(s) for session ${sessionId}`);
		return { appendMessages: extra };
	});
	log.debug("hooks", "Input-queue insert_now injection hook registered");
}
