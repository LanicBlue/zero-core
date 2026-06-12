// Hook 注册表
//
// # 文件说明书
//
// ## 核心功能
// 单例 Hook 注册表，管理生命周期钩子。
//
// ## 输入
// - HookEventName - 事件名称
// - HookHandler - 处理函数
//
// ## 输出
// - AggregatedHookResult - 所有 handler 返回值的聚合结果
//
// ## 定位
// 核心扩展机制，被整个项目使用。
//
// ## 依赖
// - ./hook-types - Hook 类型
// - ./logger - 日志
//
// ## 维护规则
// - 新增 Hook 事件时需更新类型
// - 保持 Hook 执行顺序稳定
//
import type { HookEventName, HookHandler } from "./hook-types.js";
import { log } from "./logger.js";

// ---------------------------------------------------------------------------
// AggregatedHookResult — merged result from all handlers for an event
// ---------------------------------------------------------------------------

/** Merged result from all registered handlers. Empty object = no data. */
export type AggregatedHookResult = Record<string, unknown>;

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
	 * Trigger all handlers for an event and aggregate their results.
	 *
	 * - Each handler's returned object fields are merged into the result.
	 * - If any handler returns `{ blocked: true }`, aggregation stops immediately
	 *   and the result includes `blocked: true` + `reason`.
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

				// Merge data fields (last-writer-wins for same key)
				for (const [k, v] of Object.entries(result)) {
					if (v !== undefined) merged[k] = v;
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
