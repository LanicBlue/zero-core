// 提取者 hooks —— steps-overhaul sub-7 RETIRED(决策 53 修订)
//
// # 文件说明书
//
// ## 核心功能(RETIRED)
// 这个模块原本承载 M5 的两条阈值抽取通路:
//   ① StepEnd hook (机制 2):按 token 预算低点 [0.2/0.45/0.7] 触发 Extractor A
//      增量抽取(cursor 后 delta)+ 并行调度 Extractor B。
//   ② closeFlushSession(sessionId) (机制 3):agent-service 在 evict 时对尾批跑
//      最后一次 Extractor A delta。
//
// **sub-7 把这两条通路退役**(design.md「wiki memory」:wiki 抽取现在由压缩
// Extractor A 承担 —— compressSession 每段 summary 喂一次 Extractor A 多步
// agent 合并进 topic wiki;决策 53 修订)。本模块的 StepEnd 阈值 hook +
// closeFlushSession 都不再做任何抽取。
//
// ## 为什么保留这个文件(而不是删)
// - `ExtractorBService` 类(server/extractor-b-service.ts)仍保留(决策 49:
//   tool telemetry 是独立数据流,平台改进数据,非项目知识)。B 的未来触发器
//   不在本 sub 范围内(本 sub 只退役 A 的 wiki 抽取通路 + 共用阈值触发)。
//   该类可被新触发器独立调用。
// - `registerExtractionHooks` / `closeFlushSession` / `ExtractionHooksDeps`
//   保留为 **no-op stub**,让现有调用点(hooks/index.ts、agent-service.ts
//   evict、m5-extractors.test)的 import 不破。stubs 记一行 debug 日志标注
//   退役,不再调度任何 extractor。
// - 这是"通路退役,接口签名保留"——调用点不需要同步改(降低回归面)。后续
//   sub/清理可以彻底删调用点。
//
// ## 不变量(sub-7)
// - registerExtractionHooks(...) 是 no-op:不注册任何 StepEnd handler。
// - closeFlushSession(...) 是 no-op:不跑任何 extractor。
// - runExtractionOnDelta / 阈值列表 [0.2/0.45/0.7] 已删除(不再可达)。
// - Extractor A 的 wiki 合并现在由 compressSession 喂
//   (compressSession → extractorA.service.mergeSummaryIntoWiki)。
//
// ## 定位
// runtime/hooks 层;由 hooks/index.ts 统一 import。已退役,仅留 no-op stub。
//
// ## 维护规则
// - 未来要恢复 B 的触发(或加新抽取)时,在本文件重新注册 StepEnd handler,
//   不要 bypass compressSession 的 Extractor A 通路(wiki 抽取由它独占)。
//

import { HookRegistry } from "../../core/hook-registry.js";
import type { SessionConfig, RuntimeProviderConfig } from "../types.js";
import { log } from "../../core/logger.js";

/**
 * Deps shape kept for back-compat with callers that still build it
 * (hooks/index.ts, server/index.ts, m5-extractors.test). The fields are no
 * longer consumed — registerExtractionHooks is a no-op.
 */
export interface ExtractionHooksDeps {
	cursorStore?: any;
	buildExtractorA?: (providers: RuntimeProviderConfig[], providerName: string, modelId: string) => any;
	buildExtractorB?: (providers: RuntimeProviderConfig[], providerName: string, modelId: string) => any;
	resolveThresholds?: (config: SessionConfig) => number[];
}

/**
 * RETIRED (sub-7). Previously registered the M5 StepEnd threshold hook that
 * fired Extractor A + B on token-budget low points [0.2/0.45/0.7]. The wiki
 * extraction (A) now lives in compressSession's Extractor A multi-step agent
 * (decision 53 修订); B's trigger is out of scope for sub-7. This is now a
 * no-op so existing wiring (hooks/index.ts, server/index.ts) doesn't break —
 * the deps are accepted and ignored.
 */
export function registerExtractionHooks(_deps: ExtractionHooksDeps, _registry: HookRegistry = HookRegistry.getInstance()): void {
	log.debug("hooks", "Extraction hooks RETIRED (sub-7 — wiki extraction now in compression Extractor A); register is a no-op");
}

/**
 * RETIRED (sub-7). Previously ran Extractor A on the tail batch after the
 * cursor when a session was evicted. The wiki extraction now happens during
 * compression (compressSession → Extractor A); the close-flush tail path is
 * subsumed by the archive's last compression (sub-8). This is now a no-op
 * so agent-service.evictSessionFromMemory's call site doesn't break.
 */
export async function closeFlushSession(_args: {
	sessionId: string;
	resolveConfig: () => SessionConfig | undefined;
	resolveProviders: () => RuntimeProviderConfig[];
}): Promise<void> {
	// No-op. The session's memory has already been merged into the wiki tree
	// by compression's Extractor A (the compression trigger fires on cold +
	// threshold throughout the session's life). See sub-7 design notes.
	return;
}

/** Test helper — kept for back-compat (m5-extractors.test resets state). Now a no-op. */
export function _resetExtractionScheduler(): void {
	// No module state to reset — extraction scheduler is retired.
}
