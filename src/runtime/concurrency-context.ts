// 并发调度上下文(AsyncLocalStorage + tier 映射)
//
// # 文件说明书
//
// ## 核心功能
// platform-observability ②.4:
//   - `turnSourceToTier(source)` 把 TurnSource 映射成数字优先级档(小=高优先)。
//   - `concurrencyContext`(AsyncLocalStorage)在 agent-loop.run/resume 起始 set
//     `{ sessionId, agentId, tier }`,provider-factory 中间件 acquire 时 read,
//     把 tier + 身份挂到 waiter 上 → release 按 tier 严格优先级出队。
//
// ## 输入
// TurnSource / 当前 session 的 agentId / sessionId
//
// ## 输出
// concurrencyContext(als 实例)+ getConcurrencyContext / runInConcurrencyContext
// + turnSourceToTier
//
// ## 定位
// src/runtime/ —— agent-loop 与 provider-factory 之间的优先级传递通道。
//
// ## 依赖
// node:async_hooks、./types.js(TurnSource)
//
// ## 维护规则
// - tier 数字语义变更必须同步 sub-3 文档 + release() 出队逻辑。
// - ALS 上下文只放 LLM 调用链必需的字段(身份 + tier);不要塞业务数据。
//
import { AsyncLocalStorage } from "node:async_hooks";
import type { TurnSource } from "./types.js";

/**
 * Priority tier (lower = higher priority). ②.4 严格优先级调度用。
 *
 *  - user      → P1(用户在等,最高优先)
 *  - work/cron → P2(系统主动发起)
 *  - background→ P3(delegated / 未明确,可饿死,本期接受)
 *
 * 数字而非符号:release() 直接 Math.min 选最高档;同 tier FIFO 按 waitedSince。
 * 未指定 source 的旧路径默认走 P3(等价旧行为 —— FIFO 同档即 FIFO)。
 */
export const TIER_P1 = 1;
export const TIER_P2 = 2;
export const TIER_P3 = 3;

export function turnSourceToTier(source: TurnSource | undefined): number {
	switch (source) {
		case "user":
			return TIER_P1;
		case "work":
		case "cron":
			return TIER_P2;
		case "background":
		case undefined:
		default:
			return TIER_P3;
	}
}

export interface ConcurrencyContext {
	/** 当前 turn 的 session(undefined 仅测试/无 loop 上下文)。 */
	sessionId?: string;
	/** 当前 turn 的 agent。 */
	agentId?: string;
	/** turnSourceToTier(source) 的结果。 */
	tier: number;
}

/**
 * AsyncLocalStorage 容器。run() 一次 turn 用 runInConcurrencyContext 包住,
 * 中间件 acquire 时 getConcurrencyContext() 拿 tier + 身份挂到 waiter。
 *
 * 跨 async 边界:streamText / wrapStream / wrapGenerate 都在 run() 的 await
 * 链里,ALS 自动透传。subagent 是独立 AgentLoop,各自 run() set 自己的 context。
 */
export const concurrencyContext = new AsyncLocalStorage<ConcurrencyContext>();

/**
 * 在 ALS 上下文里跑 fn。agent-loop.run/resume 起始调用,scope 覆盖整 turn。
 */
export function runInConcurrencyContext<T>(
	ctx: ConcurrencyContext,
	fn: () => Promise<T>,
): Promise<T> {
	return concurrencyContext.run(ctx, fn);
}

/**
 * 读当前 ALS 上下文。无上下文(测试 / 直接调 provider)返回 undefined。
 */
export function getConcurrencyContext(): ConcurrencyContext | undefined {
	return concurrencyContext.getStore();
}
