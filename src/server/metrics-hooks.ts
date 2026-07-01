// Metrics collection Hook registration.
//
// # File spec
//
// ## Core
// Registers hook handlers that drive SessionManager lifecycle + metrics
// calls from session/turn/error events.
//
// ## Input
// SessionManager instance
//
// ## Output
// unsubscribe function (cleanup)
//
// ## Position
// src/server/ — service layer, metrics consumer on the hook surface.
//
// ## Dependencies
// core/hook-registry.ts, core/hook-types.ts, session-manager.ts
//
// ## Maintenance rules
// Evaluate whether a new hook event needs to collect metrics here.

import { HookRegistry } from "../core/hook-registry.js";
import type { HookEventName } from "../core/hook-types.js";
import type { SessionManager } from "./session-manager.js";
import { log } from "../core/logger.js";

type Ctx = Record<string, unknown>;

export function registerMetricsHooks(sm: SessionManager, registry: HookRegistry = HookRegistry.getInstance()): () => void {
	// Note: PostToolUse/PostToolUseFailure are NOT included here — tool call
	// metrics are recorded by metrics-events.ts via stream events which have
	// accurate duration. Hooks would double-count.
	//
	// Token usage is ALSO not recorded here. Real per-step usage flows through
	// the `usage` stream event (emitted by AgentLoop.finalizeOneStep alongside
	// StepEnd) and is recorded by metrics-events.ts → recordTokenUsage. The old
	// rough estimate (msgCount×50 / len÷4) lived on TurnEnd and was both
	// inaccurate AND would double-count against the real-usage path — it has
	// been removed (Step 3B). StepEnd ctx does carry `usage`, but recording it
	// here would duplicate metrics-events.ts, so this hook intentionally does
	// NOT read usage.
	//
	// Step 1C event mapping:
	//   SessionStart   — KEPT (agent-service fires it once per loop build;
	//                    trackSessionStreaming marks the session live).
	//   SessionClose   — trackSessionIdle (loop destroy).
	//   TurnError      — trackSessionError.
	//   PreCompact     — kept (fired by session.pruneIfNeeded; recordTokenEstimate
	//                    of the pre-compact window). NOT dead code.
	const hooks: HookEventName[] = [
		"SessionStart",
		"SessionClose",
		"TurnError",
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

				case "SessionClose":
					sm.trackSessionIdle(sessionId);
					break;

				case "TurnError": {
					const errorClass = (ctx.errorClass ?? ctx.error ?? "unknown") as string;
					sm.trackSessionError(sessionId, errorClass);
					break;
				}

				case "PreCompact": {
					// PreCompact carries the pre-compact token estimate; record it
					// as an input-side estimate so the compaction delta is visible
					// in metrics. (output side is 0 — nothing generated.)
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
