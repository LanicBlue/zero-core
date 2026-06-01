import { HookRegistry } from "../core/hook-registry.js";
import type { HookEventName } from "../core/hook-types.js";
import type { SessionManager } from "./session-manager.js";
import { log } from "../core/logger.js";

type Ctx = Record<string, unknown>;

export function registerMetricsHooks(sm: SessionManager): () => void {
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
	const registry = HookRegistry.getInstance();

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
