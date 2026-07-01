// 指标收集 Hook 注册
//
// # 文件说明书
//
// ## 核心功能
// 将指标收集逻辑注册到 Hook 系统，在会话生命周期事件中自动采集指标
//
// ## 输入
// SessionManager 实例
//
// ## 输出
// 注销函数（cleanup）
//
// ## 定位
// src/server/ — 服务层，Hook 系统的指标收集消费者
//
// ## 依赖
// core/hook-registry.ts、core/hook-types.ts、session-manager.ts
//
// ## 维护规则
// 新增 hook 事件需评估是否需要在此收集指标
//
import { HookRegistry } from "../core/hook-registry.js";
import type { HookEventName } from "../core/hook-types.js";
import type { SessionManager } from "./session-manager.js";
import { log } from "../core/logger.js";

type Ctx = Record<string, unknown>;

export function registerMetricsHooks(sm: SessionManager, registry: HookRegistry = HookRegistry.getInstance()): () => void {
	// Note: PostToolUse/PostToolUseFailure are NOT included here —
	// tool call metrics are recorded by metrics-events.ts via stream events
	// which have accurate duration. Hooks would double-count.
	const hooks: HookEventName[] = [
		"SessionStart",
		"SessionEnd",
		"Stop",
		"StopFailure",
		"PreCompact",
	];

	const unsubscribes: Array<() => void> = [];

	const handler = async (ctx: Ctx): Promise<void> => {
		const sessionId = ctx.sessionId as string | undefined;
		if (!sessionId) return;

		try {
			switch (ctx.hookEvent as HookEventName) {
				case "SessionStart":
					sm.trackSessionStreaming(sessionId);
					break;

				case "SessionEnd":
					sm.trackSessionIdle(sessionId);
					break;

				case "Stop": {
					const messageCount = ctx.messageCount as number | undefined;
					const resultText = ctx.resultText as string | undefined;
					// Rough token estimate: ~4 chars per token
					if (resultText) {
						const outputTokens = Math.ceil(resultText.length / 4);
						const inputTokens = (messageCount ?? 0) * 50;
						sm.recordTokenEstimate(sessionId, inputTokens, outputTokens);
					}
					break;
				}

				case "StopFailure": {
					const errorClass = (ctx.errorClass ?? ctx.error ?? "unknown") as string;
					sm.trackSessionError(sessionId, errorClass);
					break;
				}

				case "PreCompact": {
					const estTokens = ctx.estimatedTokens as number | undefined;
					if (estTokens) {
						sm.recordTokenEstimate(sessionId, estTokens, 0);
					}
					break;
				}
			}
		} catch (err) {
			log.debug("metrics-hooks", `Error in metrics hook: ${(err as Error).message}`);
		}
	};

	for (const event of hooks) {
		const wrapped = async (ctx: Ctx) => handler({ ...ctx, hookEvent: event });
		unsubscribes.push(registry.register(event, wrapped));
	}

	return () => { for (const unsub of unsubscribes) unsub(); };
}
