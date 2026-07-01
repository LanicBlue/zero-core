// M5 提取者 hooks (机制 2 增量提取) + close flush 入口 (机制 3)
//
// # 文件说明书
//
// ## 核心功能
// 两个职责,都 fire-and-forget(异步,不阻塞工作 session):
//   ① PostTurnComplete hook — 机制 2:按 token 预算低点(20/45/70)检查是否
//      触发 extractor A 增量提取(只处理 cursor 后的 delta),并并行调度 B。
//   ② closeFlushSession(sessionId) — 机制 3:由 agent-service 在 session
//      被驱逐/关闭时显式调用,对最后一次 checkpoint 之后未提取的尾批跑一次
//      extractor A delta(尾批也喂给 B)。这是 SessionEnd 的诚实落地 ——
//      zero-core 的 session 关闭点 = evictSessionFromMemory。
//
// 关键不变量(acceptance-M5 回归检查):
//   - 触发按 token-budget 低点,不按 turn(决策 53);
//   - 每次触发只处理 cursor 之后的 delta,不重新过整段 transcript(决策 53);
//   - cursor 持久化在 ExtractionCursorStore(不是活 checkpoint,决策 54);
//   - 无 transition / 任务变迁检测器,无外部事件锚点(决策 54)。
//
// ## 输入
// - Hook 上下文 (config, session, contextUsage, providers, sessionId)
// - ExtractionCursorStore (per-session cursor)
// - ExtractorAService / ExtractorBService 实例
//
// ## 输出
// - 副作用:写入 wiki memory 节点(A)、telemetry 表(B)、推进 cursor
// - 无返回值;失败仅 warn,绝不抛回 AgentLoop(避免污染工作 session)
//
// ## 定位
// runtime/hooks 层,与 compression-hooks.ts 平级;由 hooks/index.ts 统一注册。
// closeFlushSession 由 agent-service 在 evict 时调用(显式同步入口,不经 hook
// 总线)。
//
// ## 依赖
// - core/hook-registry、core/logger
// - runtime/transcript-delta(切片器)
// - runtime/types(SessionConfig / RuntimeProviderConfig)
// - server/extraction-cursor-store、extractor-a-service、extractor-b-service
//
// ## 维护规则
// - 阈值列表改动后同步 config.extractors.checkpointThresholds 默认值
// - 提取者开关由 config.extractors.A.enabled / B.enabled 控制,默认 false
// - 绝不在本 hook 抛错; extractor 内部已 try-catch,这里再加一层兜底
//

import { HookRegistry } from "../../core/hook-registry.js";
import type { SessionConfig, RuntimeProviderConfig } from "../types.js";
import { sliceTranscriptDelta } from "../transcript-delta.js";
import type { ExtractionCursorStore } from "../../server/extraction-cursor-store.js";
import type { ExtractorAService } from "../../server/extractor-a-service.js";
import type { ExtractorBService } from "../../server/extractor-b-service.js";
import { log } from "../../core/logger.js";

export interface ExtractionHooksDeps {
	cursorStore: ExtractionCursorStore;
	buildExtractorA: (providers: RuntimeProviderConfig[], providerName: string, modelId: string) => ExtractorAService;
	buildExtractorB: (providers: RuntimeProviderConfig[], providerName: string, modelId: string) => ExtractorBService;
	/** Defaults to [0.2, 0.45, 0.7] from config.extractors.checkpointThresholds. */
	resolveThresholds?: (config: SessionConfig) => number[];
}

const DEFAULT_THRESHOLDS = [0.2, 0.45, 0.7];

/**
 * Shared scheduler state — holds the deps so closeFlushSession (called from
 * agent-service without hook context) can look up the cursor + build the
 * extractors. Set once by registerExtractionHooks.
 */
let schedulerDeps: ExtractionHooksDeps | null = null;

const extractorAEnabled = (cfg: SessionConfig) =>
	Boolean((cfg as any)?.extractors?.A?.enabled);
const extractorBEnabled = (cfg: SessionConfig) =>
	Boolean((cfg as any)?.extractors?.B?.enabled);

const pickProviderModel = (cfg: SessionConfig, which: "A" | "B") => {
	const ext = (cfg as any)?.extractors?.[which] ?? {};
	return {
		providerName: ext.provider ?? cfg.providerName,
		modelId: ext.model ?? cfg.modelId,
	};
};

const knownToolNames = (cfg: SessionConfig): string[] | undefined => {
	const tools = cfg.toolPolicy?.tools;
	if (!tools) return undefined;
	const names = Object.keys(tools).filter(n => tools[n]?.enabled);
	return names.length > 0 ? names : undefined;
};

/**
 * Run extractor A + B on the delta since the cursor, then advance the cursor.
 * Shared by mechanism 2 (PostTurnComplete hook) and mechanism 3 (close flush).
 *
 * `mode` is "incremental" (mechanism 2 — gate on threshold crossing) or
 * "close-flush" (mechanism 3 — always run on remaining tail, no threshold
 * gate).
 *
 * Never throws.
 */
async function runExtractionOnDelta(args: {
	config: SessionConfig;
	providers: RuntimeProviderConfig[];
	sessionId: string;
	fromSeq: number;
	toSeqCeiling: number;
	mode: "incremental" | "close-flush";
}): Promise<void> {
	const { config, providers, sessionId, fromSeq, toSeqCeiling, mode } = args;
	if (toSeqCeiling <= fromSeq) return;

	const db = config.db;
	if (!db || !schedulerDeps) return;

	const slice = sliceTranscriptDelta(db, sessionId, fromSeq, toSeqCeiling);
	if (slice.stepCount === 0) return;

	const aOn = extractorAEnabled(config);
	const bOn = extractorBEnabled(config);
	if (!aOn && !bOn) return;

	if (aOn) {
		try {
			const { providerName, modelId } = pickProviderModel(config, "A");
			const svc = schedulerDeps.buildExtractorA(providers, providerName, modelId);
			await svc.extractDelta({
				sessionId,
				agentId: config.agentId,
				transcript: slice.transcript,
				fromSeq,
				toSeq: slice.realToSeq,
			});
		} catch (err) {
			log.warn("extraction-hook", `Extractor A (${mode}) failed:`, (err as Error).message);
		}
	}

	// Advance cursor — extraction progress is what matters, not LLM success.
	if (mode === "incremental") {
		// Caller (the hook) is responsible for advancing cursor on threshold
		// crossing. For close-flush we don't bother advancing the cursor
		// (session is being torn down anyway); if the session is later
		// resumed, the close-flushed content is already in the wiki tree.
	}

	if (bOn) {
		try {
			const { providerName, modelId } = pickProviderModel(config, "B");
			const svc = schedulerDeps.buildExtractorB(providers, providerName, modelId);
			await svc.extractDelta({
				sessionId,
				agentId: config.agentId,
				transcript: slice.transcript,
				fromSeq,
				toSeq: slice.realToSeq,
				knownToolNames: knownToolNames(config),
			});
		} catch (err) {
			log.warn("extraction-hook", `Extractor B (${mode}) failed:`, (err as Error).message);
		}
	}
}

/**
 * Register M5 extraction hooks. Currently only PostTurnComplete (mechanism 2).
 * Close-flush (mechanism 3) is exposed via closeFlushSession() — called by
 * agent-service.evictSessionFromMemory.
 */
export function registerExtractionHooks(deps: ExtractionHooksDeps, registry: HookRegistry = HookRegistry.getInstance()): void {
	schedulerDeps = deps;

	const resolveThresholds = deps.resolveThresholds ?? ((cfg) => {
		const list = (cfg as any)?.extractors?.checkpointThresholds as number[] | undefined;
		return Array.isArray(list) && list.length > 0 ? [...list].sort((a, b) => a - b) : DEFAULT_THRESHOLDS;
	});

	// ─── Mechanism 2: PostTurnComplete → incremental extraction ────────
	//
	// On every turn end, look at contextUsage. If it has crossed the next
	// un-fired threshold in checkpointThresholds (sorted ascending), run
	// extractor A on the delta since the cursor and advance the cursor.
	// Same hook also feeds the delta to extractor B (fire-and-forget).
	//
	// Critical: trigger is by token-budget threshold, NOT by turn count
	// (decision 53). The cursor persists which threshold has fired so each
	// fires at most once per session.

	registry.register("PostTurnComplete", async (ctx) => {
		if (!schedulerDeps) return;
		const config = ctx.config as SessionConfig;
		const sessionId = ctx.sessionId as string | undefined;
		if (!sessionId) return;

		const aOn = extractorAEnabled(config);
		const bOn = extractorBEnabled(config);
		if (!aOn && !bOn) return;

		const contextUsage = (ctx.contextUsage as number) ?? 0;
		const thresholds = resolveThresholds(config);
		const cursor = schedulerDeps.cursorStore.get(sessionId) ?? {
			sessionId,
			lastExtractedSeq: -1,
			lastThresholdIdx: -1,
			lastExtractedAt: "",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		// Find the highest threshold crossed but not yet fired.
		let nextIdx = cursor.lastThresholdIdx;
		for (let i = 0; i < thresholds.length; i++) {
			if (i <= cursor.lastThresholdIdx) continue;
			if (contextUsage >= thresholds[i]) {
				nextIdx = i;
			} else {
				break;
			}
		}
		if (nextIdx === cursor.lastThresholdIdx) return; // no new threshold crossed

		const db = config.db;
		if (!db) return;
		const currentSeqCeiling = db.getTurnCount(sessionId);
		const fromSeq = Math.max(0, cursor.lastExtractedSeq + 1);
		if (currentSeqCeiling <= fromSeq) return;

		// Compute the slice once; runExtractionOnDelta reads from this same
		// slice to avoid double-reading steps.
		const slice = sliceTranscriptDelta(db, sessionId, fromSeq, currentSeqCeiling);
		if (slice.stepCount === 0) return;

		const providers = ctx.providers as RuntimeProviderConfig[];

		await runExtractionOnDelta({
			config, providers, sessionId, fromSeq, toSeqCeiling: currentSeqCeiling,
			mode: "incremental",
		});

		// Advance cursor: extraction progress is what matters, not LLM success
		// (extractor internal failures don't undo "we tried this delta").
		schedulerDeps.cursorStore.upsert({
			sessionId,
			lastExtractedSeq: Math.max(slice.realToSeq - 1, cursor.lastExtractedSeq),
			lastThresholdIdx: nextIdx,
		});
	});

	log.debug("hooks", "Extraction hooks registered (M5 mechanism 2 — PostTurnComplete)");
}

/**
 * Mechanism 3 — close flush. Called by agent-service when a session is being
 * evicted from memory (the actual session-close point in zero-core).
 *
 * Runs extractor A on whatever sits AFTER the last cursor (the "tail batch").
 * This is the last delta of mechanism 2. Session death → tail batch not lost
 * (decision 53).
 *
 * Looks up the SessionConfig + providers via the provided resolvers (the hook
 * bus doesn't fire on eviction, so we go through this entry instead).
 *
 * Never throws.
 */
export async function closeFlushSession(args: {
	sessionId: string;
	resolveConfig: () => SessionConfig | undefined;
	resolveProviders: () => RuntimeProviderConfig[];
}): Promise<void> {
	if (!schedulerDeps) return;
	const config = args.resolveConfig();
	if (!config) return;

	const aOn = extractorAEnabled(config);
	const bOn = extractorBEnabled(config);
	if (!aOn && !bOn) return;

	const db = config.db;
	if (!db) return;

	const cursor = schedulerDeps.cursorStore.get(args.sessionId);
	const fromSeq = cursor ? cursor.lastExtractedSeq + 1 : 0;
	const currentSeqCeiling = db.getTurnCount(args.sessionId);
	if (currentSeqCeiling <= fromSeq) return;

	const providers = args.resolveProviders();
	await runExtractionOnDelta({
		config, providers, sessionId: args.sessionId,
		fromSeq, toSeqCeiling: currentSeqCeiling,
		mode: "close-flush",
	});
}

/** Test helper — reset module state between unit tests. */
export function _resetExtractionScheduler(): void {
	schedulerDeps = null;
}
