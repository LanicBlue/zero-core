// Compression trigger hooks (steps-overhaul sub-5).
//
// # File spec
//
// ## Core
// Wires the stage-3 compressSession core (server/compression-core.ts) to its
// triggers. Four trigger seams, all hook-registered (memory
// feedback-agent-loop-hooks-only — NO inline logic in agent-loop):
//
//   ① cache 冷热判定 (in-memory, per-session): a session is COLD when
//      (now − lastLLMCall) > cacheTTL, where cacheTTL = Provider.cacheTtlMs ??
//      DEFAULT_CACHE_TTL_MS. lastLLMCall lives ONLY in this module's Map
//      (never persisted) — first call / restart / post-compression are all
//      cold by construction (memory feedback: 重启必冷).
//
//   ② StepEnd cold path (可 mid-turn): on every StepEnd, evaluate cache 冷热
//      against the state captured BEFORE this step's LLM call. Cold + (token
//      >100K OR >50% window) → run compressSession (stage 3). This catches
//      mid-turn cache expiry (slow tool / long Wait aged the cache past TTL).
//      Per-turn "already compressed" guard prevents re-compressing the same
//      turn repeatedly.
//
//   ③ PreLLMCall (新 turn + resume 冷 preflight): single seam covering both
//      "WAIT/resume woke into a cold cache" (design: WAIT folded into resume —
//      no separate WAIT trigger) and "new turn". On every PreLLMCall, evaluate
//      cold/heat BEFORE marking this call:
//        - cold + (token >100K OR >50%) → 强制压缩 (preflight: compress first,
//          then let the call proceed). Covers resume-first-call / crash-recovery
//          / cold new turn.
//        - hot + new turn (stepNumber === 1) + (token >400K OR >90%) → 强制压缩
//          (hard limit; mid-turn+hot is NOT compressed here).
//        - hot + new turn + (token >200K OR >70%) → inject 提醒 (appendMessages;
//          LLM self-decides). mid-turn+hot 不打断.
//        - hot + mid-turn → no-op.
//      After evaluation, stamp lastLLMCall = now (this call is happening).
//
//   ④ OnLLMError reactive: prompt_too_long → 强制压缩 + allow retry. The
//      error-context already carries errorClass; we request retry and compress
//      before the retry attempt runs.
//
// ## New turn vs mid-turn 判据
// PreLLMCall ctx carries `stepNumber` (1-based within the turn).
// stepNumber === 1 ⇒ first LLM call of a turn ⇒ "new turn" (covers both
// run() and resume() — resume's first step is also stepNumber 1). This is the
// honest "turn boundary" seam because TurnStart fires BEFORE the loop resets
// its step counter, while PreLLMCall step 1 is the actual first model call.
//
// ## Fresh tail protection
// Triggers NEVER compress directly — they always go through compressSession,
// which carries its own computeFreshTailStartSeq boundary. No bypass path
// touches fresh tail (acceptance-5 invariant).
//
// ## 防抖 (debounce)
// If two consecutive compressions reduce token count by <10%, stop compressing
// for the rest of the turn (the summaries are no longer paying for themselves).
// Per-turn reset at TurnStart.
//
// ## Token 判定
// Reads sessions.token_usage (last API usage snapshot, set by THIS module's
// StepEnd handler from ctx.usage) via SessionDB.getTokenUsage. Window size from
// getContextWindow(providers, providerName, modelId). NOT recomputed.
//
// ## Invariants (acceptance-5)
// - 冷才跑完整压缩 (free); 热只提醒 / 到 hard 才强压.
// - mid-turn + 热 不打断.
// - fresh tail 永不被压 (core owns the boundary; triggers route through it).
// - cacheTTL per-provider default 6min; lastLLMCall in-memory only.
// - WAIT/resume 折叠成 PreLLMCall 冷 preflight, no separate WAIT trigger.
//
// ## Position
// src/runtime/hooks/ — registered for every loop kind that owns a SessionDB
// (main + delegated). Registered by hooks/index.ts registerHooksForLoop.
//
// ## Dependencies
// - core/hook-registry (HookRegistry)
// - core/hook-types (StepEnd / PreLLMCall / OnLLMError / TurnStart ctx)
// - server/compression-core (compressSession)
// - server/session-db (SessionDB: getTokenUsage / getCompressionCursor)
// - runtime/types (SessionConfig / RuntimeProviderConfig)
// - runtime/provider-factory (getContextWindow)
// - core/constants (DEFAULT_CACHE_TTL_MS)
// - core/logger
//
// ## Maintenance rules
// - Threshold changes must sync design.md「阈值」.
// - NEVER add a bypass that compresses without going through compressSession
//   (fresh-tail protection lives there).

import { HookRegistry } from "../../core/hook-registry.js";
import type { HookEventName } from "../../core/hook-types.js";
import type { SessionConfig, RuntimeProviderConfig } from "../types.js";
import type { SessionDB } from "../../server/session-db.js";
import { compressSession, type CompressionResult } from "../../server/compression-core.js";
import { getContextWindow } from "../provider-factory.js";
import { DEFAULT_CACHE_TTL_MS } from "../../core/constants.js";
import { log } from "../../core/logger.js";

// ---------------------------------------------------------------------------
// Thresholds (design.md「阈值」)
// ---------------------------------------------------------------------------

/** Cold-path / new-turn preflight soft trigger: absolute token floor (100K). */
const COLD_ABSOLUTE_TOKENS = 100_000;
/** Cold-path / new-turn preflight soft trigger: window fraction (50%). */
const COLD_WINDOW_FRACTION = 0.50;

/** New-turn hot 提醒 trigger: absolute token floor (200K). */
const HOT_REMIND_ABSOLUTE_TOKENS = 200_000;
/** New-turn hot 提醒 trigger: window fraction (70%). */
const HOT_REMIND_WINDOW_FRACTION = 0.70;

/** New-turn hot 强制 trigger: absolute token floor (400K). */
const HOT_FORCE_ABSOLUTE_TOKENS = 400_000;
/** New-turn hot 强制 trigger: window fraction (90%). */
const HOT_FORCE_WINDOW_FRACTION = 0.90;

/** 防抖: two consecutive compressions saving < this fraction stop the turn. */
const DEBOUNCE_MIN_IMPROVEMENT = 0.10;

// ---------------------------------------------------------------------------
// In-memory cache state (per session) — never persisted
// ---------------------------------------------------------------------------

/** Last LLM call timestamp (ms) per session. undefined ⇒ cold (first call). */
const lastLLMCall = new Map<string, number>();

/** Sessions that already compressed THIS turn (reset at TurnStart). */
const compressedThisTurn = new Set<string>();

/** 防抖 marker: last compression's token-reduction fraction per session. */
const lastReductionFraction = new Map<string, number>();

/** SessionId guard: avoid re-entrant compression for the same session. */
const inFlight = new Set<string>();

function markLastLLMCall(sessionId: string, ts: number): void {
	lastLLMCall.set(sessionId, ts);
}

function isCold(sessionId: string, cacheTtlMs: number, now: number): boolean {
	const last = lastLLMCall.get(sessionId);
	if (last === undefined) return true; // first call / restart
	return (now - last) > cacheTtlMs;
}

function resetTurnState(sessionId: string): void {
	compressedThisTurn.delete(sessionId);
	// NOTE: lastReductionFraction intentionally SURVIVES across turns — debounce
	// compares consecutive compressions regardless of which turn they ran in.
	// It is reset only by clearCompressionTriggerState (test reset).
}

// ---------------------------------------------------------------------------
// Threshold evaluation helpers
// ---------------------------------------------------------------------------

interface TokenState {
	/** Current context size (input tokens of the last API call). */
	tokens: number;
	/** Context window for the resolved provider/model. */
	window: number;
}

/** Read the current token state off the session row + provider config. */
function readTokenState(
	db: SessionDB,
	sessionId: string,
	providers: RuntimeProviderConfig[],
	config: SessionConfig,
): TokenState | undefined {
	const usage = db.getTokenUsage(sessionId);
	const inputTokens = usage?.inputTokens;
	if (inputTokens === undefined) return undefined;
	const window = getContextWindow(providers, config.providerName, config.modelId);
	return { tokens: inputTokens, window };
}

function exceedsThreshold(state: TokenState, abs: number, frac: number): boolean {
	if (state.tokens >= abs) return true;
	if (state.window > 0 && (state.tokens / state.window) >= frac) return true;
	return false;
}

// ---------------------------------------------------------------------------
// Compression runner — single chokepoint (fresh-tail protection enforced here)
// ---------------------------------------------------------------------------

/**
 * Build compressSession opts from the session config (reuses extractor A model).
 *
 * sub-7: when config.wikiStoreGlobal is present, also wire an Extractor A
 * service instance so each summary compressSession writes is fed to the
 * multi-step wiki-merge agent (second product of compression). The Extractor A
 * model config (config.extractors.A.provider/model) is reused. ExtractorAService
 * is imported lazily (dynamic require) to avoid a static runtime→server cycle
 * at module-load (the hook module is in runtime/, the service in server/).
 */
function buildCompressOpts(config: SessionConfig, providers: RuntimeProviderConfig[]) {
	const ext = (config as any)?.extractors?.A ?? {};
	const providerName = ext.provider ?? config.providerName;
	const modelId = ext.model ?? config.modelId;
	const contextWindow = getContextWindow(providers, config.providerName, config.modelId);
	const opts: any = { providers, providerName, modelId, contextWindow };
	const wiki = (config as any)?.wikiStoreGlobal;
	if (wiki) {
		try {
			// Lazy require — server/extractor-a-service imports tools/wiki-tool
			// (which imports server/wiki-node-store). Keeping this dynamic avoids
			// pulling the whole server/ wiki stack into runtime/ at static load.
			const { ExtractorAService } = require("../../server/extractor-a-service.js") as typeof import("../../server/extractor-a-service.js");
			const agentId = config.agentId;
			opts.extractorA = {
				service: new ExtractorAService({ providers, providerName, modelId, wiki }),
				// Default topic = per-agent (one memory subtree per agent;
				// agentId is the stable cross-session handle). Callers that want
				// a different topic partition can override resolveTopic.
				resolveTopic: (_summary: unknown, _seg: unknown, sessionId: string) => ({
					topicId: agentId ?? sessionId,
					topicTitle: agentId ? `Memory: ${agentId}` : undefined,
					agentId,
				}),
			};
		} catch (err) {
			log.warn("compress-trigger", `failed to wire Extractor A for compression (wiki merge disabled):`, (err as Error).message);
		}
	}
	return opts;
}

/**
 * Run compressSession, guarded against re-entry and per-turn double-fire.
 * Never throws (best-effort — a compression failure must NOT break the turn).
 * Returns the CompressionResult or undefined if skipped / failed.
 */
async function runCompression(
	sessionId: string,
	db: SessionDB,
	config: SessionConfig,
	providers: RuntimeProviderConfig[],
	reason: string,
): Promise<CompressionResult | undefined> {
	if (inFlight.has(sessionId)) {
		log.debug("compress-trigger", `session=${sessionId} compression in-flight, skipping (${reason})`);
		return undefined;
	}
	if (compressedThisTurn.has(sessionId)) {
		log.debug("compress-trigger", `session=${sessionId} already compressed this turn (${reason})`);
		return undefined;
	}

	// 防抖: stop if the last compression saved <10%.
	const lastFrac = lastReductionFraction.get(sessionId);
	if (lastFrac !== undefined && lastFrac < DEBOUNCE_MIN_IMPROVEMENT) {
		log.debug("compress-trigger", `session=${sessionId} debounce (last reduction ${(lastFrac * 100).toFixed(1)}% < 10%), skipping (${reason})`);
		return undefined;
	}

	const tokensBefore = db.getTokenUsage(sessionId)?.inputTokens;
	const cursorBefore = db.getCompressionCursor(sessionId) ?? 0;

	inFlight.add(sessionId);
	try {
		const result = await compressSession(sessionId, db, buildCompressOpts(config, providers));
		// Mark this turn as compressed (suppresses further compressions until TurnStart).
		if (result.summaries.length > 0) {
			compressedThisTurn.add(sessionId);
		}
		// 防抖: measure how far the cursor advanced as a fraction of the post-cursor
		// range (i.e. how much of the compressible range this run consumed). A run
		// that advanced <10% of the compressible range ⇒ near-useless ⇒ debounce
		// the NEXT run. This is a proxy for token-reduction (precise token recompute
		// would re-render the whole LLM view — too expensive per trigger).
		if (result.newCursor > cursorBefore) {
			const advanced = result.newCursor - cursorBefore;
			const denom = Math.max(1, result.newCursor);
			const reductionFrac = Math.min(1, advanced / denom);
			lastReductionFraction.set(sessionId, reductionFrac);
		}
		log.debug("compress-trigger",
			`session=${sessionId} compressed (${reason}): ${result.summaries.length} summary(ies), cursor ${cursorBefore}→${result.newCursor}` +
			(result.skippedReason ? ` [${result.skippedReason}]` : ""));
		return result;
	} catch (err) {
		log.warn("compress-trigger", `compression failed (session=${sessionId}, ${reason}):`, (err as Error).message);
		return undefined;
	} finally {
		inFlight.delete(sessionId);
	}
}

// ---------------------------------------------------------------------------
// Cache TTL resolution
// ---------------------------------------------------------------------------

function resolveCacheTtl(
	providers: RuntimeProviderConfig[],
	providerName: string,
): number {
	const match = providers.find((p) => p.name === providerName || p.name.toLowerCase() === providerName.toLowerCase());
	if (match?.cacheTtlMs !== undefined && match.cacheTtlMs > 0) return match.cacheTtlMs;
	return DEFAULT_CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Hook registration
// ---------------------------------------------------------------------------

export interface CompressionTriggerHooksDeps {
	/** Full SessionDB (token_usage read + compression write). */
	sessionDb: SessionDB;
}

/**
 * Register the compression trigger hooks. Idempotent. All four trigger seams
 * live here; the actual compression always routes through compressSession
 * (fresh-tail protection owned by the core).
 */
export function registerCompressionTriggerHooks(
	deps: CompressionTriggerHooksDeps,
	registry: HookRegistry = HookRegistry.getInstance(),
): void {
	const { sessionDb } = deps;

	const events: HookEventName[] = ["TurnStart", "StepEnd", "PreLLMCall", "OnLLMError"];

	for (const ev of events) {
		// Per-event dispatch via a single registered handler (keeps register count
		// to one per event so other hooks' ordering is unaffected).
		registry.register(ev, async (ctx) => {
			const sessionId = ctx.sessionId as string | undefined;
			if (!sessionId) return;

			// TurnStart only needs the sessionId (AgentLoop fires it with just
			// {agentId, sessionId, userMessage, source} — no config/providers).
			// Handle it BEFORE the config/providers guard so the per-turn reset
			// always runs.
			if (ev === "TurnStart") {
				try {
					resetTurnState(sessionId);
				} catch (err) {
					log.warn("compress-trigger", `TurnStart reset error (session=${sessionId}):`, (err as Error).message);
				}
				return;
			}

			const config = ctx.config as SessionConfig | undefined;
			const providers = ctx.providers as RuntimeProviderConfig[] | undefined;
			if (!config || !providers) return;

			try {
				switch (ev) {

					case "StepEnd": {
						// Persist this step's usage snapshot so the next trigger reads
						// current context size off the session row.
						const usage = ctx.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
						if (usage && usage.inputTokens !== undefined) {
							sessionDb.setTokenUsage(sessionId, usage);
						}

						// Cold path (可 mid-turn). Evaluate against state captured
						// BEFORE this step's PreLLMCall stamped lastLLMCall.
						const cacheTtl = resolveCacheTtl(providers, config.providerName);
						const now = Date.now();
						if (!isCold(sessionId, cacheTtl, now)) return; // hot ⇒ StepEnd does nothing
						const state = readTokenState(sessionDb, sessionId, providers, config);
						if (!state) return;
						if (!exceedsThreshold(state, COLD_ABSOLUTE_TOKENS, COLD_WINDOW_FRACTION)) return;
						await runCompression(sessionId, sessionDb, config, providers, "StepEnd cold");
						return;
					}

					case "PreLLMCall": {
						const cacheTtl = resolveCacheTtl(providers, config.providerName);
						const now = Date.now();
						const cold = isCold(sessionId, cacheTtl, now);
						const stepNumber = ctx.stepNumber as number | undefined;
						const isNewTurn = stepNumber === undefined || stepNumber === 1;
						const state = readTokenState(sessionDb, sessionId, providers, config);

						// Evaluate preflight / hot-path BEFORE this call stamps
						// lastLLMCall (the "time since last call" is what we judge).
						if (state) {
							if (cold) {
								// Cold + over threshold ⇒ forced preflight compression.
								// Covers resume-first-call / WAIT-woke-first-call /
								// crash-recovery-first-call / cold new turn.
								if (exceedsThreshold(state, COLD_ABSOLUTE_TOKENS, COLD_WINDOW_FRACTION)) {
									await runCompression(sessionId, sessionDb, config, providers,
										isNewTurn ? "PreLLMCall cold preflight (new turn)" : "PreLLMCall cold preflight (mid-turn)");
								}
							} else if (isNewTurn) {
								// Hot + new turn. mid-turn+hot 不打断.
								if (exceedsThreshold(state, HOT_FORCE_ABSOLUTE_TOKENS, HOT_FORCE_WINDOW_FRACTION)) {
									// Hard limit: forced compression before the call.
									await runCompression(sessionId, sessionDb, config, providers,
										"PreLLMCall hot hard-limit (new turn)");
								} else if (exceedsThreshold(state, HOT_REMIND_ABSOLUTE_TOKENS, HOT_REMIND_WINDOW_FRACTION)) {
									// Soft: inject 提醒 — LLM self-decides.
									return { appendMessages: [buildCompressionReminder(state)] };
								}
							}
							// hot + mid-turn + below hard ⇒ no-op (don't interrupt).
						}

						// This LLM call is happening now ⇒ it becomes the new
						// "last call" for the next cold/heat evaluation.
						markLastLLMCall(sessionId, now);
						return;
					}

					case "OnLLMError": {
						const errorClass = ctx.errorClass as string | undefined;
						if (errorClass !== "prompt_too_long") return;
						// Reactive: compress then let the loop retry. Returning
						// retry:true (default) + compressing here means the next
						// attempt sees a pruned context.
						await runCompression(sessionId, sessionDb, config, providers, "OnLLMError prompt_too_long");
						// Default retry policy already allows retry for prompt_too_long;
						// we just request it explicitly + a short delay.
						return { retry: true, delayMs: 0 };
					}
				}
			} catch (err) {
				// Never break the turn over a trigger failure.
				log.warn("compress-trigger", `${ev} handler error (session=${sessionId}):`, (err as Error).message);
			}
		});
	}

	log.debug("hooks", "Compression trigger hooks registered (sub-5: StepEnd/PreLLMCall/OnLLMError/TurnStart)");
}

// ---------------------------------------------------------------------------
// Hot-path 提醒 injection text
// ---------------------------------------------------------------------------

function buildCompressionReminder(state: TokenState): { role: string; content: string } {
	const pct = state.window > 0 ? Math.round((state.tokens / state.window) * 100) : 0;
	return {
		role: "user",
		content:
			`[system] Context is at ${state.tokens.toLocaleString()} tokens (~${pct}% of the ${state.window.toLocaleString()} window). ` +
			`Consider calling a compact/summarize step or wrapping up long-running sub-tasks before the context fills further — ` +
			`the next hard threshold will force an automatic compression that may drop recent detail. ` +
			`This is an advisory reminder; you may ignore it if the work is near completion.`,
	};
}

// ---------------------------------------------------------------------------
// Per-session state clear — archive pipeline (sub-8)
// ---------------------------------------------------------------------------

/**
 * steps-overhaul sub-8 (archive): clear ALL in-memory state this module holds
 * for ONE session. Called by the archive pipeline's teardown step (chat manual
 * archive of an active session) so a re-used sessionId / a sessionId whose
 * rows were just deleted doesn't leave stale hook state behind.
 *
 * Clears: lastLLMCall, compressedThisTurn, lastReductionFraction, inFlight for
 * this sessionId. Idempotent (no-op if the session had no state).
 *
 * NOTE: distinct from `clearCompressionTriggerState` (which clears EVERY
 * session — test-only reset). This is per-session and safe for production.
 */
export function clearCompressionTriggerStateForSession(sessionId: string): void {
	lastLLMCall.delete(sessionId);
	compressedThisTurn.delete(sessionId);
	lastReductionFraction.delete(sessionId);
	inFlight.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Test helpers — reset module state between unit tests.
// ---------------------------------------------------------------------------

/** Test-only: clear all in-memory cache/turn state. */
export function clearCompressionTriggerState(): void {
	lastLLMCall.clear();
	compressedThisTurn.clear();
	lastReductionFraction.clear();
	inFlight.clear();
}

/**
 * Test-only: directly set the lastLLMCall timestamp for a session, so a test
 * can simulate "hot" (recent) or "cold" (stale) cache without waiting.
 */
export function _setLastLLMCallForTest(sessionId: string, ts: number | undefined): void {
	if (ts === undefined) lastLLMCall.delete(sessionId);
	else lastLLMCall.set(sessionId, ts);
}

/** Test-only: read the lastLLMCall timestamp for a session. */
export function _getLastLLMCallForTest(sessionId: string): number | undefined {
	return lastLLMCall.get(sessionId);
}

/**
 * Test-only: directly set the last-compression reduction fraction for a session,
 * so a test can simulate a near-useless prior compression (<10%) and assert the
 * debounce path skips the next one.
 */
export function _setLastReductionForTest(sessionId: string, frac: number | undefined): void {
	if (frac === undefined) lastReductionFraction.delete(sessionId);
	else lastReductionFraction.set(sessionId, frac);
}
