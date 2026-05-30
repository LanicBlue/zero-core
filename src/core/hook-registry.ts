import type { HookEventName, HookHandler, HookResult } from "./hook-types.js";
import { log } from "./logger.js";

// ---------------------------------------------------------------------------
// HookRegistry — singleton registry for lifecycle hooks
// "挂在循环上，不写进循环里" — extension points that don't invade the loop
// ---------------------------------------------------------------------------

export class HookRegistry {
	private handlers = new Map<HookEventName, HookHandler[]>();
	private static instance: HookRegistry | null = null;

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
	 * Trigger all handlers for an event. First handler to return a non-void
	 * result wins (first-writer-wins). Errors are caught and logged — they
	 * never propagate to the caller.
	 */
	async trigger(event: HookEventName, ctx: Record<string, unknown>): Promise<HookResult> {
		const handlers = this.handlers.get(event);
		if (!handlers || handlers.length === 0) return;
		for (const handler of handlers) {
			try {
				const result = await handler(ctx as any);
				if (result) return result;
			} catch (err) {
				log.error("hook", `Handler for ${event} threw:`, (err as Error).message);
			}
		}
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
 */
export async function triggerHooks(
	event: HookEventName,
	ctx: Record<string, unknown>,
): Promise<HookResult> {
	return HookRegistry.getInstance().trigger(event, { ...ctx, timestamp: Date.now() });
}
