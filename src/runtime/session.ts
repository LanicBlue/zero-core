// Agent 会话管理
//
// # 文件说明书
//
// ## 核心功能
// Agent 会话类，管理消息历史、token 计算和上下文窗口。
// 支持从 step-level 存储重建消息（优先）和 legacy turn-level 回退。
//
// ## 输入
// - 系统提示词
// - 上下文窗口大小
//
// ## 输出
// - 消息历史
// - token 使用统计
//
// ## 定位
// Runtime 会话管理，被 AgentLoop 使用。
//
// ## 依赖
// - ai - AI SDK 类型
// - ./session-store-interface - 会话存储
// - ../core/hook-registry - Hook 触发
//
// ## 维护规则
// - token 计算逻辑变更时需更新
// - 保持消息修剪策略正确
//
import type { ModelMessage } from "ai";
import type { AttachmentMeta } from "../shared/types.js";
import type { ISessionStore, MessageSummary, StepRow } from "./session-store-interface.js";
import { triggerHooks } from "../core/hook-registry.js";
import { readFileSync } from "node:fs";

const DEFAULT_CONTEXT_WINDOW = 128000;
const RESERVE_TOKENS = 16384;

/**
 * multimodal-input sub-3: format an attachment's meta-info as a text part,
 * appended to the user message content when the attachment is NOT inlined
 * (history step / non-image kind / provider not multimodal / read failure).
 * Per design 组件 3 the format is:
 *   [attachment: <fileName> | type=<mimeType> | size=<size> | at <diskPath> — <hint>]
 * `hint` contextualizes WHY it's meta-only and nudges the LLM toward file-read
 * / subagent delegation (principle B — LLM self-decides how to reach the bytes).
 */
function formatAttachmentMeta(att: AttachmentMeta, hint: string): string {
	return `[attachment: ${att.fileName} | type=${att.mimeType} | size=${att.size} | at ${att.diskPath} — ${hint}]`;
}

/**
 * sub-5 (Wait resume): best-effort parse of a persisted tool-call's args. The
 * turns table stores `args` either as a raw OBJECT (turn-recorder writes the
 * SDK's e.input verbatim, JSON round-trip preserves object shape) or as a JSON
 * STRING (some legacy/normalized paths). Returns {} on parse failure so the
 * wait-resume branch can degrade to the "no args → wake as timeout" path
 * instead of throwing during message rebuild.
 */
function safeParseArgs(raw: string): any {
	try { return JSON.parse(raw) ?? {}; } catch { return {}; }
}

/** Cached turn data — now includes turnGroup for step-level storage. */
export interface CachedTurnData {
	seq: number;
	role: string;
	content: string | null;
	createdAt: string;
	turnGroup?: number;
	/**
	 * multimodal-input sub-2: attachment metadata loaded back from the
	 * `turns.attachments` column. `undefined` for legacy rows / no attachments
	 * (back-compat). Per design principle A only meta flows here — never bytes.
	 */
	attachments?: AttachmentMeta[];
}

export class AgentSession {
	private messages: ModelMessage[] = [];
	private readonly systemPrompt: string;
	private readonly contextWindow: number;
	private sessionId: string | null = null;
	private db: ISessionStore | null;

	/**
	 * multimodal-input sub-3 (#3 wiring): whether the resolved provider/model
	 * supports image input (`ProviderModel.multimodal === true`). Set by
	 * AgentLoop alongside contextWindow (same resolution path). Consumed by
	 * {@link getMessagesMultimodal} to decide inline-image vs attachment
	 * meta-info text for the CURRENT user step. `false` (default) → all
	 * attachments render as meta-info text (safe; LLM may still reach the image
	 * via file-read / subagent delegation, per design principle B).
	 */
	private multimodal: boolean = false;

	/**
	 * multimodal-input sub-3: the seq of the user step that opened the CURRENT
	 * turn group (the most recent user step). All multi-step LLM calls within
	 * the same turn treat this step as "current" (per design: 当前 step = the
	 * turn's user message). Set by AgentLoop right after TurnStart writes the
	 * user row (`stepBaseSeq - 1`). `-1` = no current user step marked (treat
	 * ALL user steps as history → meta-info only, safe default).
	 */
	private currentUserStepSeq: number = -1;

	/** Cached raw turns from DB — populated by rebuildFromTurns(), used as runtime source for UI. */
	private cachedTurns: CachedTurnData[] = [];

	/** Calibrated token count from last API response. null = no calibration yet. */
	private lastActualInputTokens: number | null = null;
	/** How many messages were in the session when calibration was recorded. */
	private messageCountAtCalibration: number = 0;

	constructor(
		systemPrompt: string,
		contextWindow?: number,
		sessionId?: string,
		db?: ISessionStore,
		multimodal?: boolean,
	) {
		this.systemPrompt = systemPrompt;
		this.contextWindow = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		this.sessionId = sessionId ?? null;
		this.db = db ?? null;
		this.multimodal = multimodal ?? false;

		if (this.db && this.sessionId) {
			// steps-overhaul sub-3: rebuildFromTurns now splits into TWO paths
			// (both run eagerly here so getMessagesMultimodal's positional
			// match against cachedTurns works on the first call):
			//   ① cachedTurns — the FULL step history from steps (UI source).
			//   ② this.messages (LLM view) — the 3-zone assembly:
			//     [summary] + [middle: tool stub] + [fresh tail: pointer verbatim].
			// The messages table is NO LONGER a write-through cache — it holds
			// summary blocks + a compression cursor; step content lives only in
			// steps. See design.md「两张表」+ sub-3.md.
			this.rebuildFromTurns();
		}
	}

	/**
	 * multimodal-input sub-3 (#3 wiring): set the provider image capability for
	 * this session. Called by AgentLoop when the resolved model changes
	 * (applyConfigUpdate) so the new capability takes effect on the next
	 * getMessages. Mirrors the existing updateSystemPrompt mid-session-update
	 * pattern.
	 */
	setMultimodal(multimodal: boolean): void {
		this.multimodal = multimodal;
	}

	/**
	 * multimodal-input sub-3: read the resolved provider image capability.
	 * Used by getMessagesMultimodal.
	 */
	getMultimodalCapability(): boolean {
		return this.multimodal;
	}

	/**
	 * multimodal-input sub-3: mark the seq of the user step that opened the
	 * current turn group. Called by AgentLoop right after TurnStart writes the
	 * user row (value = `stepBaseSeq - 1`). Pass `-1` to clear (next getMessages
	 * treats every user step as history → meta-info only).
	 */
	setCurrentUserStepSeq(seq: number): void {
		this.currentUserStepSeq = seq;
	}

	/**
	 * multimodal-input sub-3: read the current turn's user-step seq.
	 */
	getCurrentUserStepSeq(): number {
		return this.currentUserStepSeq;
	}

	getSessionId(): string | null {
		return this.sessionId;
	}

	getSystemPrompt(): string {
		return this.systemPrompt;
	}

	/**
	 * v0.8 (delegation refactor / loop hot-sync): replace the system prompt
	 * mid-session. The caller (AgentLoop.applyConfigUpdate) is responsible for
	 * invalidating the prompt cache so the next turn reassembles with the new
	 * prompt. Infrequent operation (agent edits its own prompt) — cache break
	 * is acceptable.
	 */
	updateSystemPrompt(prompt: string): void {
		(this as unknown as { systemPrompt: string }).systemPrompt = prompt;
	}

	getMessages(): ModelMessage[] {
		return this.messages;
	}

	/**
	 * multimodal-input sub-3 (#3 wiring, the consumer side): build the message
	 * list sent to the LLM, applying the **image-only inline + current step**
	 * rule from design 组件 3 / principle B. This is what AgentLoop feeds into
	 * streamText (replacing the bare `getMessages()` at the LLM call site).
	 *
	 * Rules (per design D3):
	 *  - **Current user step** (the user step that opened the current turn
	 *    group, marked via {@link setCurrentUserStepSeq}; all multi-step LLM
	 *    calls within the turn treat it as current) + provider
	 *    {@link multimodal}===true + attachment.kind==="image" → inline
	 *    `{type:"image", image: readFileSync(diskPath), mimeType}` part
	 *    (bytes read from disk at this edge — principle A).
	 *  - **History user step** (any earlier user step with attachments) /
	 *    PDF / arbitrary file / provider not multimodal → meta-info text part
	 *    appended to the user content:
	 *    `[attachment: <fileName> | type=<mimeType> | size=<size> | at <diskPath> — <hint>]`.
	 *
	 * Non-user messages and user messages without attachments pass through
	 * unchanged. The matching between `this.messages` (already-built, user text
	 * as plain string) and `this.cachedTurns` (step rows carrying attachments)
	 * is positional on user-role entries: every user step yields exactly one
	 * user message, in order.
	 *
	 * Returns a NEW array; `this.messages` is not mutated (the inline bytes are
	 * a per-LLM-call edge concern — principle A — and must not leak into the
	 * persistent `messages` write-through cache).
	 */
	getMessagesMultimodal(): ModelMessage[] {
		// Fast path: no attachments anywhere AND provider not multimodal → the
		// plain messages are already correct; skip the enrichment loop.
		const hasAnyAttachment = this.cachedTurns.some(t => t.attachments && t.attachments.length > 0);
		if (!hasAnyAttachment) return this.messages;

		// Walk cachedTurns in order and collect USER steps that produced a user
		// message, so we can match them 1:1 (positional, user-role only) with
		// the user messages in `this.messages`. rebuildFromSteps emits exactly
		// one user message per user step (in step order), so the i-th user step
		// corresponds to the i-th user message.
		const userSteps = this.cachedTurns.filter(t => t.role === "user");

		const out: ModelMessage[] = [];
		let userMsgIdx = 0;
		for (const msg of this.messages) {
			if ((msg as any).role !== "user") {
				out.push(msg);
				continue;
			}
			const step = userSteps[userMsgIdx];
			userMsgIdx++;
			const attachments = step?.attachments;
			if (!attachments || attachments.length === 0 || step === undefined) {
				out.push(msg);
				continue;
			}
			const isCurrent = this.currentUserStepSeq !== -1 && step.seq === this.currentUserStepSeq;
			const built = this.buildMultimodalUserMessage(msg, attachments, isCurrent);
			out.push(built);
		}
		return out;
	}

	/**
	 * multimodal-input sub-3: turn one user ModelMessage + its attachment list
	 * into the final user content (string | content-array). Inline image parts
	 * are added ONLY when `isCurrent && this.multimodal && kind==="image"`; all
	 * other attachments and the not-current/not-multimodal cases collapse to
	 * meta-info text parts appended after the original text.
	 */
	private buildMultimodalUserMessage(
		msg: ModelMessage,
		attachments: AttachmentMeta[],
		isCurrent: boolean,
	): ModelMessage {
		const originalText = typeof (msg as any).content === "string"
			? (msg as any).content as string
			: "";

		const parts: any[] = [];
		if (originalText) parts.push({ type: "text", text: originalText });

		for (const att of attachments) {
			const inlineable = isCurrent && this.multimodal && att.kind === "image";
			if (inlineable) {
				// Principle A edge: read bytes off disk ONLY here. readFileSync
				// returns a Buffer, which IS a valid AI SDK DataContent
				// (Uint8Array subclass). On any read error, degrade to
				// meta-info text rather than crashing the turn.
				try {
					const bytes = readFileSync(att.diskPath);
					parts.push({ type: "image", image: bytes, mimeType: att.mimeType });
				} catch {
					parts.push({ type: "text", text: formatAttachmentMeta(att, "attachment unreadable on disk (read failed)") });
				}
			} else {
				const hint = !this.multimodal
					? "model not multimodal — use file-read / delegate to a vision-capable subagent"
					: att.kind !== "image"
						? `${att.kind} attachment — use file-read to inspect`
						: isCurrent
							? "current image (inline disabled)"
							: "history attachment — use file-read to re-inspect";
				parts.push({ type: "text", text: formatAttachmentMeta(att, hint) });
			}
		}

		return { role: "user", content: parts } as ModelMessage;
	}

	/** Cached raw turns from DB (populated by rebuildFromTurns). Used as runtime source for UI. */
	/**
	 * Refresh the cached turns from DB (e.g. before UI session_init).
	 * steps-overhaul sub-3: now also rebuilds the LLM view (this.messages) so a
	 * refresh leaves both paths consistent — getMessages() reflects fresh steps
	 * after a refresh, not just getCachedTurns(). Both paths run eager (the
	 * display-time pull contract: a refresh re-pulls the source of truth).
	 */
	refreshTurnsCache(): void {
		// Step 4A: step-only — steps table is read exclusively via getSteps.
		if (!this.db || !this.sessionId) return;
		this.rebuildFromTurns();
	}

	/**
	 * Step 4A: renamed from the old turn-reader name — that name collided with
	 * the now-retired legacy DB row-reader API. This is the UI-facing accessor
	 * over the in-memory cached step rows (populated by rebuildFromTurns /
	 * refreshTurnsCache); it does not touch the DB.
	 */
	getCachedTurns(): CachedTurnData[] {
		return this.cachedTurns;
	}

	addMessage(msg: ModelMessage): void {
		this.messages.push(msg);
	}

	replaceMessages(messages: ModelMessage[]): void {
		this.messages = messages;
		this.invalidateCalibration();
	}

	getContextUsage(): number {
		const total = this.estimateTokens();
		return this.contextWindow > 0 ? total / this.contextWindow : 0;
	}

	getContextWindow(): number {
		return this.contextWindow;
	}

	getEstimatedTokens(): number {
		return this.estimateTokens();
	}

	/**
	 * steps-overhaul sub-3: saveToDb is now a NO-OP. The old implementation
	 * dumped this.messages (the in-memory LLM view) into the `messages` table
	 * via db.saveTurn. With messages redefined to "summary blocks + a
	 * compression cursor" (no step content), there is nothing for the runtime
	 * to write here:
	 *   - Step content is persisted at write time via turn-hooks (appendStep /
	 *     upsertStep / updateStepContent) — steps is the durable source.
	 *   - Summary blocks + the compression cursor are written by future
	 *     compression (sub-4 Extractor A via saveSummaryAndAdvanceCursor), NOT
	 *     by the per-turn runtime.
	 *   - The LLM view (this.messages) is an ephemeral assemble, never stored.
	 *
	 * The method is kept as a no-op rather than removed because existing
	 * callers (the disabled compression hook, tests) still reference it; removing
	 * it would force a wider refactor. The no-op is semantically correct: there
	 * is genuinely nothing to persist at the call sites that remain.
	 */
	saveToDb(): void {
		/* no-op — see method comment. steps is durable; messages is summary+cursor. */
	}

	async pruneIfNeeded(): Promise<void> {
		const systemPromptTokens = this.estimateSystemPromptTokens();
		const available = this.contextWindow - RESERVE_TOKENS - systemPromptTokens;
		const total = this.estimateTokens();
		if (total <= available) return;

		await triggerHooks("PreCompact", { sessionId: this.sessionId ?? "", messageCount: this.messages.length, estimatedTokens: this.estimateTokens(), contextWindow: this.contextWindow });

		// v0.8 (M5, prune/compress order fix — RFC §2.18):
		// Bug being fixed: the old loop did `if (budget - cost < 0) break;`
		// which meant a single turn larger than the budget was dropped
		// entirely with NO summary ("裸丢"). For an agent with exactly one
		// giant turn this zeroed the context.
		//
		// Fix: walk from the tail keeping messages while budget remains.
		// When a message would overflow the remaining budget:
		//   - If it's NOT the last turn's messages (i.e. we already kept at
		//     least one message): drop it + everything older (they will be
		//     picked up by the compression engine's L1/L2 on PostTurnComplete
		//     and extracted into memory nodes — NOT naked-dropped).
		//   - If it IS part of the most recent turn (we haven't kept anything
		//     yet, or only kept partial of the current turn): KEEP it anyway
		//     by truncating to fit. The agent must have SOMETHING to work
		//     with; truncating one message is strictly better than dropping
		//     the whole turn silently.
		let budget = available;
		const kept: ModelMessage[] = [];
		const dropped: ModelMessage[] = [];

		for (let i = this.messages.length - 1; i >= 0; i--) {
			const msg = this.messages[i];
			const cost = this.estimateMessageTokens(msg);
			if (budget - cost >= 0) {
				budget -= cost;
				kept.unshift(msg);
				continue;
			}
			// Overflow case.
			if (kept.length === 0) {
				// Most recent message is itself larger than budget. Truncate
				// to fit rather than naked-drop. This is the "large single
				// turn" path — content is preserved (truncated), and the
				// untruncated original still lives in the turns table
				// (mechanism 1 — raw turn persistence) so the extractor can
				// still summarize the full thing later.
				const truncated = this.truncateMessage(msg, Math.max(budget, 1024));
				kept.unshift(truncated);
				budget = 0;
				// Everything older than this gets dropped (will be summarized
				// by compression engine on next PostTurnComplete).
				for (let j = i - 1; j >= 0; j--) dropped.unshift(this.messages[j]);
				break;
			}
			// Older overflow: drop this message and everything older. They
			// are subject to stage-3 compression (sub-4 compressSession —
			// summarizes them into the messages summary blocks, NOT a naked
			// drop).
			for (let j = i; j >= 0; j--) dropped.unshift(this.messages[j]);
			break;
		}

		this.messages = kept;
		this.invalidateCalibration();

		// Surface dropped-turn count so the compression engine (and tests)
		// can verify nothing was naked-dropped. PostCompact already fires
		// after this; the compression hook runs on PostTurnComplete and
		// will pick up the dropped turns via L1/L2 (they're gone from
		// in-memory messages but still in the turns table — mechanism 1).
		if (dropped.length > 0) {
			await triggerHooks("PostCompact", {
				sessionId: this.sessionId ?? "",
				messageCount: this.messages.length,
				estimatedTokens: this.estimateTokens(),
				contextWindow: this.contextWindow,
				droppedMessageCount: dropped.length,
				prunedTailMessageCount: dropped.length,
			} as any);
		} else {
			await triggerHooks("PostCompact", { sessionId: this.sessionId ?? "", messageCount: this.messages.length, estimatedTokens: this.estimateTokens(), contextWindow: this.contextWindow });
		}
	}

	/**
	 * v0.8 (M5): truncate a single oversized message to roughly `targetTokens`.
	 * Used by pruneIfNeeded when the most-recent message itself overflows the
	 * budget — truncating is strictly better than naked-dropping (the original
	 * stays in the turns table for later extraction). Preserves role and
	 * keeps the head of text content.
	 */
	private truncateMessage(msg: ModelMessage, targetTokens: number): ModelMessage {
		const role = (msg as any).role;
		const content = (msg as any).content;
		// Approx tokens → chars (4 chars/token heuristic, matches estimateMessageTokens).
		const targetChars = Math.max(256, targetTokens * 4);
		const note = `\n\n[... truncated by pruneIfNeeded (M5 large-single-turn fix); full content remains in session storage for extractor A ...]`;

		if (typeof content === "string") {
			const sliced = content.length > targetChars ? content.slice(0, targetChars - note.length) + note : content;
			return { role, content: sliced } as ModelMessage;
		}
		if (Array.isArray(content)) {
			// Keep head text parts until budget; drop trailing parts.
			const out: any[] = [];
			let used = 0;
			for (const part of content) {
				if (part?.type === "text" && typeof part.text === "string") {
					const remaining = targetChars - used - note.length;
					if (remaining <= 0) break;
					if (part.text.length > remaining) {
						out.push({ type: "text", text: part.text.slice(0, remaining) + note });
						used = targetChars;
						break;
					}
					out.push(part);
					used += part.text.length;
				} else {
					// Non-text parts (tool-call / tool-result) are usually
					// smaller; keep them as-is but stop if we've blown budget.
					if (used >= targetChars) break;
					out.push(part);
					used += JSON.stringify(part ?? {}).length;
				}
			}
			if (out.length === 0 && content.length > 0) {
				// Edge case: only non-text parts and they overflow. Keep the
				// first part truncated.
				const first = content[0];
				out.push({ ...first, _truncated: true });
			}
			return { role, content: out } as ModelMessage;
		}
		return msg;
	}

	/**
	 * steps-overhaul sub-3: rebuildFromTurns now runs TWO independent paths and
	 * returns the LLM view (this.messages). Both populate state that downstream
	 * consumers read, so both must run eagerly (constructor + every call):
	 *
	 *   ① cachedTurns — the FULL step history from steps (UI source; also the
	 *     positional-match source for getMessagesMultimodal's attachment
	 *     enrichment). No truncation, no stubbing — one entry per step row.
	 *
	 *   ② this.messages (LLM view) — the 2-zone assembly (sub-3a):
	 *        [summary]        ← messages table summary blocks (≤3 FIFO)
	 *        [postCursor]     ← steps(compressionCursor..当前) assembled
	 *                           verbatim (pointer form intact — NOT
	 *                           dereferenced to full bytes)
	 *
	 * Invariants (acceptance-3a):
	 *   - Two tables never duplicate content (steps holds all step content;
	 *     messages holds only summary+cursor).
	 *   - No mid-turn drift: messages is a cursor; steps is the source; this
	 *     assemble is deterministic and reproducible across crashes.
	 *   - Restart recovery: reassembling from messages.summary + steps[cursor..
	 *     last_completed_step_seq] yields the SAME LLM view as before the crash.
	 *
	 * sub-3a shrank the 3-zone model (summary / stubbed middle / verbatim fresh
	 * tail) to 2 zones (summary / verbatim postCursor). The fresh-tail boundary
	 * survives ONLY in compression-core.computeFreshTailStartSeq, where it
	 * governs how far the cursor advances during compression — the LLM view no
	 * longer needs it.
	 */
	rebuildFromTurns(): ModelMessage[] {
		// Step 4A: step-only — the steps table is read exclusively via getSteps.
		if (!this.db || !this.sessionId) {
			this.cachedTurns = [];
			this.messages = [];
			return [];
		}

		const steps = this.db.getSteps(this.sessionId);

		// ── Path ① cachedTurns: FULL step history (UI source). ──────────────
		// multimodal-input sub-2: carry attachments so UI rebuild + restart
		// recovery keep attachment metadata in sync. Never stubbed/truncated.
		this.cachedTurns = steps.map(s => ({
			seq: s.seq,
			role: s.role,
			content: s.content,
			createdAt: s.createdAt,
			turnGroup: s.turnGroup,
			attachments: s.attachments,
		}));

		// ── Path ② this.messages: 2-zone LLM-view assembly (sub-3a). ────────
		this.messages = this.normalizeMessages(this.assembleLLMView(steps));
		return this.messages;
	}

	/**
	 * sub-3a: build the 2-zone LLM view (design.md「阶段2」).
	 * Zones, in order:
	 *   [summary]     — from db.getSummaries (≤3 FIFO blocks). Skipped if no
	 *                   summaries (the common case until the compression hook
	 *                   writes one).
	 *   [postCursor]  — steps with seq > compressionCursor, assembled VERBATIM.
	 *                   Pointer-form tool results are NOT dereferenced. Tool-
	 *                   use/result pairs stay valid because each assistant step
	 *                   carries both blocks (see appendStepMessages).
	 *
	 * compressionCursor (db.getCompressionCursor) is the only carve point; the
	 * previous fresh-tail split was a session-side duplicate of
	 * compression-core.computeFreshTailStartSeq and is now consolidated there.
	 * Step granularity is preserved throughout (a step is never split).
	 */
	private assembleLLMView(steps: StepRow[]): ModelMessage[] {
		if (steps.length === 0) return [];

		const db = this.db!;
		const sessionId = this.sessionId!;

		// ── Zone 1: summary blocks (messages table). ───────────────────────
		const summaries: MessageSummary[] =
			(typeof db.getSummaries === "function") ? (db.getSummaries(sessionId) ?? []) : [];
		const compressionCursor: number | null =
			(typeof db.getCompressionCursor === "function") ? db.getCompressionCursor(sessionId) : null;

		const messages: ModelMessage[] = [];

		// steps-overhaul sub-4 (Lens A 连续-role 修正): each summary block is
		// emitted as a single SYSTEM-role message (NOT user). The summary is a
		// recap of pre-cursor history — system is the semantically correct role,
		// AND it cannot collide with the turn-opening user step that follows it
		// in zone 2/3 (which would produce two consecutive user messages — some
		// providers reject that). This is the primary fix; normalizeMessages
		// below is the defensive backstop that merges any residual consecutive
		// same-role run (e.g. two user steps at a zone 2/3 boundary).
		for (const s of summaries) {
			const body = this.renderSummaryText(s);
			if (body) {
				messages.push({ role: "system", content: body } as ModelMessage);
			}
		}

		// ── Zone 2: postCursor verbatim (2-zone model, sub-3a). ────────────
		// compressionCursor = last step seq that was summarized away. NULL OR 0
		// means "no compression yet" (design: default NULL/0) — in that case the
		// ENTIRE step history lives in the post-cursor region. Steps with seq <=
		// a real (>=1) cursor are ALREADY represented by the summaries above and
		// are dropped from the assemble.
		//
		// sub-3a: the previous 3-zone model split this region at the fresh-tail
		// boundary and stubbed tool results in the older half. That middle
		// (stub) zone is GONE — postCursor is now emitted as a single verbatim
		// run. Token budgeting is owned by the compression pipeline (sub-3b/c
		// advance the cursor; PreLLMCall/compressSession hook fires on
		// prompt_too_long); the LLM view is just a cursor over what survives.
		const hasRealCursor = compressionCursor !== null && compressionCursor >= 1;
		const postCursor = hasRealCursor
			? steps.filter(s => s.seq > (compressionCursor as number))
			: steps;
		if (postCursor.length === 0) return messages;

		this.appendStepsAsMessages(postCursor, messages);

		return messages;
	}

	/**
	 * Render one MessageSummary block as a compact text message for zone 1.
	 * Emits the structured sections in a stable order; empty sections omitted.
	 */
	private renderSummaryText(s: MessageSummary): string {
		const lines: string[] = [];
		lines.push(`[summary: ${s.title}]`);
		const order = ["purpose", "plan", "status", "artifacts", "lessons"];
		for (const key of order) {
			const val = s.sections?.[key];
			if (val) lines.push(`${key}: ${val}`);
		}
		// Any non-standard sections appended after the canonical 5.
		for (const [k, v] of Object.entries(s.sections ?? {})) {
			if (order.includes(k)) continue;
			if (v) lines.push(`${k}: ${v}`);
		}
		if (s.stepRange) lines.push(`(summarizes steps ${s.stepRange.from}..${s.stepRange.to})`);
		return lines.join("\n");
	}

	/**
	 * Assemble a contiguous run of step rows into ModelMessages, grouping by
	 * turnGroup (mirrors the legacy rebuildFromSteps grouping). All steps are
	 * emitted VERBATIM (sub-3a 2-zone model: no middle/stub zone). Pointer-form
	 * tool results are NOT dereferenced — the LLM sees the pointer string as-is
	 * (~4K token) and can file-read for detail. Dangling-tool synthesis (Step 2E
	 * / sub-5 Wait) still runs so every tool-call has a paired tool-result
	 * (validity invariant for the provider).
	 */
	private appendStepsAsMessages(steps: StepRow[], messages: ModelMessage[]): void {
		// Group by turnGroup, preserving order (same grouping as rebuildFromSteps).
		const groups = new Map<number, StepRow[]>();
		for (const step of steps) {
			const g = groups.get(step.turnGroup);
			if (g) g.push(step);
			else groups.set(step.turnGroup, [step]);
		}

		// The toolCallId offset must be continuous across the WHOLE LLM view
		// (zone 1 summaries don't emit tool ids; zone 2 shares one counter).
		// Seed it from the count of tool-call ids already emitted in `messages`.
		let tcOffset = this.countToolCallIds(messages);

		for (const [, groupSteps] of groups) {
			const userStep = groupSteps.find(s => s.role === "user");
			if (userStep) {
				messages.push({ role: "user", content: userStep.content ?? "" });
			}
			for (const step of groupSteps) {
				if (step.role !== "assistant") continue;
				let blocks: any[] = [];
				try { blocks = JSON.parse(step.content ?? "[]"); } catch { blocks = []; }
				// Dangling-tool synthesis always runs (validity invariant).
				this.synthesizeDanglingToolResultsInPlace(blocks);
				tcOffset = this.appendStepMessages(blocks, messages, tcOffset);
			}
		}
	}

	/** Count tool-call ids already present in a message list (for tcOffset seeding). */
	private countToolCallIds(messages: ModelMessage[]): number {
		let n = 0;
		for (const msg of messages) {
			const content = (msg as any).content;
			if (!Array.isArray(content)) continue;
			for (const part of content) {
				if (part?.type === "tool-call") n++;
			}
		}
		return n;
	}

	/**
	 * Step 2E: synthesize a result for every dangling tool block in `blocks` —
	 * any tool block in status "running" with no result is filled with
	 * {result:"[interrupted]", status:"error"}. Persist writes the truth (a tool
	 * legitimately stays "running" mid-step), so this is applied at rebuild time
	 * to guarantee the rebuilt messages always carry a paired tool-result for
	 * every tool-call. Idempotent — blocks with a result are untouched.
	 *
	 * sub-5 (Wait rewrite): a pending WAIT tool call does NOT get the generic
	 * `[interrupted]` synthesis. Instead it takes a dedicated wait-resume
	 * branch: read the persisted args (`until` absolute / `timeout` relative),
	 * decide whether the deadline already passed during the outage, and fill a
	 * Wait-specific result so the rebuilt messages stay valid (paired tool-
	 * result) WITHOUT the misleading "[interrupted]" label. The in-process
	 * re-suspend for a still-future `until` is handled by AgentLoop.resume
	 * (detectAndResumePendingWait), not here — here we only guarantee message
	 * validity + an honest result string.
	 *
	 *   - `until` in the past, or only relative `timeout` (not durable across
	 *     restart → treated as elapsed): fill `woke: timeout` (status done).
	 *   - `until` in the future: fill `woke: timeout (resumed; wait re-suspended)`
	 *     (status done). The model sees the wait "returned" so the conversation
	 *     is valid; AgentLoop.resume re-suspends to honor the real deadline.
	 *
	 *   sub-9 (durable relative-timeout): a relative-only `timeout` with a
	 *   persisted `startedAt` block-level field (sibling to `args`) is now ALSO
	 *   durable. If `now − startedAt < timeoutSec*1000` the deadline has NOT
	 *   elapsed across the restart → fill the same "resumed; wait re-suspended"
	 *   placeholder so detectAndResumePendingWait re-suspends with the remaining
	 *   time. No `startedAt` (old blocks pre-sub-9) OR remaining ≤ 0 → fall
	 *   through to `woke: timeout` (old-block compat: treated as elapsed, no crash).
	 */
	private synthesizeDanglingToolResultsInPlace(blocks: any[]): void {
		for (const b of blocks) {
			if (b?.type !== "tool" || b.status !== "running" || b.result !== undefined) continue;

			if (b.name === "Wait") {
				// Dedicated wait-resume branch — do NOT synthesize [interrupted].
				const args = (typeof b.args === "string") ? safeParseArgs(b.args) : (b.args ?? {});
				const untilIso = typeof args?.until === "string" ? args.until : undefined;
				const untilMs = untilIso ? Date.parse(untilIso) : NaN;
				const hasFutureUntil = !Number.isNaN(untilMs) && untilMs > Date.now();
				if (hasFutureUntil) {
					b.status = "done";
					b.result = "woke: timeout (resumed; wait re-suspended)";
					continue;
				}
				// sub-9: relative-only `timeout` with a persisted `startedAt` →
				// durable. Compute remaining and treat like a future `until`.
				const startedAt = typeof b.startedAt === "number" ? b.startedAt
					: (typeof b.startedAt === "string" && /^[0-9]+$/.test(b.startedAt) ? Number(b.startedAt) : NaN);
				const timeoutSec = typeof args?.timeout === "number" ? args.timeout
					: (typeof args?.timeout === "string" && /^[0-9]+(\.[0-9]+)?$/.test(args.timeout) ? Number(args.timeout) : NaN);
				if (!Number.isNaN(startedAt) && !Number.isNaN(timeoutSec) && timeoutSec > 0) {
					const remainingMs = startedAt + timeoutSec * 1000 - Date.now();
					if (remainingMs > 0) {
						b.status = "done";
						b.result = "woke: timeout (resumed; wait re-suspended)";
						continue;
					}
				}
				// Past-due `until`, relative-only `timeout` without `startedAt`
				// (old block → treated as elapsed for back-compat) or already
				// elapsed, or no args at all → wake as timeout.
				b.status = "done";
				b.result = "woke: timeout";
				continue;
			}

			b.status = "error";
			b.result = "[interrupted]";
		}
	}

	// steps-overhaul sub-3: the old rebuildFromSteps() (full verbatim rebuild,
	// no zones) was folded into assembleLLMView + appendStepsAsMessages which
	// implement the 3-zone assembly. The method is removed — no callers remain
	// (verified by grep; only test/doc comments reference the historical name).
	// appendStepMessages below is still used by appendStepsAsMessages.

	/** Process a single step's blocks into AI SDK messages, with toolCallId offset.
	 *  Returns the updated tcOffset for the next step. */
	private appendStepMessages(blocks: any[], messages: ModelMessage[], toolCallOffset: number): number {
		const toolCalls: { id: string; name: string; input: any }[] = [];
		const toolResults: { id: string; name: string; output: any; isError?: boolean }[] = [];
		const textParts: string[] = [];

		for (const b of blocks) {
			if (b.type === "tool") {
				// Generate globally unique toolCallId using offset
				const id = "tc-" + (toolCallOffset + toolCalls.length);
				toolCalls.push({ id, name: b.name, input: b.args ?? {} });
				const result = typeof b.result === "string" ? b.result : JSON.stringify(b.result ?? "");
				toolResults.push({ id, name: b.name, output: result, isError: b.status === "error" });
			} else if (b.type === "text") {
				textParts.push(b.text);
			}
		}

		// Build assistant message parts
		const parts: any[] = [];
		if (toolCalls.length > 0) {
			parts.push(...toolCalls.map((tc) => ({ type: "tool-call", toolCallId: tc.id, toolName: tc.name, input: tc.input })));
		}
		const textContent = textParts.join("").trim();
		if (textContent) {
			parts.push({ type: "text", text: textContent });
		}

		if (parts.length > 0) {
			messages.push({ role: "assistant", content: parts });
		}

		// Add tool results as separate tool messages
		if (toolResults.length > 0) {
			for (const tr of toolResults) {
				messages.push({
					role: "tool",
					content: [{ type: "tool-result", toolCallId: tr.id, toolName: tr.name, output: typeof tr.output === "string" ? { type: "text", value: tr.output } : { type: "json", value: tr.output } }],
				} as any);
			}
		}

		// Return updated offset
		return toolCallOffset + toolCalls.length;
	}

		/** Extract turn blocks from an assistant message's content parts. */private extractBlocks(msg: ModelMessage): any[] {
		const blocks: any[] = [];
		const content = (msg as any).content;
		if (!Array.isArray(content)) {
			if (typeof content === "string" && content) {
				blocks.push({ type: "text", text: content });
			}
			return blocks;
		}

		// Group tool-call and tool-result pairs
		for (const part of content) {
			if (part.type === "text" && part.text) {
				blocks.push({ type: "text", text: part.text });
			} else if (part.type === "tool-call") {
				// Find matching tool result from subsequent tool messages
				const resultMsg = this.findToolResult(part.toolCallId);
				const result = resultMsg
					? this.extractToolResultText(resultMsg)
					: "";
				blocks.push({
					type: "tool",
					name: part.toolName,
					args: part.input ?? part.args,
					result,
					status: result ? "done" : "error",
					toolCallId: part.toolCallId,
				});
			}
		}
		return blocks;
	}

	/** Find the tool message containing the result for a given toolCallId. */
	private findToolResult(toolCallId: string): ModelMessage | undefined {
		for (const msg of this.messages) {
			if ((msg as any).role !== "tool") continue;
			const parts = (msg as any).content;
			if (!Array.isArray(parts)) continue;
			for (const p of parts) {
				if (p.type === "tool-result" && p.toolCallId === toolCallId) {
					return msg;
				}
			}
		}
		return undefined;
	}

	/** Extract text from a tool-result message's output. */
	private extractToolResultText(msg: ModelMessage): string {
		const parts = (msg as any).content;
		if (!Array.isArray(parts)) return "";
		for (const p of parts) {
			if (p.type === "tool-result") {
				if (typeof p.output === "string") return p.output;
				if (p.output?.type === "text" && typeof p.output.value === "string") return p.output.value;
				if (p.output?.type === "json") return JSON.stringify(p.output.value);
				if (p.output != null) return JSON.stringify(p.output);
			}
		}
		return "";
	}

	reset(): void {
		this.messages = [];
		this.invalidateCalibration();
	}

	calibrateFromActualUsage(actualInputTokens: number): void {
		this.lastActualInputTokens = actualInputTokens;
		this.messageCountAtCalibration = this.messages.length;
	}

	private estimateTokens(): number {
		if (this.lastActualInputTokens !== null) {
			// Use calibrated value + heuristic delta for messages added since last API call
			if (this.messages.length <= this.messageCountAtCalibration) {
				return this.lastActualInputTokens;
			}
			const delta = this.messages.slice(this.messageCountAtCalibration)
				.reduce((sum, msg) => sum + this.estimateMessageTokens(msg), 0);
			return this.lastActualInputTokens + delta;
		}
		return this.messages.reduce((sum, msg) => sum + this.estimateMessageTokens(msg), 0);
	}

	private estimateMessageTokens(msg: ModelMessage): number {
		const json = JSON.stringify(msg);
		return Math.ceil(json.length / 4) + 4;
	}

	private estimateSystemPromptTokens(): number {
		return Math.ceil(this.systemPrompt.length / 4) + 4;
	}

	private invalidateCalibration(): void {
		this.lastActualInputTokens = null;
		this.messageCountAtCalibration = 0;
	}

	/**
	 * Normalize message format for AI SDK compatibility:
	 * 1. Convert args → input (AI SDK v6)
	 * 2. Fix tool-result output format
	 * 3. Strip orphaned tool results (no matching tool-call)
	 * 4. Deduplicate consecutive identical user messages
	 */
	private normalizeMessages(msgs: ModelMessage[]): ModelMessage[] {
		// Pass 1: Collect tool-call IDs
		const toolCallIds = new Set<string>();
		for (const msg of msgs) {
			if (msg.role === "assistant" && Array.isArray((msg as any).content)) {
				for (const part of (msg as any).content) {
					if (part.type === "tool-call") {
						if ("args" in part && !("input" in part)) part.input = part.args;
						if (part.toolCallId) toolCallIds.add(part.toolCallId);
					}
				}
			}
		}

		// Pass 2: Fix tool-result format and strip orphans
		for (const msg of msgs) {
			if ((msg as any).role === "tool" && Array.isArray((msg as any).content)) {
				const kept: any[] = [];
				for (const part of (msg as any).content) {
					if (part.type === "tool-result") {
						if (!part.toolCallId || !toolCallIds.has(part.toolCallId)) {
							// Orphaned — skip entirely to avoid provider errors
							continue;
						}
						if (!part.toolName && part.toolCallId) part.toolName = "unknown";
						if (typeof part.output === "string") {
							part.output = { type: "text", value: part.output };
						} else if (part.output != null && typeof part.output === "object" && !("type" in (part.output as any))) {
							part.output = { type: "json", value: part.output };
						}
						kept.push(part);
					} else {
						kept.push(part);
					}
				}
				(msg as any).content = kept;
			}
		}

		// Pass 3: Remove empty tool messages, deduplicate user messages.
		//
		// steps-overhaul sub-4 连续-role 修正: summaries render as SYSTEM (see
		// assembleLLMView zone 1), so a summary can never collide with the
		// turn-opening user step that follows. But when MULTIPLE summaries
		// exist (multi-topic compression), they appear as back-to-back system
		// messages — some providers reject consecutive system messages too. So
		// we merge consecutive SYSTEM (text-string) messages here. This is the
		// ONLY role we merge: user/assistant messages are left untouched
		// (merging them regresses multimodal assembly, which legitimately
		// produces adjacent same-role parts within one user message).
		const result: ModelMessage[] = [];
		for (const msg of msgs) {
			// Skip empty tool messages
			if ((msg as any).role === "tool") {
				const parts = (msg as any).content;
				if (Array.isArray(parts) && parts.length === 0) continue;
			}

			// Deduplicate consecutive IDENTICAL user messages (drop the dup).
			if (msg.role === "user" && typeof (msg as any).content === "string") {
				const last = result[result.length - 1];
				if (last && last.role === "user" && typeof (last as any).content === "string" && (last as any).content === (msg as any).content) {
					continue;
				}
			}

			// Merge consecutive SYSTEM text-string messages (multiple summary
			// blocks → one consolidated system recap). Strings only; system
			// messages are always text here (they come from renderSummaryText).
			if (msg.role === "system" && typeof (msg as any).content === "string") {
				const last = result[result.length - 1];
				if (last && last.role === "system" && typeof (last as any).content === "string") {
					(last as any).content = `${(last as any).content}\n${(msg as any).content}`;
					continue;
				}
			}

			result.push(msg);
		}

		return result;
	}
}
