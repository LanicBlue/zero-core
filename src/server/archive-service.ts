// 归档管线服务 (steps-overhaul sub-8)
//
// # 文件说明书
//
// ## 核心功能
// 单向归档 = **末次 Extractor A 压缩 → 导出 JSON → 删库(含孤儿) → wiki 留存**。
// 任一触发后都走这套(`archiveSession`)。
//
// ① **末次压缩**:把残留 step(游标之后、fresh-tail 之外)的记忆抽进 wiki。
//    复用 sub-4 `compressSession` + sub-7 Extractor A 的多步合并通路 —— 与
//    平时 mid-turn 压缩**完全相同的代码路径**(lazy-require ExtractorAService,
//    buildFinalCompressOpts 镜像 compression-trigger-hooks 的连线)。归档也压缩
//    (design.md「归档」:"归档也压缩")。失败仅 warn,不阻塞归档主干(记忆抽不
//    进 wiki 比丢整个 session 轻 —— JSON 仍落盘)。
//
// ② **导出 JSON**:该 session 的自有数据 = `sessions` 行 + `steps` 全量 +
//    `messages` summary 全量 + 压缩游标 → 落盘
//    `~/.zero-core/archives/<agentId>/<sessionId>.json`(plain JSON,与 wiki/
//    archives 同根;目录不存在则建;按 agentId 分目录)。文件名 = sessionId
//    (唯一)。**plain JSON**(v1,可读;真大了再加 gzip —— design.md「JSON 细节」)。
//
// ③ **删库**:`db.deleteSessionData(sessionId)` —— 删 `sessions`/`steps`/
//    `messages` 行 + `tool_executions`/`delegated_tasks` **孤儿**(全
//    `WHERE session_id`)。Wiki 节点**不删**(跨 session 留存 —— 归档只删
//    session 自有内容,记忆节点留存)。
//
// ## 触发(sub-8)
// - **delegated(子 agent)完成**:`subagent-delegator.ts` 任务
//   `completed/failed` → 调本服务。子 agent 跑完即沉,天然完成态,**无需额外
//   runtime teardown**(归档前子 AgentLoop 已 run() return / abort)。
// - **chat(前台)手动**:走现有 chat UI 归档按钮 → session-router → 本服务。
//   若该 session 仍活跃(还在跑 AgentLoop),**先 teardown runtime**(停 loop /
//   注销 handle / 清 in-memory 状态:turn-seq-tracker、compression-trigger-
//   hooks 的 lastLLMCall/compressedThisTurn/防抖 Map 该 session 条目),再走管线。
// - **cron/main(父 agent)不自动归档**(design.md:父 agent 持久,用户保留)。
//
// ## 不做归档恢复
// archive JSON 只留档,**无 restore 通路**(不建 UI/IPC/命令读回)。归档 = 单向
// "导出 + 删"(design.md「不做归档恢复」)。本服务不提供任何 read-back / load /
// restore 方法。
//
// ## 关键不变量(acceptance-8)
// - 管线顺序:末次压缩 → 导出 JSON → 删库(含孤儿)→ wiki 留存。
// - JSON 落盘 `~/.zero-core/archives/<agentId>/<sessionId>.json`,plain JSON,
//   含 sessions 行 + steps + messages summary。
// - 归档后:DB 无该 session 的 sessions/steps/messages/tool_executions/
//   delegated_tasks 行;wiki 节点仍在。
//
// ## 定位
// src/server/ 服务层。被 `subagent-delegator.ts`(delegated 自动)+ session-router
// (chat 手动)调。复用 compression-core / extractor-a-service / session-db,不
// 旁路任何通路。
//
// ## 维护规则
// - 末次压缩必须走 compressSession(不要 bypass Extractor A 通路 —— wiki 抽取
//   由它独占,memory feedback-verify-runtime-wiring)。
// - 删库必须经 db.deleteSessionData(含孤儿清理);不要散在 archive-service 里
//   手写 DELETE。
// - 活跃 session 归档必须先 teardown runtime(chat 手动);teardown 顺序见
//   `runTeardown`。
// - 不加 restore 方法(单向归档)。

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ZERO_CORE_DIR } from "../core/config.js";
import { log } from "../core/logger.js";
import type { SessionDB, MessageSummary } from "./session-db.js";
import type { SessionRecord } from "../shared/types.js";
import type { RuntimeProviderConfig, SessionConfig } from "../runtime/types.js";
import { compressSession, type CompressSessionOptions } from "./compression-core.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 归档 JSON 的根形态(v1,plain JSON,可读)。 */
export interface ArchiveJson {
	/** 格式版本(v1 = plain JSON,无 gzip)。 */
	version: 1;
	/** 归档时刻(ISO)。 */
	archivedAt: string;
	/** 该 session 的 agentId(冗余,方便按 agent 浏览归档目录)。 */
	agentId: string;
	/** 该 session 的 id(= 文件名,冗余以便单文件自洽)。 */
	sessionId: string;
	/** `sessions` 行(完整自有记录)。 */
	session: SessionRecord;
	/** `steps` 全量(seq 升序)。 */
	steps: Array<{
		seq: number;
		turnGroup: number;
		role: string;
		content: string | null;
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		createdAt: string;
		attachments?: unknown[];
	}>;
	/** `messages` summary 全量(FIFO,oldest-first)。 */
	summaries: MessageSummary[];
	/** 压缩游标(`messages.last_compressed_step_seq`,NULL = 未压缩)。 */
	compressionCursor: number | null;
	/** 末次压缩是否跑过(诊断字段:false = 跳过/失败,JSON 仍落盘)。 */
	finalCompressionRan: boolean;
}

/**
 * Optional runtime-teardown hook. Injected by callers that may be archiving an
 * ACTIVE session (chat manual archive): tears down the session's AgentLoop +
 * clears the in-memory caches the loop's hooks hold. delegated auto-archive
 * leaves this undefined (the child AgentLoop has already returned by the time
 * the task hits completed/failed, so there's nothing live to tear down — see
 * `archiveSession` doc).
 */
export interface ArchiveRuntimeTeardown {
	/**
	 * Stop the session's AgentLoop (abort + drop from the loops map + clear
	 * activeSessions/runStates). Best-effort — MUST NOT throw (archive proceeds
	 * regardless; a stuck loop is not a reason to skip the export+delete).
	 */
	stopAgentLoop?: (sessionId: string) => void;
	/**
	 * Clear per-session in-memory hook state:
	 *   - turn-seq-tracker (turnStatePrecreated + sessionTurnSeq for this sid)
	 *   - compression-trigger-hooks (lastLLMCall / compressedThisTurn /
	 *     lastReductionFraction / inFlight for this sid)
	 * Best-effort — MUST NOT throw.
	 */
	clearHookState?: (sessionId: string) => void;
}

export interface ArchiveSessionOptions {
	/** Provider configs (for the final compression's LLM call). Required. */
	providers: RuntimeProviderConfig[];
	/**
	 * The session's runtime config — used to build the final compression's
	 * opts (model + Extractor A wiring). For delegated: the delegator's
	 * `this.config` (the sub-config, which inherited `wikiStore` via spread).
	 * For chat: rebuilt from the session record + agent record by the caller
	 * (mirror agent-service.buildSessionConfigForEviction).
	 */
	sessionConfig: SessionConfig;
	/**
	 * Active-session teardown (chat manual archive only). When present, run
	 * BEFORE the pipeline. delegated auto-archive leaves this undefined.
	 */
	teardown?: ArchiveRuntimeTeardown;
	/**
	 * Skip the final compression (e.g. test fixture / a session with no steps).
	 * Default false. When true, the pipeline goes straight to export + delete
	 * (the wiki keeps whatever prior compressions wrote).
	 */
	skipFinalCompression?: boolean;
}

export interface ArchiveResult {
	/** Path of the JSON file written (always set on success). */
	archivePath: string;
	/** Whether the final compression actually ran (false = skipped/failed). */
	finalCompressionRan: boolean;
	/** Number of steps exported in the JSON. */
	stepsExported: number;
	/** Number of summaries exported in the JSON. */
	summariesExported: number;
}

// ---------------------------------------------------------------------------
// Archive root directory
// ---------------------------------------------------------------------------

/** `~/.zero-core/archives/` — plain-JSON archive root (same root as wiki/). */
export const ARCHIVES_ROOT = join(ZERO_CORE_DIR, "archives");

/**
 * Per-archive path = `<archives>/<agentId>/<sessionId>.json`.
 *
 * `agentId` is sanitized to a single path segment (replace path separators +
 * NUL + leading dots) so a malicious / malformed agentId can't escape
 * `archives/`. The sessionId is left as-is (it's an opaque token the system
 * generated; if it ever contained a separator it would simply fail to
 * round-trip, not escape).
 */
export function archivePathFor(agentId: string, sessionId: string): string {
	const safeAgent = sanitizePathSegment(agentId);
	return join(ARCHIVES_ROOT, safeAgent, `${sessionId}.json`);
}

/** Strip characters that could break out of a single path segment. */
function sanitizePathSegment(seg: string): string {
	// Replace OS path separators (both flavors, in case of cross-platform data),
	// NUL, and leading dots (no `..` segments). Empty → "__default__".
	let s = seg.replace(/[\/\\]/g, "_").replace(/\0/g, "").replace(/^\.+/, "");
	if (!s) s = "__default__";
	return s;
}

// ---------------------------------------------------------------------------
// Final-compression opts builder
// ---------------------------------------------------------------------------

/**
 * Build `compressSession` opts for the final compression, mirroring
 * compression-trigger-hooks' `buildCompressOpts`: reuse the session's working
 * model + wire Extractor A (multi-step wiki-merge agent) when a wiki store is
 * reachable from the config.
 *
 * ExtractorAService is imported lazily (dynamic require) to avoid a static
 * server→runtime→server cycle at module-load (same rationale as the trigger
 * hook). The lazy require is wrapped in try/catch — a missing wiki store must
 * NOT block the archive (final compression is best-effort; the JSON export
 * proceeds regardless).
 */
async function buildFinalCompressOpts(
	sessionConfig: SessionConfig,
	providers: RuntimeProviderConfig[],
): Promise<CompressSessionOptions> {
	const ext = (sessionConfig as any)?.extractors?.A ?? {};
	const providerName = ext.provider ?? sessionConfig.providerName;
	const modelId = ext.model ?? sessionConfig.modelId;
	const opts: CompressSessionOptions = {
		providers,
		providerName,
		modelId,
	} as CompressSessionOptions;
	// getContextWindow mirrors the trigger hook's read; inline it here to keep
	// archive-service self-contained (the trigger hook is in runtime/, this is
	// in server/ — a cross-layer import for one helper isn't worth the cycle
	// risk).
	const contextWindow = getContextWindowFor(providers, providerName, modelId);
	(opts as any).contextWindow = contextWindow;

	// Extractor A wiring: only when a wiki store is reachable. The wiki store
	// rides on the config the SAME way the trigger hook reads it
	// (`(config as any).wikiStoreGlobal ?? config.wikiStore`) — sub-loops
	// inherit `wikiStore` via the spread in subagent-delegator.
	const wiki = (sessionConfig as any)?.wikiStoreGlobal ?? (sessionConfig as any)?.wikiStore;
	if (wiki) {
		try {
			// Dynamic import — server/extractor-a-service imports tools/wiki-tool
			// (which imports server/wiki-node-store). Keeping this dynamic avoids
			// pulling the whole server/ wiki stack at static load.
			const { ExtractorAService } = await import("./extractor-a-service.js");
			const agentId = sessionConfig.agentId;
			(opts as any).extractorA = {
				service: new ExtractorAService({ providers, providerName, modelId, wiki }),
				// Default topic = per-agent (one memory subtree per agent;
				// agentId is the stable cross-session handle). Mirrors the
				// trigger hook's resolveTopic so the final compression writes
				// into the SAME topic subtree as prior mid-turn compressions.
				resolveTopic: (_summary: unknown, _seg: unknown, _sid: string) => ({
					topicId: agentId ?? _sid,
					topicTitle: agentId ? `Memory: ${agentId}` : undefined,
					agentId,
				}),
			};
		} catch (err) {
			log.warn(
				"archive",
				`failed to wire Extractor A for final compression (wiki merge disabled):`,
				(err as Error).message,
			);
		}
	}
	return opts;
}

/**
 * Resolve the context window for a provider/model (mirrors
 * runtime/provider-factory.getContextWindow's read shape). Falls back to the
 * default when the provider/model isn't found or reports no window.
 */
function getContextWindowFor(
	providers: RuntimeProviderConfig[],
	providerName: string,
	modelId: string,
): number {
	const match = providers.find(
		(p) => p.name === providerName || p.name.toLowerCase() === providerName.toLowerCase(),
	);
	if (!match) return 128000;
	const model = (match as any).models?.find(
		(m: any) => m.id === modelId || m.name === modelId,
	);
	const w = model?.contextWindow ?? (match as any).contextWindow;
	return typeof w === "number" && w > 0 ? w : 128000;
}

// ---------------------------------------------------------------------------
// Archive pipeline
// ---------------------------------------------------------------------------

/**
 * Run the archive pipeline for one session:
 *   ① (optional) final Extractor A compression — flush residual step memory
 *      into wiki.
 *   ② export the session's own data to a plain-JSON file.
 *   ③ hard-delete the session's rows (sessions/steps/messages +
 *      tool_executions/delegated_tasks orphans). Wiki nodes are LEFT.
 *
 * For an ACTIVE session (chat manual archive), pass `opts.teardown` — it runs
 * BEFORE the pipeline to stop the AgentLoop + clear in-memory hook state.
 * delegated auto-archive leaves `teardown` undefined (the child AgentLoop has
 * already returned by the time the task hits completed/failed).
 *
 * NEVER throws on the compression/export best-effort halves — only on
 * irrecoverable IO (archive dir creation / JSON write) or DB delete failure.
 * A failed final compression is logged + the JSON still exports with
 * `finalCompressionRan: false`.
 */
export async function archiveSession(
	sessionId: string,
	db: SessionDB,
	opts: ArchiveSessionOptions,
): Promise<ArchiveResult> {
	// ── Active-session teardown (chat manual archive) ──────────────────────
	// Runs BEFORE anything else so the loop stops writing to the DB / firing
	// hooks mid-archive. Best-effort: a teardown failure is logged but does NOT
	// abort (the export+delete still proceeds — a stuck loop is worse than a
	// clean archive of the last consistent state).
	if (opts.teardown) {
		runTeardown(opts.teardown, sessionId);
	}

	const sessionRow = db.getSession(sessionId);
	const agentId = opts.sessionConfig.agentId ?? sessionRow?.agentId ?? "__default__";

	// ── ① Final Extractor A compression (best-effort) ──────────────────────
	let finalCompressionRan = false;
	if (!opts.skipFinalCompression) {
		try {
			const result = await compressSession(
				sessionId,
				db,
				await buildFinalCompressOpts(opts.sessionConfig, opts.providers),
			);
			finalCompressionRan = result.summaries.length > 0;
			log.debug(
				"archive",
				`session=${sessionId} final compression: ${result.summaries.length} summary(ies)` +
					(result.skippedReason ? ` [${result.skippedReason}]` : "") +
					(finalCompressionRan ? "" : " (no residual steps compressed — ok)"),
			);
		} catch (err) {
			// Final compression is best-effort: a failure here MUST NOT block
			// the export+delete. Log + continue with finalCompressionRan=false.
			log.warn(
				"archive",
				`final compression failed (session=${sessionId}); proceeding to export+delete:`,
				(err as Error).message,
			);
		}
	}

	// ── ② Export JSON (the session's own data) ─────────────────────────────
	const archivePath = archivePathFor(agentId, sessionId);
	const payload = buildArchivePayload(sessionId, agentId, db, sessionRow, finalCompressionRan);
	writeArchiveJson(archivePath, payload);

	// ── ③ Delete the session's DB rows (incl. orphans); wiki stays ─────────
	db.deleteSessionData(sessionId);

	log.agent(
		"Archive: session",
		sessionId,
		"→",
		archivePath,
		`(steps=${payload.steps.length}, summaries=${payload.summaries.length}` +
			`, finalCompress=${finalCompressionRan ? "ran" : "skipped"})`,
	);

	return {
		archivePath,
		finalCompressionRan,
		stepsExported: payload.steps.length,
		summariesExported: payload.summaries.length,
	};
}

/**
 * Read the session's own data into the ArchiveJson payload. Reads happen BEFORE
 * the delete so the export reflects the post-final-compression state (the final
 * compression may have just written new summaries + advanced the cursor).
 *
 * `sessionRow` is passed in (read once before the final compression) so the
 * payload records the session as it was at archive time; if the row is missing
 * (idempotent re-archive), a minimal placeholder is emitted so the JSON file
 * still self-describes the attempt.
 */
function buildArchivePayload(
	sessionId: string,
	agentId: string,
	db: SessionDB,
	sessionRow: SessionRecord | undefined,
	finalCompressionRan: boolean,
): ArchiveJson {
	if (!sessionRow) {
		// Defensive: the caller should have validated existence. If the row is
		// already gone (idempotent re-archive), emit a minimal payload rather
		// than throw — the delete below is a no-op and the JSON at least records
		// that an archive was attempted.
		log.warn("archive", `buildArchivePayload: session row missing for ${sessionId} (already archived?)`);
	}
	const steps = db.getSteps(sessionId);
	const summaries = db.getSummaries(sessionId);
	const compressionCursor = db.getCompressionCursor(sessionId);
	return {
		version: 1,
		archivedAt: new Date().toISOString(),
		agentId,
		sessionId,
		session: sessionRow ?? ({
			id: sessionId,
			agentId,
			isMain: false,
			title: null,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		} as SessionRecord),
		steps: steps.map((s) => ({
			seq: s.seq,
			turnGroup: s.turnGroup,
			role: s.role,
			content: s.content,
			inputTokens: s.inputTokens,
			outputTokens: s.outputTokens,
			totalTokens: s.totalTokens,
			createdAt: s.createdAt,
			attachments: s.attachments,
		})),
		summaries,
		compressionCursor,
		finalCompressionRan,
	};
}

/**
 * Write the archive JSON to disk. Creates the per-agent dir if missing. Throws
 * on IO failure (an unwritable archive root is irrecoverable — better to fail
 * the archive loud than silently lose the export and then delete the DB rows).
 */
function writeArchiveJson(archivePath: string, payload: ArchiveJson): void {
	const dir = join(archivePath, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	// plain JSON, 2-space indent (human-readable; v1 — gzip later if size bites).
	writeFileSync(archivePath, JSON.stringify(payload, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Active-session teardown (chat manual archive)
// ---------------------------------------------------------------------------

/**
 * Run the active-session teardown: stop the AgentLoop + clear in-memory hook
 * state. Best-effort — each step is wrapped so a failure in one doesn't skip
 * the rest. NEVER throws (the archive proceeds regardless).
 *
 * The teardown steps:
 *   1. stopAgentLoop — abort the loop + drop it from the loops map + clear
 *      activeSessions/runStates (injected by the caller, who owns the loops
 *      map; usually agent-service.evictSessionFromMemory).
 *   2. clearHookState — clear the per-session in-memory state the loop's hooks
 *      hold:
 *        - turn-seq-tracker: turnStatePrecreated + sessionTurnSeq for this sid
 *        - compression-trigger-hooks: lastLLMCall / compressedThisTurn /
 *          lastReductionFraction / inFlight for this sid
 *
 * Order matters: stop the loop FIRST (so it stops firing hooks / writing to
 * the DB mid-clear), THEN clear the hook state.
 */
function runTeardown(teardown: ArchiveRuntimeTeardown, sessionId: string): void {
	if (teardown.stopAgentLoop) {
		try {
			teardown.stopAgentLoop(sessionId);
		} catch (err) {
			log.warn("archive", `teardown.stopAgentLoop failed (session=${sessionId}):`, (err as Error).message);
		}
	}
	if (teardown.clearHookState) {
		try {
			teardown.clearHookState(sessionId);
		} catch (err) {
			log.warn("archive", `teardown.clearHookState failed (session=${sessionId}):`, (err as Error).message);
		}
	}
}
