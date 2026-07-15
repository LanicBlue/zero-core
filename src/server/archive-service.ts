// 归档管线服务 (steps-overhaul sub-8 → compression-archive-simplify sub-4)
//
// # 文件说明书
//
// ## 核心功能(compression-archive-simplify sub-4 重写)
//
// 单向归档 = **Q5b memory ephemeral turn(可选)→ mark(archived=1,瞬态崩溃
// 检查点)→ 原子 export(JSON tmp+parse+rename+删行)→ wiki 留存**。任一触发
// 都走这套(`archiveSession`)。所有步骤都串在一把 per-session 锁下,防
// "手动 + 自动"并发归档同一 session 的竞态(acceptance-4 #8)。
//
// ① **memory ephemeral turn(可选)**:Q5b —— session 自然结束(子 agent
//    task-finish / 手动归档)前,跑一轮 `persist:false` turn 让 agent 自写
//    wiki 记忆(design.md「三、归档流程」)。step 不落盘,只 wiki 副作用
//    存活(sub-2 acceptance #1)。由 caller 注入 `memoryTurnRunner` 闭包:
//    - 手动归档(chat 活跃 session):在活跃 AgentLoop 上 `run(prompt,
//      {ephemeral:true})`。
//    - 子 agent termination(已 return,loop 没了):caller 重建 temp loop
//      → 跑 ephemeral turn → dispose。
//    - 已压缩过的长 session(compression memory turn 已写过 wiki)→ caller
//      skip(GAP2);只 export。
//    - 启动恢复扫描(只重 export,不再跑 memory turn)→ caller 不传 runner。
//
// ② **mark(archived=1,瞬态)**:O3 —— 复用现有 `archived` 列作瞬态崩溃
//    检查点。mark→export+delete 之间崩 → 重启扫 `listArchivedTransientSessions`
//    重 export(design.md「五、保险」)。**不 emit sidebar update**:行马上
//    就被 delete,emit 会闪一帧"已归档"再消失;crash 后由恢复扫描兜底。
//
// ③ **原子 export**:`<id>.json.tmp` → JSON.parse 校验 → `rename(tmp,final)`
//    → 才 `db.deleteSessionData(sessionId)`。任一步失败(tmp 写失败 / parse
//    不过 / rename 失败)→ **不删行**;DB 行仍在,可重试(acceptance-4 #2)。
//    export 无 LLM(纯读 + 写),廉价(design.md:「Archive = (I) export+delete
//    即时原子」)。
//
// ④ **删库**:`db.deleteSessionData(sessionId)` —— 删 `sessions`/`steps`/
//    `messages` 行 + `tool_executions`/`delegated_tasks` 孤儿(全 WHERE
//    session_id)。Wiki 节点不删(跨 session 留存 —— 归档只删 session 自有
//    内容,记忆节点留存)。
//
// ## 砍 final compression(D4)+ 拆 archive-wiki-merge 耦合(Q5b 替代)
// - 归档不再跑末次压缩(D4:design.md 明确"归档也压缩"作废);sub-3b 留下的
//   末次压缩 opts builder + provider/model 解析 + 上下文窗口读取全部删
//   (acceptance-4 #7:归档路径不调压缩入口)。
// - archive-service 的 wiki-merge 调用早已在 sub-3b 拆除(Q5b memory turn
//   替代);本 sub 进一步把"末次压缩假需求"和耦合注释残留一并清掉
//   (acceptance-4 #6:archive-service 内不再出现该外部 extractor 名)。
//
// ## 触发(sub-8 沿用)
// - **delegated(子 agent)完成**:`subagent-delegator.ts` 任务 `completed/
//   failed` → `fireOnTaskTerminal` → agent-service.archiveDelegatedSession →
//   本服务。子 agent 跑完即沉,天然完成态;若从没压缩过,caller 重建 temp
//   loop 跑 memory turn(GAP2)。
// - **chat(前台)手动**:走现有 chat UI 归档按钮 → session-router → 本服务。
//   若该 session 仍活跃(还在跑 AgentLoop),先在活跃 loop 跑 memory turn,
//   再 teardown(停 loop / 注销 handle / 清 in-memory 状态:turn-seq-tracker、
//   compression-trigger-hooks 的 lastLLMCall/compressedThisTurn/防抖 Map 该
//   session 条目),再走管线。
// - **cron/main(父 agent)不自动归档**(design.md:父 agent 持久,用户保留)。
//
// ## 可恢复(sub-4 新)
// 启动 `recoverInterruptedArchives(db)` 扫 `archived=1 且仍有行` 的 session,
// 重 export + 删行。memory turn 已在崩溃前跑过(mark 在 memory turn 之后);
// recovery 只重 export(acceptance-4 #3)。
//
// ## per-session 锁(sub-4 新)
// `withArchiveLock(sessionId, fn)`:模块级 Map<sessionId, {owner, acquiredAt}>。
// 原子 acquire:TTL 30s 过期自动恢复(进程崩溃兜底,hermes 式)。同 session
// 并发 archive(手动 + 自动)→ 第二个 caller 等不到锁就 skip + log,不
// double-archive(acceptance-4 #8)。
//
// ## 不做归档恢复(deferred)
// archive JSON 只留档,restore 通路(IPC 读 JSON 重建 session 行)+ archives
// 轮转/上限 = **optional,本 sub 留接口未实现**(acceptance-4 #11 标注)。
// 见 sub-4.md「Deferred」段。
//
// ## 定位
// src/server/ 服务层。被 `subagent-delegator.ts`(delegated 自动)+ session-router
// (chat 手动)+ index.ts(启动 recovery)调。复用 session-db,不旁路任何通路。

import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ZERO_CORE_DIR } from "../core/config.js";
import { log } from "../core/logger.js";
import type { SessionDB, MessageSummary } from "./session-db.js";
import type { SessionRecord } from "../shared/types.js";

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
	/**
	 * sub-4: archive 前是否跑过 Q5b memory ephemeral turn。true = 跑过;
	 * false = 跳过(已压缩过的长 session / recovery scan 重 export /
	 * memoryTurnRunner 未注入)。替换 sub-3b 的 finalCompressionRan。
	 */
	memoryTurnRan: boolean;
}

/**
 * Optional runtime-teardown hook. Injected by callers that may be archiving an
 * ACTIVE session (chat manual archive): tears down the session's AgentLoop +
 * clears the in-memory caches the loop's hooks hold. delegated auto-archive
 * leaves this undefined (the child AgentLoop has already returned by the time
 * the task hits completed/failed — but see `memoryTurnRunner`, which may have
 * built a temp loop and disposed it already).
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
	/**
	 * sub-4 Q5b: runner that executes ONE memory ephemeral turn (sub-2
	 * `persist:false`) on the session being archived, so the agent self-writes
	 * its wiki memory before the JSON export. The runner owns ALL loop
	 * orchestration:
	 *   - chat manual archive: run on the EXISTING active loop (still alive
	 *     pre-teardown) via `loop.run(prompt, {ephemeral:true})`.
	 *   - delegated child (loop already returned): caller builds a TEMP loop,
	 *     runs the ephemeral turn, disposes it, then returns.
	 *   - already-compressed long session: caller returns `false` (skip — the
	 *     compression memory turn already wrote wiki; GAP2).
	 * Returns true if the turn ran, false if skipped. Best-effort: a throw is
	 * logged + treated as `false` (the export proceeds — wiki may simply have
	 * fewer entries). When omitted (e.g. startup recovery scan), the archive
	 * skips straight to export.
	 */
	memoryTurnRunner?: () => Promise<boolean>;
	/**
	 * Active-session teardown (chat manual archive only). Runs AFTER the
	 * memory turn (so the loop is stopped only after its wiki writes land),
	 * BEFORE the mark + atomic export.
	 */
	teardown?: ArchiveRuntimeTeardown;
}

export interface ArchiveResult {
	/** Path of the JSON file written (always set on success). */
	archivePath: string;
	/** Whether the Q5b memory ephemeral turn ran (false = skipped/failed). */
	memoryTurnRan: boolean;
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
// per-session DB lock (atomic acquire + TTL recovery)
// ---------------------------------------------------------------------------

/**
 * Lock TTL (ms). A process crash between acquire + release leaves the lock
 * stranded; we recover by treating any entry older than this as expired
 * (hermes-style). 30s is generous for a memory turn + JSON write + DB delete
 * (real timings are seconds; the TTL is a crash backstop, not a normal
 * timeout).
 */
const ARCHIVE_LOCK_TTL_MS = 30_000;

interface ArchiveLockEntry {
	/** Wall-clock ms when the lock was acquired (Date.now()). */
	acquiredAt: number;
}

/**
 * Module-level lock map. Keyed by sessionId so two concurrent archives of
 * DIFFERENT sessions don't contend (only same-session concurrency does, which
 * is exactly the case acceptance-4 #8 covers — manual + auto on the same sid).
 *
 * Single Node process assumption: this Map is in-memory, not cross-process.
 * The TTL handles within-process crashes (an async throw that escapes the
 * caller without releasing). Cross-process crashes (kill -9) leave the entry
 * stranded until the process exits; that's fine because the process is gone
 * and nothing is contending anymore. The startup recovery scan handles the
 * "mark archived=1 then crash" data-state.
 */
const archiveLocks = new Map<string, ArchiveLockEntry>();

/**
 * sub-4 acceptance #8: acquire the per-session archive lock, run `fn`, release.
 * If the lock is held by another caller AND hasn't expired, return
 * `already-archiving` (the caller logs + skips — best-effort: the holder will
 * finish the archive; double-archiving would produce duplicate JSON + a
 * double-delete race, which is exactly what we're avoiding).
 *
 * On expiry (entry older than TTL), the lock is stolen: the prior holder is
 * assumed to have crashed mid-archive, and we take over. The mark+atomic-
 * export+delete is idempotent enough that a re-run after a crash is safe
 * (mark ArchivedTransient is a no-op if already 1; export overwrites the JSON;
 * delete is a no-op if the row is gone).
 *
 * Release is in a `finally` so an async throw inside `fn` doesn't strand the
 * lock. `fn` is expected to be the full archive pipeline (memory turn → mark
 * → export → delete).
 */
async function withArchiveLock<T>(
	sessionId: string,
	fn: () => Promise<T>,
): Promise<{ result: T } | { skipped: "already-archiving" }> {
	const now = Date.now();
	const existing = archiveLocks.get(sessionId);
	if (existing) {
		const age = now - existing.acquiredAt;
		if (age < ARCHIVE_LOCK_TTL_MS) {
			return { skipped: "already-archiving" };
		}
		// Expired — steal. Log loudly because this means a prior archive
		// exceeded the TTL (or crashed); the steal is correct but the prior
		// holder's state deserves a look.
		log.warn("archive",
			`archive lock for session=${sessionId} expired (age=${age}ms > TTL=${ARCHIVE_LOCK_TTL_MS}ms); stealing`);
	}
	archiveLocks.set(sessionId, { acquiredAt: now });
	try {
		const result = await fn();
		return { result };
	} finally {
		// Only delete if WE still own it. If a steal happened mid-flight (we
		// took >TTL and another caller stole), the new owner's entry is the
		// one to keep — our delete would clobber theirs. Compare acquire time.
		const current = archiveLocks.get(sessionId);
		if (current && current.acquiredAt === now) {
			archiveLocks.delete(sessionId);
		}
	}
}

// ---------------------------------------------------------------------------
// Archive pipeline
// ---------------------------------------------------------------------------

/**
 * Run the archive pipeline for one session (compression-archive-simplify
 * sub-4):
 *   ① acquire per-session lock (concurrent same-session archive → skip).
 *   ② (optional) Q5b memory ephemeral turn — agent self-writes wiki.
 *   ③ (active session only) teardown — stop loop + clear hook state.
 *   ④ mark `archived=1` (transient crash checkpoint).
 *   ⑤ atomic export: write `<id>.json.tmp` → JSON.parse-validate → rename →
 *      only then `deleteSessionData`. Any step failing → row stays (retryable).
 *
 * Atomicity (acceptance-4 #2): the export + delete is crash-safe. A failure
 * in tmp-write / parse / rename logs + returns WITHOUT deleting the row;
 * the startup recovery scan re-runs the export. The only irrecoverable
 * failure is the DB delete itself (which is a single SQLite transaction).
 *
 * Locking (acceptance-4 #8): per-session lock guards the whole pipeline.
 * Manual + auto on the same sid: the second caller hits `skipped` and
 * returns; the holder finishes the archive.
 *
 * NEVER throws on the memory-turn / teardown best-effort halves — only on
 * irrecoverable IO (tmp write / rename) or DB delete failure. A failed
 * memory turn is logged + the JSON still exports with `memoryTurnRan: false`.
 */
export async function archiveSession(
	sessionId: string,
	db: SessionDB,
	opts: ArchiveSessionOptions,
): Promise<ArchiveResult> {
	const lockOutcome = await withArchiveLock(sessionId, () =>
		runArchivePipeline(sessionId, db, opts),
	);
	if ("skipped" in lockOutcome) {
		// Another caller is already archiving this session. Return a benign
		// result reflecting "nothing exported by THIS call" — the holder's
		// archive covers it. acceptance-4 #8.
		log.warn("archive",
			`session=${sessionId} archive skipped: another caller holds the lock (will finish)`);
		return {
			archivePath: "",
			memoryTurnRan: false,
			stepsExported: 0,
			summariesExported: 0,
		};
	}
	return lockOutcome.result;
}

/**
 * Inner pipeline (runs under the lock). Broken out so the lock wrapper stays
 * generic. See `archiveSession` for the contract.
 */
async function runArchivePipeline(
	sessionId: string,
	db: SessionDB,
	opts: ArchiveSessionOptions,
): Promise<ArchiveResult> {
	const sessionRow = db.getSession(sessionId);
	const agentId = sessionRow?.agentId ?? "__default__";

	// ── ① Q5b memory ephemeral turn (best-effort) ─────────────────────────
	// Runs BEFORE teardown so the active loop can still write wiki (chat
	// manual archive). For delegated children the caller's runner builds a
	// temp loop. Skipped when runner omitted (recovery) or returns false
	// (already compressed / no steps).
	let memoryTurnRan = false;
	if (opts.memoryTurnRunner) {
		try {
			memoryTurnRan = (await opts.memoryTurnRunner()) === true;
			log.debug("archive",
				`session=${sessionId} Q5b memory ephemeral turn: ${memoryTurnRan ? "ran" : "skipped"}`);
		} catch (err) {
			// Best-effort: a failure here MUST NOT block the export+delete.
			// Log + continue with memoryTurnRan=false.
			log.warn("archive",
				`Q5b memory turn failed (session=${sessionId}); proceeding to mark+export+delete:`,
				(err as Error).message);
		}
	}

	// ── ② Active-session teardown (chat manual archive) ───────────────────
	// Runs AFTER the memory turn (so the loop's wiki writes land) and BEFORE
	// the mark + export (so the loop stops writing to the DB / firing hooks
	// mid-export). Best-effort: a teardown failure is logged but does NOT
	// abort (the export+delete still proceeds — a stuck loop is worse than a
	// clean archive of the last consistent state).
	if (opts.teardown) {
		runTeardown(opts.teardown, sessionId);
	}

	// ── ③ mark archived=1 (transient crash checkpoint) ────────────────────
	// If we crash between here and the delete, the startup recovery scan
	// finds the row (still exists, archived=1) and re-runs the export. No
	// emit: the row is about to be deleted (which emits the canonical delete).
	db.markArchivedTransient(sessionId);

	// ── ④ Atomic export: tmp → validate → rename → delete row ─────────────
	// Re-read the session row AFTER the memory turn + teardown: the row may
	// have been mutated (teardown updates usage / the memory turn wrote
	// nothing to DB since steps are ephemeral, but sessionRow.updated_at may
	// have moved). Build the payload from the post-teardown state.
	const finalRow = db.getSession(sessionId) ?? sessionRow;
	const archivePath = archivePathFor(agentId, sessionId);
	const payload = buildArchivePayload(sessionId, agentId, db, finalRow, memoryTurnRan);
	writeArchiveJsonAtomic(archivePath, payload);

	// ── ⑤ Delete the session's DB rows (incl. orphans); wiki stays ─────────
	// Only reached if the atomic export succeeded. deleteSessionData is a
	// single SQLite transaction (sessions/steps/messages/tool_executions/
	// delegated_tasks WHERE session_id) — atomic by construction.
	db.deleteSessionData(sessionId);

	log.agent(
		"Archive: session",
		sessionId,
		"→",
		archivePath,
		`(steps=${payload.steps.length}, summaries=${payload.summaries.length}` +
			`, memoryTurn=${memoryTurnRan ? "ran" : "skipped"})`,
	);

	return {
		archivePath,
		memoryTurnRan,
		stepsExported: payload.steps.length,
		summariesExported: payload.summaries.length,
	};
}

/**
 * Read the session's own data into the ArchiveJson payload. Reads happen AFTER
 * the memory turn + teardown (so the export reflects the final state).
 *
 * `sessionRow` is passed in (read fresh AFTER teardown in the pipeline). If
 * the row is missing (idempotent re-archive / race with another caller), a
 * minimal placeholder is emitted so the JSON file still self-describes the
 * attempt.
 */
function buildArchivePayload(
	sessionId: string,
	agentId: string,
	db: SessionDB,
	sessionRow: SessionRecord | undefined,
	memoryTurnRan: boolean,
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
		memoryTurnRan,
	};
}

/**
 * Atomic export (sub-4 acceptance #2):
 *   1. write `<archivePath>.tmp` (plain JSON, 2-space indent).
 *   2. read it back + JSON.parse-validate (catches disk-write corruption +
 *      encoding issues — design.md「export 边界」: large session export is
 *      IO-bound, not LLM-bound; validation is cheap).
 *   3. `rename(tmp, final)` — atomic on POSIX, atomic-replace on Windows
 *      (both `fs.renameSync` flavors either fully succeed or leave the prior
 *      file intact).
 *
 * Throws (does NOT delete the row) on any failure. The caller wraps this so
 * a throw leaves the DB row intact + retryable.
 *
 * The `.tmp` file is removed on a parse-failure so a retry doesn't see a
 * stale tmp (rename would then move the corrupt file in). On rename failure
 * the tmp is left in place for diagnosis.
 */
function writeArchiveJsonAtomic(archivePath: string, payload: ArchiveJson): void {
	const dir = join(archivePath, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const tmpPath = `${archivePath}.tmp`;
	// Step 1 — write tmp.
	try {
		// plain JSON, 2-space indent (human-readable; v1 — gzip later if size bites).
		writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
	} catch (err) {
		// tmp write failure = irrecoverable IO (disk full / permission). Do
		// NOT delete the row — let the next retry attempt it.
		const msg = (err as Error).message;
		throw new Error(`archive tmp write failed (${tmpPath}): ${msg}`);
	}
	// Step 2 — parse-validate (catches serialization corruption).
	try {
		const written = readFileSync(tmpPath, "utf8");
		JSON.parse(written);
	} catch (err) {
		// Remove the corrupt tmp so the next retry starts clean.
		try { unlinkSync(tmpPath); } catch { /* best-effort */ }
		const msg = (err as Error).message;
		throw new Error(`archive tmp JSON validation failed (${tmpPath}): ${msg}`);
	}
	// Step 3 — atomic rename to final.
	try {
		renameSync(tmpPath, archivePath);
	} catch (err) {
		// Leave the tmp in place for diagnosis (do NOT unlink — rename may
		// have partially succeeded on some platforms).
		const msg = (err as Error).message;
		throw new Error(`archive rename failed (${tmpPath} → ${archivePath}): ${msg}`);
	}
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

// ---------------------------------------------------------------------------
// Startup recovery scan
// ---------------------------------------------------------------------------

/**
 * sub-4 acceptance #3: scan for sessions left in the transient `archived=1`
 * state by a crash between `markArchivedTransient` and `deleteSessionData`.
 * For each, re-run the atomic export (memory turn already ran pre-crash —
 * the mark is set AFTER the memory turn) and delete the row.
 *
 * Idempotent + best-effort: a re-export failure (e.g. unreadable row) is
 * logged + skipped; the row stays for the next startup to retry. Returns
 * the count of sessions successfully re-archived.
 *
 * Called once at server startup (index.ts), after migrations + stores are
 * ready. Doesn't accept a memoryTurnRunner — recovery assumes the pre-crash
 * memory turn's wiki writes survived (wiki is cross-session + durable).
 */
export async function recoverInterruptedArchives(db: SessionDB): Promise<number> {
	const stranded = db.listArchivedTransientSessions();
	if (stranded.length === 0) return 0;
	log.warn("archive",
		`recovery scan: ${stranded.length} session(s) stranded in archived=1 state; re-exporting`);
	let recovered = 0;
	for (const row of stranded) {
		try {
			// No memoryTurnRunner — the pre-crash turn already wrote wiki
			// (the mark is set AFTER the turn). No teardown — the loop is
			// long gone (process restarted). Just re-export + delete.
			await archiveSession(row.id, db, {});
			recovered++;
		} catch (err) {
			log.warn("archive",
				`recovery scan: re-export failed (session=${row.id}); leaving stranded for next retry:`,
				(err as Error).message);
		}
	}
	log.warn("archive", `recovery scan: ${recovered}/${stranded.length} re-archived`);
	return recovered;
}

// ---------------------------------------------------------------------------
// Startup orphan sweep (archive-no-residual sub-4 / D5)
// ---------------------------------------------------------------------------

/**
 * sub-4 D5: best-effort sweep for "存量" orphan sessions accumulated BEFORE
 * the sub-1/2/3 pipeline fix. An orphan is a session whose
 * `delegated_tasks` row was hand-cleaned (so it's no longer parent-linked
 * in the DB) but whose `sessions` / `steps` / `messages` rows still exist
 * with `archived = 0` and `is_main = 0`. `recoverInterruptedArchives`
 * (above) only scans `archived = 1`, so these slip past it. After sub-1/2/3
 * no NEW orphans accumulate; this sweep is the one-time cleanup of the
 *存量 backlog.
 *
 * Heuristic (imprecise by design): non-main + non-archived + older than
 * `maxAgeDays` (default 14). False positives mitigated by:
 *   ① 14-day default cutoff (conservative — only long-stale rows match);
 *   ② export-before-delete — the JSON lands on disk before the row goes,
 *     so a misjudged sweep is reversible by reading the archive file;
 *   ③ `activeSessionIds` exclusion — any session currently in use by an
 *     agent is protected (caller injects; if absent, an empty Set is safe
 *     given the 14-day threshold).
 *
 * Per-row best-effort: a failure (unreadable row / IO error) is logged +
 * skipped; the row stays for the next sweep. Returns the count of sessions
 * swept (exported + deleted).
 *
 * Called once at server startup (index.ts), AFTER `recoverInterruptedArchives`
 * (so the `archived = 1` rows are cleaned first). Fire-and-forget.
 */
export async function sweepOrphanSessions(
	db: SessionDB,
	opts?: { maxAgeDays?: number; activeSessionIds?: Set<string> },
): Promise<number> {
	const maxAgeDays = opts?.maxAgeDays ?? 14;
	const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
	const excludeIds = opts?.activeSessionIds ?? new Set<string>();
	const candidates = db.listOrphanCandidateSessions({ olderThan: cutoff, excludeIds });
	if (candidates.length === 0) return 0;
	log.warn("archive",
		`orphan sweep: ${candidates.length} candidate(s) older than ${maxAgeDays}d (cutoff=${cutoff}); exporting + deleting`);
	let swept = 0;
	for (const row of candidates) {
		try {
			// Export-before-delete (防误判丢数据). Reuse the same payload
			// builder + atomic writer as the canonical archive pipeline so the
			// on-disk format is identical to a normal archive.
			//
			// memoryTurnRan=false: no temp loop is spun up for存量 cleanup —
			// the agent's wiki writes happened (or didn't) long ago; the JSON
			// captures whatever is in the DB at rest, which is the same
			// contract as the recovery scan.
			const sessionRow = db.getSession(row.id) ?? row;
			const agentId = sessionRow.agentId ?? "__default__";
			const payload = buildArchivePayload(row.id, agentId, db, sessionRow, false);
			const archivePath = archivePathFor(agentId, row.id);
			writeArchiveJsonAtomic(archivePath, payload);
			db.deleteSessionData(row.id);
			swept++;
			log.debug("archive",
				`orphan sweep: session=${row.id} (agent=${agentId}) → ${archivePath} (steps=${payload.steps.length})`);
		} catch (err) {
			// Best-effort: log + skip. Row stays for the next sweep attempt.
			log.warn("archive",
				`orphan sweep: session=${row.id} failed, skipped:`,
				(err as Error)?.message ?? err);
		}
	}
	log.warn("archive", `orphan sweep: ${swept}/${candidates.length} swept`);
	return swept;
}
