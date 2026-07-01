// Agent 循环执行引擎
//
// # 文件说明书
//
// ## 核心功能
// Agent 执行的核心循环，管理消息流、工具调用和状态转换。
//
// ## 输入
// - SessionConfig - 会话配置
// - RuntimeCallbacks - 回调函数（工具调用、状态更新等）
//
// ## 输出
// - StreamEvent - 流式事件（文本、工具调用、错误等）
// - 运行时状态更新
//
// ## 定位
// Agent 执行核心，被 agent-service 调用。
//
// ## 依赖
// - ai - Vercel AI SDK
// - ./types - 类型定义
// - ./provider-factory - 模型解析
// - ./session - 会话管理
// - ./tools - 工具集
// - ../core/logger - 日志
// - ../core/hook-registry - Hook 注册
//
// ## 维护规则
// - 核心执行逻辑变更时需谨慎
// - 保持向后兼容性
//
import { streamText, stepCountIs } from "ai";
import type {
	StreamEvent,
	RuntimeCallbacks,
	RuntimeProviderConfig,
	SessionConfig,
	AgentRuntime,
	RuntimeState,
	ToolExecutionContext,
} from "./types.js";
import { resolveModel, getContextWindow } from "./provider-factory.js";
import { AgentSession } from "./session.js";
import { buildToolsSet } from "./tools/index.js";
import { renderTodosContext } from "./tools/todo-write.js";
import { log } from "../core/logger.js";
import { HookRegistry } from "../core/hook-registry.js";
import { classifyError, isTransientError, userFriendlyMessage, MAX_RETRIES, BASE_DELAY_MS } from "./agent-utils.js";
import { TurnRecorder } from "./turn-recorder.js";
import { SystemPromptAssembler } from "./prompt-sections.js";
import { buildContextMessage } from "./context-message.js";
import { SubagentDelegator } from "./subagent-delegator.js";
import { ToolRateLimiter } from "./tool-rate-limiter.js";
import type { WikiStore } from "../server/wiki-node-store.js";
import {
	resolveAnchors,
	anchorNodeIds,
	renderSystemAnchors,
	renderContextAnchors,
	type ResolvedAnchor,
} from "./wiki-anchor-injection.js";

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

export class AgentLoop implements AgentRuntime {
	private session: AgentSession;
	private config: SessionConfig;
	private providers: RuntimeProviderConfig[];
	private callbacks: RuntimeCallbacks;
	private toolContext: ToolExecutionContext;
	private delegator: SubagentDelegator;
	private promptAssembler: SystemPromptAssembler;
	private abortController: AbortController | null = null;
	private busy = false;
	private streamText = "";
	private thinkingText = "";
	private recorder = new TurnRecorder();
	private resultText = "";
	/** Base seq for the current turn group's assistant steps. */
	private stepBaseSeq = -1;
	/** How many steps have been completed in the current turn group. */
	private stepOffset = 0;
	/**
	 * v0.8 (P1 §10.6): resolved wiki anchors for this session (auto memory +
	 * auto project + free wikiAnchors). Cached at construction; invalidated
	 * by invalidateWikiAnchorCache() when a subtree changes (future hook).
	 */
	private wikiAnchors: ResolvedAnchor[] = [];
	/** v0.8 (P1 §10.6): global WikiStore, resolved from config.wikiStore. */
	private wikiStoreGlobal: WikiStore | null = null;
	/**
	 * Step 1B: this loop's own HookRegistry. Handlers register here (via
	 * registerHooksForLoop, called by agent-service / subagent-delegator right
	 * after the loop is built) and only fire for this loop — no cross-loop
	 * bleed. Exposed readonly so the caller can register the per-kind set.
	 */
	private readonly _registry = new HookRegistry();
	get registry(): HookRegistry { return this._registry; }

	constructor(
		config: SessionConfig,
		providers: RuntimeProviderConfig[],
		callbacks: RuntimeCallbacks,
	) {
		this.config = config;
		this.providers = providers;
		this.callbacks = callbacks;

		const contextWindow = getContextWindow(providers, config.providerName, config.modelId);
		this.session = new AgentSession(config.systemPrompt, contextWindow, config.sessionId, config.db);

		// v0.8 (P1 §10.6): resolve the global WikiStore + the session's wiki
		// anchor set. config.wikiStore is the ProjectWikiStore back-compat
		// view (or already a WikiStore); .getWikiStore() unwraps it.
		this.wikiStoreGlobal = this.resolveGlobalWikiStore(config);

		// Build prompt sections: base + wiki system-anchor section (cacheable).
		const sections = [
			{ name: "base", compute: () => this.session.getSystemPrompt(), cacheBreak: false },
		];
		if (this.wikiStoreGlobal) {
			this.wikiAnchors = resolveAnchors({
				wiki: this.wikiStoreGlobal,
				agentId: config.agentId,
				contextBundle: config.contextBundle,
				wikiAnchors: config.wikiAnchors,
			});
			// system-channel anchors → cached section (refresh only when the
			// caller invalidates it). context-channel anchors are rendered
			// every turn in executeStream → buildContextMessage.
			sections.push({
				name: "wiki-system-anchors",
				compute: () => renderSystemAnchors({ wiki: this.wikiStoreGlobal!, anchors: this.wikiAnchors }),
				cacheBreak: false,
			});
		}
		this.promptAssembler = new SystemPromptAssembler(sections);

		this.delegator = new SubagentDelegator({
			config,
			providers,
			emit: (event) => this.emit(event),
			createSubLoop: (cfg, prov, cb) => new AgentLoop(cfg, prov, cb),
			getToolConfig: () => this.toolContext.toolConfig ?? {},
			// Step 1B: thread per-loop hook deps so delegated sub-loops register
			// their own hook set on their own registry (loopKind="delegated").
			hookDeps: config.hookWiringDeps,
		});

		this.toolContext = {
			workingDir: config.workspaceDir,
			agentId: config.agentId,
			sessionId: config.sessionId,
			emit: (event) => this.emit(event),
			db: config.db,
			readScope: config.toolPolicy.readScope,
			toolConfig: {},
			delegateTask: (task, options) => this.delegator.delegateTask(task, options),
			delegateTaskBackground: (task, options) => this.delegator.delegateTaskBackground(task, options),
			getTaskResult: (taskId) => this.delegator.getTaskResult(taskId),
			listTasks: (filter) => this.delegator.listTasks(filter),
			stopTask: (taskId) => this.delegator.stopTask(taskId),
			requestTaskFinish: (taskId, options) => this.delegator.requestTaskFinish(taskId, options),
			listDelegatedTasks: (filter) => this.delegator.listDelegatedTasks(filter),
			suspendUntilWake: (timeoutMs, taskId) => this.delegator.suspendUntilWake(timeoutMs, taskId),
			runBackground: (command, timeoutSec) => this.delegator.runBackground(command, timeoutSec),
			// Step 2E: tool-call ↔ task link — let the Agent tool stamp the
			// recorder's tool-call block with the delegated taskId the moment
			// the delegator mints it, and expose resumeTask for the parent-side
			// dangling-tool-call re-attach path.
			setToolCallTaskId: (toolCallId, taskId) => {
				this.recorder.setToolBlockTaskId(toolCallId, undefined, taskId);
			},
			resumeTask: (taskId) => this.delegator.resumeTask(taskId),
			rateLimiter: new ToolRateLimiter(),
			// Multi-Agent Workflow context
			wikiStore: (config as any).wikiStore,
			requirementStore: (config as any).requirementStore,
			// v0.8 (M4): PmService handle for PM sessions — backs the
			// CreateRequirementWithDoc tool (PmService.createRequirementWithDoc).
			pmService: (config as any).pmService,
			taskStepStore: (config as any).taskStepStore,
			projectId: config.projectContext?.projectId,
			// v0.8 (读写同界): resolved wiki anchor node ids = read scope = write
			// scope for the Wiki tool. Zero/global sessions include the global
			// root here → whole-tree read+write; project sessions stay scoped.
			wikiAnchorNodeIds: anchorNodeIds(this.wikiAnchors),
			projectPath: config.projectContext?.projectPath,
			activeRequirementId: config.projectContext?.activeRequirementId,
			// v0.8 (M0): createRoleLoop removed — sub-agent dispatch flows
			// through delegateTask (extended signature).
			// v0.8 (M0): session context bundle (D-B) — exposed on the context
			// so workflow tools (and downstream M1 cron / M3 notification) can
			// read the current (projectId, workspaceDir, wikiRootNodeId).
			contextBundle: config.contextBundle,
			// v0.8 (P3): ManagementService handle for the zero role's action tools.
			management: config.management,
			// v0.8 (P2 §11.5): subagents + resolver surfaced so the Orchestrate
			// engine can resolve a DSL `task` node's agentTool name → target
			// agent (replaces retired getAgentToolEntries resolver).
			subagents: config.subagents,
			resolveSubagentTarget: config.resolveSubagentTarget
				? (id) => {
					const t = config.resolveSubagentTarget!(id);
					return t
						? {
							id: t.id,
							name: t.name,
							systemPrompt: t.systemPrompt,
							model: t.model,
							toolPolicy: t.toolPolicy,
						}
						: undefined;
				}
				: undefined,
			// v0.8 (delegation refactor): live agent resolver — passed through
			// so the Agent tool can list/resolve delegation targets fresh.
			resolveAgent: (config as any).resolveAgent,
			// v0.8 (M3): Orchestrate plan/manifest stores for the lead's
			// Orchestrate tool (confirm gate + manifest persistence).
			orchestratePlanStore: (config as any).orchestratePlanStore,
			orchestrateManifestStore: (config as any).orchestrateManifestStore,
			// v0.8 (M3): GitIntegration for the Orchestrate tool's per-task
			// commitStep on the feature worktree (decision 21).
			gitIntegration: (config as any).gitIntegration,
		};
	}

	// ─── Public API ──────────────────────────────────────────────

	async run(userMessage: string): Promise<void> {
		if (this.busy) throw new Error("Agent is already busy");
		log.loop("run() called, msg length:", userMessage.length);

		this.busy = true;
		this.streamText = "";
		this.thinkingText = "";
		this.resultText = "";
		this.recorder.reset();
		this.abortController = new AbortController();
		const timeout = this.setupTimeout();

		try {
			// Step 1C: UserPromptSubmit is deleted (no consumer; the input-gate
			// concern merged into TurnStart). addMessage runs unconditionally.
			this.session.addMessage({ role: "user", content: userMessage });
			this.session.saveToDb();
			await this.session.pruneIfNeeded();

			log.loop("Messages after prune:", this.session.getMessages().length, "est tokens:", this.session.getMessages().reduce((s: number, m: any) => s + Math.ceil(JSON.stringify(m).length / 4), 0));

			await this.triggerLocal("TurnStart", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), userMessage });

			// TurnStart hook has written user turn; next seq is the first assistant step
			if (this.config.db && this.config.sessionId) {
				this.stepBaseSeq = this.config.db.getTurnCount(this.config.sessionId);
			}
			this.stepOffset = 0;

			// Set the turn group (= user message's seq = stepBaseSeq - 1 for non-resume,
			// but TurnStart already wrote the user turn so getTurnCount includes it)
			const userSeq = this.stepBaseSeq - 1;
			this.recorder.startTurnGroup(userSeq);

			await this.runWithRetry();

			// Step 3B: PostTurnComplete was deleted. Its operations moved to
			// StepEnd (compression/extraction/todo evaluate per step) and the
			// token estimate was dropped (real usage flows via the `usage`
			// stream event → metrics-events.ts). The turn boundary is closed by
			// the TurnEnd hook below.

		} finally {
			if (timeout) clearTimeout(timeout);
			this.busy = false;
			this.streamText = "";
			this.delegator.cleanup();

			await this.triggerLocal("TurnEnd", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), resultText: this.resultText, messageCount: this.session.getMessages().length, blocks: this.recorder.blocks.slice() });
			// Step 1C: the empty per-run SessionEnd trigger is deleted (session-
			// lifecycle ownership moved to agent-service: SessionClose fires at
			// loop destroy). TurnEnd closes the turn boundary above.

			this.emit({ type: "agent_end", agentId: this.config.agentId });
		}
	}

	/**
	 * Step 2D: step-level resume. Reads the per-session `lastCompletedStepSeq`
	 * checkpoint and continues from the next step. Completed steps are NOT
	 * re-run: their step rows already live in the turns table (2B's per-tool
	 * immediate persist + StepEnd), and the session rebuilds its messages from
	 * those rows (rebuildFromTurns), so the model sees the full prior work and
	 * simply produces the next step.
	 *
	 * `lastCompletedStepSeq` is informational for this layer — getTurnCount()
	 * already returns the correct next seq (it counts the already-persisted
	 * step rows). The checkpoint is what recovery uses to decide a session had
	 * mid-turn progress (vs a turn that crashed before any step completed) and
	 * to drive UI state. Case 2 (finish-step fired, tools incomplete) is 2E.
	 *
	 * The optional args preserve the legacy `interruptedTurnSeq` shape so
	 * existing callers (recovery) keep working while they migrate.
	 */
	async resume(interruptedTurnSeq?: number, lastCompletedStepSeq?: number): Promise<void> {
		if (this.busy) throw new Error("Agent is already busy");
		log.loop("resume() called, messages:", this.session.getMessages().length,
			"lastCompletedStepSeq:", lastCompletedStepSeq ?? "none");

		this.busy = true;
		this.streamText = "";
		this.thinkingText = "";
		this.resultText = "";
		this.recorder.reset();
		this.abortController = new AbortController();
		const timeout = this.setupTimeout();

		try {
			await this.session.pruneIfNeeded();

			// For resume, the user turn + any completed steps are already in DB.
			// getTurnCount returns the count INCLUDING those, so the next
			// appendStep lands at the correct fresh seq.
			if (this.config.db && this.config.sessionId) {
				this.stepBaseSeq = this.config.db.getTurnCount(this.config.sessionId);
			}
			this.stepOffset = 0;

			await this.triggerLocal("TurnStart", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), userMessage: "(resumed)" });

			// After TurnStart, the turn count may have increased (if hook wrote a turn)
			if (this.config.db && this.config.sessionId) {
				this.stepBaseSeq = this.config.db.getTurnCount(this.config.sessionId);
			}
			const userSeq = this.stepBaseSeq - 1;
			this.recorder.startTurnGroup(userSeq);

			await this.runWithRetry();
		} finally {
			if (timeout) clearTimeout(timeout);
			this.busy = false;
			this.streamText = "";
			this.delegator.cleanup();

			await this.triggerLocal("TurnEnd", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), resultText: this.resultText, messageCount: this.session.getMessages().length, blocks: this.recorder.blocks.slice() });
			// Step 1C: SessionEnd empty trigger deleted (see run() finally).

			this.emit({ type: "agent_end", agentId: this.config.agentId });
		}
	}

	abort(): void {
		this.abortController?.abort();
	}

	getState(): RuntimeState {
		return {
			isBusy: this.busy,
			streamingText: this.streamText,
			toolCalls: this.recorder.getToolCalls() as { name: string; status: "running" | "done" | "error" }[],
		};
	}

	getLoopState(): { isBusy: boolean; recorderBlocks: any[] } {
		return {
			isBusy: this.busy,
			recorderBlocks: this.recorder.blocks.slice(),
		};
	}

	/** Expose session turns for UI rendering — runtime is the single source of truth. */
	getSessionTurns(): Array<{ seq: number; role: string; content: string | null; createdAt: string; turnGroup?: number }> {
		return this.session.getCachedTurns();
	}

	/** Refresh the cached turns from DB before UI session_init. */
	refreshTurnsCache(): void {
		this.session.refreshTurnsCache();
	}

	/** Get the context window for the current session model. */
	getContextWindow(): number {
		return this.session.getContextWindow();
	}

	/** Get estimated token count from restored messages. */
	getEstimatedTokens(): number {
		return this.session.getEstimatedTokens();
	}

	/** Get context usage ratio from restored messages. */
	getContextUsage(): number {
		return this.session.getContextUsage();
	}

	getResult(): string {
		return this.resultText;
	}

	resetSession(): void {
		this.session.reset();
		this.promptAssembler.invalidate();
	}

	/** The agent id this loop is bound to (for agentService config-sync targeting). */
	getConfigAgentId(): string {
		return this.config.agentId;
	}

	/**
	 * v0.8 (delegation refactor): hot-apply an agent-config update to a RUNNING
	 * loop, so edits made via the AgentRegistry tool (or UI) take effect on the
	 * next turn without restarting the session. Safe to call while busy — only
	 * mutates config/cache; the in-flight turn is untouched.
	 *
	 * - systemPrompt → updates the session prompt + invalidates the "base"
	 *   prompt section (cache break is acceptable; this is infrequent).
	 * - toolPolicy / subagents → assigned in place; buildTools() reads them
	 *   fresh every turn, so the next turn picks them up.
	 * - wikiAnchors → re-resolved + injected section invalidated + tool ctx
	 *   anchor ids updated.
	 */
	applyConfigUpdate(patch: {
		systemPrompt?: string;
		toolPolicy?: SessionConfig["toolPolicy"];
		subagents?: SessionConfig["subagents"];
		wikiAnchors?: SessionConfig["wikiAnchors"];
	}): void {
		if (patch.systemPrompt !== undefined && patch.systemPrompt !== this.config.systemPrompt) {
			this.config.systemPrompt = patch.systemPrompt;
			this.session.updateSystemPrompt(patch.systemPrompt);
			this.promptAssembler.invalidate("base");
		}
		if (patch.toolPolicy !== undefined) {
			this.config.toolPolicy = patch.toolPolicy;
		}
		if (patch.subagents !== undefined) {
			this.config.subagents = patch.subagents;
			this.toolContext.subagents = patch.subagents;
		}
		if (patch.wikiAnchors !== undefined && this.wikiStoreGlobal) {
			this.config.wikiAnchors = patch.wikiAnchors;
			this.wikiAnchors = resolveAnchors({
				wiki: this.wikiStoreGlobal,
				agentId: this.config.agentId,
				contextBundle: this.config.contextBundle,
				wikiAnchors: this.config.wikiAnchors,
			});
			this.toolContext.wikiAnchorNodeIds = anchorNodeIds(this.wikiAnchors);
			this.promptAssembler.invalidate("wiki-system-anchors");
		}
	}



	// ─── Retry loop (shared by run and resume) ──────────────────
	//
	// Step 2C: turn-level retry MOVED DOWN to the step level (see executeStream).
	// runWithRetry is now a thin wrapper that invokes executeStream once and
	// handles only whole-turn abort/timeout + the terminal TurnError emit. Per-
	// step transient/prompt_too_long retries live inside executeStream's outer
	// while, so a flaky model call no longer reruns the whole turn.

	private async runWithRetry(): Promise<void> {
		try {
			await this.executeStream();
		} catch (err: any) {
			// Abort (user cancel / turn timeout) is not a failure — emit nothing.
			if (err?.name === "AbortError" || this.abortController?.signal.aborted) return;

			const cls = classifyError(err);
			log.error("loop", "Turn failed (unrecoverable):", cls, err.message?.slice(0, 200));

			// Step 1C: TurnError. Fires with enriched context for partial-work
			// persistence + failure recording. By the time we get here the
			// per-step retry loop has already exhausted its attempts (or hit a
			// fatal error class), so this is the terminal failure path.
			await this.triggerLocal("TurnError", {
				agentId: this.config.agentId,
				sessionId: this.session.getSessionId(),
				error: err?.message,
				errorClass: cls,
				userFriendlyMsg: userFriendlyMessage(cls, err?.message ?? String(err)),
				retryAttempts: MAX_RETRIES + 1,
				blocks: this.recorder.blocks.slice(),
			});
			this.emit({
				type: "error",
				agentId: this.config.agentId,
				error: userFriendlyMessage(cls, err?.message ?? String(err)),
				errorClass: cls,
			});
		}
	}

	// ─── Stream execution (decomposed) ─────────────────────────

	private async executeStream(): Promise<void> {
		const model = resolveModel(this.providers, this.config.providerName, this.config.modelId);

		if (this.config.getToolConfig) {
			this.toolContext.toolConfig = this.config.getToolConfig();
		}

		// These are turn-scoped (not per-step): tools, system prompt, and the
		// context-channel render (wiki anchors / current task / todos) are
		// resolved once per turn. Per-step injection (appendMessages from
		// StepStart / PreLLMCall handlers, providerOptions from PreLLMCall) is
		// merged inside the loop.
		const tools = await this.buildTools();
		const systemPrompt = await this.assembleSystemPrompt();

		// v0.8 (P1 §10.6): render context-channel wiki anchors every turn
		// (system-channel anchors already live in the cached system prompt).
		// v0.8 (P2 §11.6): the memory anchor inside this set is the session
		// agent's per-agent memory subtree index (memory/<agentId>/).
		const wikiAnchorsContext = this.wikiStoreGlobal
			? renderContextAnchors({ wiki: this.wikiStoreGlobal, anchors: this.wikiAnchors })
			: "";

		// v0.8 (P2 §11.7): current-task — the active requirement id (when the
		// session is bound to a project + requirement). Re-evaluated every turn;
		// does not enter message history. Rendered in buildContextMessage under
		// ## Current Task so the model always knows what it is doing right now.
		const currentTask = this.resolveCurrentTask();

		// Step 2C: externalized step loop. Each iteration runs ONE model call
		// via streamText({ stopWhen: stepCountIs(1) }), consumes its events,
		// finalizes it (seal + usage + StepEnd), then appends the step's
		// response.messages to the local conversation and continues only when
		// the model invoked a tool. Transient/prompt_too_long errors retry
		// JUST this step (messages unchanged) up to MAX_RETRIES; fatal errors
		// or exhaustion throw out to runWithRetry for the terminal TurnError.
		// Abort is detected both at the step boundary (signal.aborted) and via
		// the fullStream "abort" event (2A gotcha #2: abort does NOT throw).
		const baseCtx = buildContextMessage({
			workspaceDir: this.config.workspaceDir,
			guidelines: this.config.guidelines,
			wikiAnchorsContext: wikiAnchorsContext || undefined,
			currentTask: currentTask || undefined,
			// Inject the agent's current todo list so it can read its own state
			// across turns (not just write blindly). Renderer lives in todo-write.ts.
			todosContext: renderTodosContext(this.config.sessionId, this.config.agentId) ?? undefined,
		});
		let messages = this.prependContext(this.session.getMessages(), baseCtx);
		// Collect each step's response messages so finalizeStream can persist
		// them into the session at turn end (matches the old addMessage loop).
		const pendingPersist: any[] = [];

		const MAX_STEPS = 200; // guard rail (was stepCountIs(200))
		for (let stepNumber = 1; stepNumber <= MAX_STEPS; stepNumber++) {
			// Abort at the step boundary — never start a new model call after cancel.
			if (this.abortController?.signal.aborted) break;

			// ── StepStart → PreLLMCall: per-step injection seam. ─────────────
			// Both fire per step now. StepStart carries the queued-input /
			// delegated-task control-message injectors (input-queue-hooks,
			// task-control-hooks). PreLLMCall carries RAG / providerOptions /
			// notification injection. appendMessages from EITHER is merged
			// (registry concatenates array-typed results) and applied to this
			// step's outgoing messages only — replaces the retired SDK
			// prepareStep callback.
			const stepStartResult = await this.triggerLocal("StepStart", {
				agentId: this.config.agentId,
				sessionId: this.session.getSessionId(),
				stepNumber,
				messages: messages as Array<{ role: string; content: string }>,
			});
			const stepStartExtra = (stepStartResult.appendMessages as Array<{ role: string; content: string }>) ?? [];

			const preResult = await this.triggerLocal("PreLLMCall", {
				agentId: this.config.agentId,
				sessionId: this.session.getSessionId(),
				session: this.session,
				config: this.config,
				providers: this.providers,
				taskRegistry: this.delegator.taskRegistry,
				// Generic: let hooks surface UI/runtime events (e.g. the todo-cleanup
				// hook emits todos_update([]) to clear the completed list at turn start).
				emit: (event: any) => this.emit(event),
				stepNumber,
			});

			// v0.8 (P2 §11.6): memoryContext is always undefined now — the legacy
			// FTS5 recall hook (registerMemoryHooks) is retired. Memory indexing
			// flows through wikiAnchorsContext above. Kept as a read for forward
			// compatibility (a future semantic-recall hook may repopulate it).
			const memoryContext = preResult.memoryContext as string | undefined;
			const ragContext = preResult.ragContext as string | undefined;
			const providerOptions = (preResult.providerOptions as Record<string, Record<string, any>>) ?? {};
			const preExtra = (preResult.appendMessages as Array<{ role: string; content: string }>) ?? [];

			// First step: fold rag/memory context into the prepared context block
			// (kept as a turn-scoped prefix; subsequent steps reuse the already-
			// prepended baseCtx). We only re-render on step 1 because the block
			// is derived from session config + wiki anchors which are stable
			// within a turn; ragContext/memoryContext hooks may still surface
			// mid-turn, so we re-fold them into the latest user message when
			// present.
			if (stepNumber === 1 || ragContext !== undefined || memoryContext !== undefined) {
				const ctx = buildContextMessage({
					workspaceDir: this.config.workspaceDir,
					guidelines: this.config.guidelines,
					ragContext,
					memoryContext,
					wikiAnchorsContext: wikiAnchorsContext || undefined,
					currentTask: currentTask || undefined,
					todosContext: renderTodosContext(this.config.sessionId, this.config.agentId) ?? undefined,
				});
				if (ctx) {
					messages = this.prependContext(messages, ctx);
				}
			}

			// Apply appendMessages from StepStart + PreLLMCall to this step only.
			const stepMessages = [...messages, ...stepStartExtra, ...preExtra];

			log.debug("loop", "streamText called (step " + stepNumber + "), messages:", stepMessages.length,
				"model:", this.config.providerName + "/" + this.config.modelId,
				"tools:", Object.keys(tools).join(","),
				"lastMsgRole:", stepMessages.at(-1)?.role,
				"injectedMsgs:", stepStartExtra.length + preExtra.length);

			// ── Run one step with per-step retry. ────────────────────────────
			const step = await this.runOneStepWithRetry({
				model,
				system: systemPrompt,
				messages: stepMessages,
				tools,
				providerOptions,
				stepNumber,
			});

			// Abort landed mid-step (fullStream "abort" event, signal set) →
			// break out cleanly without persisting a phantom final step.
			if (step.aborted || this.abortController?.signal.aborted) break;

			// Finalize this step: seal usage + StepEnd persistence.
			await this.finalizeOneStep(step.usage, stepNumber);

			// 2A gotcha #1: result.response is a PromiseLike — await the response
			// first, THEN read .messages. response.messages carries this step's
			// assistant tool-call(s) and/or text so the next streamText sees the
			// full conversation. On a retried step the failed attempt's messages
			// are NOT adopted (runOneStepWithRetry advances messages only on the
			// successful attempt).
			messages = [...messages, ...step.responseMessages];
			pendingPersist.push(...step.responseMessages);

			// No tool call this step → the model produced its final answer; turn done.
			if (!step.hadToolCall) {
				this.resultText = step.text;
				break;
			}
		}

		await this.finalizeStream(pendingPersist);
	}

	private async buildTools(): Promise<Record<string, any>> {
		let mcpTools: Record<string, any> | undefined;
		if (this.config.getMcpTools) {
			try { mcpTools = await this.config.getMcpTools(this.config.agentId); }
			catch { /* MCP tools unavailable */ }
		}
		// v0.8 (delegation refactor): subagent delegation is now the single
		// action-based `Agent` tool (list/delegate-by-name, resolves targets
		// live via ctx.resolveAgent). No per-subagent tools are generated here.
		return buildToolsSet(this.config.toolPolicy, this.toolContext, mcpTools);
	}

	private async assembleSystemPrompt(): Promise<string> {
		const sections = await this.promptAssembler.assemble();
		return sections
			.filter(s => s.text)
			.map(s => s.text)
			.join(String.fromCharCode(10, 10));
	}

	private prependContext(messages: any[], ctx: string | null): any[] {
		if (!ctx) return messages;
		const copy = [...messages];
		const last = copy[copy.length - 1];
		if (last?.role === "user") {
			copy[copy.length - 1] = { ...last, content: ctx + last.content };
		}
		return copy;
	}

	/**
	 * v0.8 (P1 §10.6): resolve the global WikiStore from SessionConfig. The
	 * config carries it as the ProjectWikiStore back-compat view (which wraps
	 * a WikiStore and exposes it via .getWikiStore()); some callers inject a
	 * bare WikiStore. Returns null when no wiki store is configured (legacy
	 * / test paths) — anchor injection is silently skipped in that case.
	 */
	private resolveGlobalWikiStore(config: SessionConfig): WikiStore | null {
		const raw = (config as any).wikiStoreGlobal ?? config.wikiStore;
		if (!raw) return null;
		if (typeof raw.getWikiStore === "function") {
			try { return raw.getWikiStore() as WikiStore; } catch { return null; }
		}
		if (typeof raw.upsertProjectNode === "function" || typeof raw.listVisibleFromAnchors === "function") {
			return raw as WikiStore;
		}
		return null;
	}

	/**
	 * v0.8 (P2 §11.7): resolve the session's current task for the context
	 * block. Source: the active requirement id on the session's project
	 * context. When a RequirementStore is available, the requirement's title
	 * is also pulled so the model sees a human-readable handle. Returns "" when
	 * the session isn't bound to an active requirement (non-project sessions,
	 * global crons, etc.) — buildContextMessage drops the section in that case.
	 *
	 * Re-evaluated every turn (the active requirement may switch mid-session).
	 * Never throws — store lookups are best-effort.
	 */
	private resolveCurrentTask(): string {
		const ctx = this.config.projectContext;
		const reqId = ctx?.activeRequirementId;
		if (!reqId) return "";
		const store = (this.config as any).requirementStore;
		let title: string | undefined;
		try {
			const req = store?.get?.(reqId) ?? store?.getRequirement?.(reqId);
			title = req?.title ?? req?.name;
		} catch { /* best-effort */ }
		const project = ctx?.projectName ? ` (project: ${ctx.projectName})` : "";
		return title
			? `Active requirement: ${title} [${reqId}]${project}`
			: `Active requirement id: ${reqId}${project}`;
	}



	/**
	 * Step 2C: run a single step (one streamText with stopWhen: stepCountIs(1))
	 * with per-step retry on transient / prompt_too_long errors. Throws out to
	 * runWithRetry on fatal error or when retries are exhausted.
	 *
	 * Returns the successful attempt's response messages + usage + text + whether
	 * a tool call happened + an abort flag. NEVER advances the caller's
	 * `messages` on a failed attempt — only the successful attempt's
	 * responseMessages are returned, so a retried step does not replay prior
	 * steps' tool calls (2A gotcha Q3).
	 */
	private async runOneStepWithRetry(opts: {
		model: any;
		system: string;
		messages: any[];
		tools: Record<string, any>;
		providerOptions: Record<string, Record<string, any>>;
		stepNumber: number;
	}): Promise<{
		responseMessages: any[];
		usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
		text: string;
		hadToolCall: boolean;
		aborted: boolean;
	}> {
		let attempt = 0;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			attempt++;
			// On retries (attempt > 1) the previous attempt left partial state in
			// the recorder's current step — discard it so the retried attempt
			// starts clean. (Prior completed steps are preserved.)
			if (attempt > 1) this.recorder.resetCurrentStep();
			// Reset per-attempt streaming accumulators so a retried step does
			// not double-emit stale deltas into the recorder / UI.
			this.streamText = "";
			this.thinkingText = "";

			const result = streamText({
				stopWhen: stepCountIs(1),
				model: opts.model,
				system: opts.system,
				messages: opts.messages,
				tools: opts.tools,
				abortSignal: this.abortController!.signal,
				experimental_context: this.toolContext,
				...(Object.keys(opts.providerOptions).length > 0 ? { providerOptions: opts.providerOptions } : {}),
			});

			let hadToolCall = false;
			let aborted = false;
			let stepUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
			let streamError: Error | undefined;

			try {
				const consumed = await this.processStreamEvents(result, opts.stepNumber);
				hadToolCall = consumed.hadToolCall;
				aborted = consumed.aborted;
				stepUsage = consumed.usage;
				if (consumed.error) streamError = consumed.error;
			} catch (err: any) {
				streamError = err;
			}

			// Abort: never retry, never persist. Surface to the caller to break.
			if (aborted || this.abortController?.signal.aborted) {
				return { responseMessages: [], text: "", hadToolCall: false, aborted: true };
			}

			if (!streamError) {
				// 2A gotcha #1: await result.response (PromiseLike) before reading .messages.
				const response = await result.response;
				const responseMessages = (response?.messages as any[]) ?? [];
				let text = "";
				try { text = await result.text; } catch { /* text unavailable */ }
				return { responseMessages, usage: stepUsage, text, hadToolCall, aborted: false };
			}

			// ── Error path: OnLLMError + per-step retry decision. ──────────
			const errorClass = classifyError(streamError);
			const errMsg = streamError.message ?? String(streamError);

			// OnLLMError handler may request {retry, delayMs} and observe the
			// error class. Default policy is applied below; a handler can
			// override by returning retry:false for a normally-transient class.
			const onErrorResult = await this.triggerLocal("OnLLMError", {
				agentId: this.config.agentId,
				sessionId: this.session.getSessionId(),
				error: errMsg,
				errorClass,
				stepNumber: opts.stepNumber,
				attempt,
			});

			const retryRequested = onErrorResult.retry !== false; // default: retry allowed
			const delayMs = (onErrorResult.delayMs as number | undefined);

			// Determine retryability by error class unless the handler opted out.
			const isFatal = errorClass === "auth" || errorClass === "unknown";
			const isPromptTooLong = errorClass === "prompt_too_long";
			const isTransient = isTransientError(errorClass);

			const canRetry =
				retryRequested &&
				!isFatal &&
				attempt <= MAX_RETRIES &&
				(isTransient || isPromptTooLong);

			if (!canRetry) {
				log.error("loop", `Step ${opts.stepNumber} failed (class=${errorClass}, attempt=${attempt}); giving up.`);
				// Promote to AbortError-neutral: throw so runWithRetry emits TurnError.
				throw streamError;
			}

			// prompt_too_long: shrink the live conversation before retrying this
			// step (operate on opts.messages' source-of-truth = session). The
			// next attempt will see a pruned context. We do NOT advance messages
			// for the failed attempt.
			if (isPromptTooLong) {
				await this.session.aggressivePrune(0.5);
				log.loop("Step " + opts.stepNumber + ": prompt_too_long, aggressive prune before retry.");
			}

			// Backoff for transient classes (handler may override the delay).
			const delay = delayMs ?? (isTransient ? BASE_DELAY_MS * Math.pow(2, attempt - 1) : 0);
			log.loop(`Step ${opts.stepNumber} retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES}, class=${errorClass})`);
			this.emit({
				type: "retry_attempt",
				agentId: this.config.agentId,
				attempt,
				maxAttempts: MAX_RETRIES,
				delayMs: delay,
				errorClass,
			});
			if (delay > 0) await new Promise(r => setTimeout(r, delay));
		}
	}

	/**
	 * Step 2C: consume one step's fullStream. Returns a summary (tool-call flag,
	 * usage from finish-step, abort flag, optional stream error) instead of
	 * mutating step-finalize state inline — that now lives in finalizeOneStep so
	 * a retried step does not seal/persist on its failed attempt.
	 *
	 * 2A gotcha #2: abort emits an "abort" event on fullStream rather than
	 * throwing; we detect it here and stop consuming cleanly.
	 */
	private async processStreamEvents(result: any, stepNumber: number): Promise<{
		hadToolCall: boolean;
		usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
		aborted: boolean;
		error?: Error;
	}> {
		let hadToolCall = false;
		let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
		let aborted = false;

		for await (const event of result.fullStream) {
			// Abort shortcut: stop consuming the moment the signal flips.
			if (this.abortController?.signal.aborted) { aborted = true; break; }

			// 2A gotcha #2: abort surfaces as an event, not a throw.
			if ((event as any).type === "abort") { aborted = true; break; }

			if ((event as any).type === "error") {
				const errEvent = event as any;
				log.error("loop", "Stream error:", errEvent.error?.message ?? JSON.stringify(errEvent));
				return { hadToolCall, usage, aborted: false, error: new Error(errEvent.error?.message ?? "Stream error") };
			}

			switch (event.type) {
				case "text-delta": {
					const text = (event as any).text ?? (event as any).delta ?? "";
					this.streamText += text;
					this.recorder.addTextDelta(text);
					this.emit({ type: "text_delta", agentId: this.config.agentId, text: this.streamText });
					break;
				}
				case "reasoning-delta": {
					const text = (event as any).text ?? (event as any).delta ?? "";
					this.thinkingText += text;
					this.recorder.addThinkingDelta(text);
					this.emit({ type: "thinking_delta", agentId: this.config.agentId, text: this.thinkingText });
					break;
				}
				// [Batch 1] PreToolUse hook — 允许 hook 阻断工具调用
				case "tool-call": {
					const e = event as any;
					hadToolCall = true;
					this.thinkingText = "";
					this.streamText = "";
					log.debug("loop", "Tool call:", e.toolName);
					const tcId = e.toolCallId ?? e.id ?? `tc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
					this.recorder.addToolStart(e.toolName, e.input, tcId);

					const preResult = await this.triggerLocal("PreToolUse", {
						agentId: this.config.agentId,
						sessionId: this.session.getSessionId(),
						toolName: e.toolName,
						args: e.input,
						toolCallId: tcId,
					});
					if (preResult?.blocked) {
						const blockReason = preResult.reason ?? "Blocked by hook";
						this.recorder.updateToolResult(tcId, e.toolName, `Blocked: ${blockReason}`, true);
						this.emit({ type: "tool_end", agentId: this.config.agentId, toolName: e.toolName, toolCallId: tcId, isError: true, result: `Blocked: ${blockReason}` });
						break;
					}

					if (preResult?.modifiedArgs) {
						e.input = preResult.modifiedArgs;
					}

					this.emit({ type: "tool_start", agentId: this.config.agentId, toolName: e.toolName, toolCallId: tcId, args: e.input });
					break;
				}
				// [Batch 1] PostToolUse hook — 工具执行成功后通知
				case "tool-result": {
					const e = event as any;
					log.debug("loop", "Tool result:", e.toolName);
					const resultTcId = e.toolCallId ?? e.id;

					const postResult = await this.triggerLocal("PostToolUse", {
						agentId: this.config.agentId,
						sessionId: this.session.getSessionId(),
						toolName: e.toolName,
						result: e.output,
						isError: false,
						toolCallId: resultTcId,
						// Step 2B: expose recorder + step coords so the per-tool
						// persistence hook can upsert the current step row now,
						// before finish-step (case2 recovery: side effect done but
						// crash before StepEnd → tool result no longer orphaned).
						recorder: this.recorder,
						stepBaseSeq: this.stepBaseSeq,
						stepOffset: this.stepOffset,
					});
					const output = postResult?.modifiedResult !== undefined ? postResult.modifiedResult : e.output;
					const isError = (postResult?.modifiedIsError as boolean | undefined) ?? false;
					this.recorder.updateToolResult(resultTcId, e.toolName, output, isError);
					this.emit({ type: "tool_end", agentId: this.config.agentId, toolName: e.toolName, toolCallId: resultTcId, isError, result: output });
					break;
				}
				// [Batch 1] PostToolUseFailure hook — 工具执行失败后通知
				case "tool-error": {
					const e = event as any;
					log.debug("loop", "Tool error:", e.toolName, e.errorText?.slice(0, 80));
					const errTcId = e.toolCallId ?? e.id;
					let errorStr = String(e.error ?? e.errorText ?? "");

					const failResult = await this.triggerLocal("PostToolUseFailure", {
						agentId: this.config.agentId,
						sessionId: this.session.getSessionId(),
						toolName: e.toolName,
						error: errorStr,
						toolCallId: errTcId,
						// Step 2B: same per-tool persistence seam as PostToolUse —
						// persist the failed tool block (status=error) immediately
						// so a crash before StepEnd still records the failure.
						recorder: this.recorder,
						stepBaseSeq: this.stepBaseSeq,
						stepOffset: this.stepOffset,
					});
					if (failResult?.modifiedError) errorStr = failResult.modifiedError as string;
					this.recorder.updateToolResult(errTcId, e.toolName, errorStr, true);
					this.emit({ type: "tool_end", agentId: this.config.agentId, toolName: e.toolName, toolCallId: errTcId, isError: true, result: errorStr });
					break;
				}
				case "finish-step": {
					// Capture usage for finalizeOneStep. Sealing + StepEnd
					// persistence moved OUT of here so a failed step (which still
					// emits finish-step in some error paths) does not persist.
					const e = event as any;
					usage = e.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
					break;
				}
			}
			// suppress unused-param lint: stepNumber reserved for future PostLLCall.
			void stepNumber;
		}

		return { hadToolCall, usage, aborted };
	}

	/**
	 * Step 2C: finalize ONE successful step. Seals the recorder step with its
	 * usage, calibrates the session token estimate, fires StepEnd (which
	 * persists the step row), and advances the step offset. Mirrors the old
	 * inline finish-step handler, now called once per successful step from the
	 * outer while-loop.
	 */
	private async finalizeOneStep(usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }, stepNumber?: number): Promise<void> {
		if (usage) {
			if (usage.inputTokens) {
				this.session.calibrateFromActualUsage(usage.inputTokens);
			}
			this.emit({
				type: "usage",
				agentId: this.config.agentId,
				usage: {
					inputTokens: usage.inputTokens ?? 0,
					outputTokens: usage.outputTokens ?? 0,
					totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
					cacheReadTokens: (usage as any).cacheReadTokens ?? (usage as any).promptCacheReadTokens,
					cacheWriteTokens: (usage as any).cacheWriteTokens ?? (usage as any).promptCacheWriteTokens,
					reasoningTokens: (usage as any).reasoningTokens,
				},
			});

			this.recorder.sealAndAdvanceStep({
				inputTokens: usage.inputTokens ?? 0,
				outputTokens: usage.outputTokens ?? 0,
				totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
			});

			await this.triggerLocal("StepEnd", {
				agentId: this.config.agentId,
				sessionId: this.session.getSessionId(),
				recorder: this.recorder,
				stepBaseSeq: this.stepBaseSeq,
				stepOffset: this.stepOffset,
				stepNumber,
				usage: {
					inputTokens: usage.inputTokens ?? 0,
					outputTokens: usage.outputTokens ?? 0,
					totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
				},
				// Step 3A: per-step operation surfaces (compression + extraction
				// now evaluate on StepEnd, not PostTurnComplete). session/config/
				// providers mirror the PostTurnComplete shape so migrated handlers
				// run unchanged. contextUsage is read AFTER calibrateFromActualUsage
				// above so it reflects this step's true token impact.
				session: this.session,
				config: this.config,
				providers: this.providers,
				contextUsage: this.session.getContextUsage(),
				// Step 3B: emit surface for StepEnd consumers (todo-cleanup emits
				// todos_update[] when all todos are completed this step).
				emit: (event: any) => this.emit(event),
			});
			this.stepOffset++;
		} else {
			// No usage from this step (some providers omit it). Still seal +
			// persist the step's blocks via StepEnd so the row lands.
			this.recorder.sealStep();
			await this.triggerLocal("StepEnd", {
				agentId: this.config.agentId,
				sessionId: this.session.getSessionId(),
				recorder: this.recorder,
				stepBaseSeq: this.stepBaseSeq,
				stepOffset: this.stepOffset,
				stepNumber,
				// Step 3A: per-step operation surfaces (same as the usage branch).
				session: this.session,
				config: this.config,
				providers: this.providers,
				contextUsage: this.session.getContextUsage(),
				emit: (event: any) => this.emit(event),
			});
			this.stepOffset++;
		}
	}

	private async finalizeStream(pendingPersist: any[]): Promise<void> {
		// Persist the steps' response.messages into the session + DB. Per-step
		// usage calibration already happened in finalizeOneStep; here we just
		// fold the assistant tool-call/tool-result/final-text messages the SDK
		// returned into session.messages and save once. (Resume-level step
		// checkpointing is 2D; this turn-end sync is the same shape as the old
		// finalizeStream addMessage loop.)
		for (const msg of pendingPersist) {
			this.session.addMessage(msg);
		}

		this.session.saveToDb();
		this.emit({ type: "message_end", agentId: this.config.agentId, text: this.resultText, contextUsage: this.session.getContextUsage(), contextWindow: this.session.getContextWindow(), estimatedTokens: this.session.getEstimatedTokens() });
	}

	// ─── Helpers ────────────────────────────────────────────────

	private setupTimeout(): NodeJS.Timeout | null {
		const timeoutMs = this.config.timeoutSec ? this.config.timeoutSec * 1000 : undefined;
		return timeoutMs ? setTimeout(() => { this.abortController?.abort(); }, timeoutMs) : null;
	}



	private emit(event: StreamEvent): void {
		if (this.config.sessionId && !(event as any).sessionId) {
			(event as any).sessionId = this.config.sessionId;
		}
		try {
			this.callbacks.onEvent(event);
		} catch { /* ignore subscriber errors */ }
	}

	/**
	 * Step 1B: trigger a hook on THIS loop's registry. Automatically attaches
	 * `loopKind` (defaulting to "main" when SessionConfig.loopKind is unset,
	 * matching legacy main-loop callers) and `timestamp`, so handlers get a
	 * stable context shape. Step 1C renamed the agent-execution events to the
	 * step-centric set (TurnStart/TurnEnd/TurnError/StepStart/StepEnd + the
	 * kept PreLLMCall/PostTurnComplete/Tool*). Session-level SessionStart/
	 * SessionClose are fired by agent-service, NOT here (AgentLoop has no
	 * per-instance lifecycle hooks of its own).
	 */
	private async triggerLocal(event: import("../core/hook-types.js").HookEventName, ctx: Record<string, unknown>): Promise<import("../core/hook-registry.js").AggregatedHookResult> {
		return this._registry.trigger(event, {
			...ctx,
			loopKind: this.config.loopKind ?? "main",
			timestamp: Date.now(),
		});
	}
}
