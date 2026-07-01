// Hook registry
//
// # File spec
//
// ## Core
// Hook registry. Instantiable — each loop may own its own HookRegistry instance
// so handlers do not cross loops. Array-typed result fields are concatenated
// across handlers; scalar fields stay last-writer-wins; `blocked: true` short-
// circuits. `getInstance()` is kept as a transitional shared default so callers
// not yet migrated (Step 1B/1C) keep working.
//
// ## Input
// - HookEventName - event name
// - HookHandler - handler function
//
// ## Output
// - AggregatedHookResult - merged result from all handlers
//
// ## Position
// Core extension mechanism, used across the project.
//
// ## Dependencies
// - ./hook-types - Hook types
// - ./logger - logging
//
// ## Maintenance rules
// - Update types when adding a hook event
// - Keep hook execution order stable
//
import type { HookEventName, HookHandler } from "./hook-types.js";
import { log } from "./logger.js";

// ---------------------------------------------------------------------------
// AggregatedHookResult — merged result from all handlers for an event
// ---------------------------------------------------------------------------

/** Merged result from all registered handlers. Empty object = no data. */
export type AggregatedHookResult = Record<string, unknown>;

// ---------------------------------------------------------------------------
// HookRegistry — registry for lifecycle hooks
// "Hooked onto the loop, not written into the loop" — extension points that
// don't invade the loop. Instantiable; getInstance() returns a shared default
// for not-yet-migrated callers (transitional).
// ---------------------------------------------------------------------------

export class HookRegistry {
	private handlers = new Map<HookEventName, HookHandler[]>();
	private static instance: HookRegistry | null = null;

	/**
	 * @deprecated transitional — use a per-loop HookRegistry instance (Step 1B).
	 * Returns a lazily-created shared default instance so callers not yet
	 * migrated keep working.
	 */
	static getInstance(): HookRegistry {
		if (!HookRegistry.instance) HookRegistry.instance = new HookRegistry();
		return HookRegistry.instance;
	}

	/** Register a handler for an event. Returns an unsubscribe function. */
	register(event: HookEventName, handler: HookHandler): () => void {
		if (!this.handlers.has(event)) this.handlers.set(event, []);
		this.handlers.get(event)!.push(handler);
		return () => {
			const arr = this.handlers.get(event);
			if (arr) {
				const idx = arr.indexOf(handler);
				if (idx >= 0) arr.splice(idx, 1);
			}
		};
	}

	/**
	 * Trigger all handlers for an event and aggregate their results.
	 *
	 * - Each handler's returned object fields are merged into the result.
	 * - Array-typed fields are concatenated across handlers; scalar fields
	 *   stay last-writer-wins.
	 * - If any handler returns `{ blocked: true }`, aggregation stops
	 *   immediately and the result includes `blocked: true` + `reason`.
	 * - Errors are caught and logged — they never propagate to the caller.
	 * - Returns an empty object when no handlers are registered or all return void.
	 */
	async trigger(event: HookEventName, ctx: Record<string, unknown>): Promise<AggregatedHookResult> {
		const handlers = this.handlers.get(event);
		if (!handlers || handlers.length === 0) return {};

		const merged: AggregatedHookResult = {};

		for (const handler of handlers) {
			try {
				const result = await handler(ctx as any);
				if (!result || typeof result !== "object") continue;

				// blocked = immediate stop, return block result
				if ("blocked" in result && result.blocked) {
					return { blocked: true, reason: (result as any).reason ?? "Blocked by hook" };
				}

				// Merge fields. Arrays concat across handlers; scalars are
				// last-writer-wins. undefined values are skipped.
				for (const [k, v] of Object.entries(result)) {
					if (v === undefined) continue;
					if (Array.isArray(v)) {
						const prev = merged[k];
						merged[k] = [...(Array.isArray(prev) ? prev : []), ...v];
					} else {
						merged[k] = v;
					}
				}
			} catch (err) {
				log.error("hook", `Handler for ${event} threw:`, (err as Error).message);
			}
		}

		return merged;
	}

	/** Remove all handlers. Useful for testing. */
	clear(): void {
		this.handlers.clear();
	}

	/** Check if any handlers are registered for an event. */
	hasHandlers(event: HookEventName): boolean {
		const arr = this.handlers.get(event);
		return !!arr && arr.length > 0;
	}
}

/**
 * Convenience: trigger hooks on the singleton registry.
 * Automatically adds timestamp to the context.
 * Returns aggregated result from all handlers.
 */
export async function triggerHooks(
	event: HookEventName,
	ctx: Record<string, unknown>,
): Promise<AggregatedHookResult> {
	return HookRegistry.getInstance().trigger(event, { ...ctx, timestamp: Date.now() });
}
