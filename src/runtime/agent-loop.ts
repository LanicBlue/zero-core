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
import { triggerHooks } from "../core/hook-registry.js";
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
			suspendUntilWake: (timeoutMs, taskId) => this.delegator.suspendUntilWake(timeoutMs, taskId),
			runBackground: (command, timeoutSec) => this.delegator.runBackground(command, timeoutSec),
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
			agentRole: config.agentRole,
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
			// [Batch 4] UserPromptSubmit hook fires BEFORE addMessage,
			// allowing consumers to audit/filter the message
			await triggerHooks("UserPromptSubmit", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), message: userMessage });

			this.session.addMessage({ role: "user", content: userMessage });
			this.session.saveToDb();
			await this.session.pruneIfNeeded();

			log.loop("Messages after prune:", this.session.getMessages().length, "est tokens:", this.session.getMessages().reduce((s: number, m: any) => s + Math.ceil(JSON.stringify(m).length / 4), 0));

			await triggerHooks("SessionStart", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), userMessage });

			// SessionStart hook has written user turn; next seq is the first assistant step
			if (this.config.db && this.config.sessionId) {
				this.stepBaseSeq = this.config.db.getTurnCount(this.config.sessionId);
			}
			this.stepOffset = 0;

			// Set the turn group (= user message's seq = stepBaseSeq - 1 for non-resume,
			// but SessionStart already wrote the user turn so getTurnCount includes it)
			const userSeq = this.stepBaseSeq - 1;
			this.recorder.startTurnGroup(userSeq);

			await this.runWithRetry();

			await triggerHooks("PostTurnComplete", {
				agentId: this.config.agentId,
				sessionId: this.session.getSessionId(),
				session: this.session,
				config: this.config,
				providers: this.providers,
				contextUsage: this.session.getContextUsage(),
				resultText: this.resultText,
				emit: (event: any) => this.emit(event),
			});

		} finally {
			if (timeout) clearTimeout(timeout);
			this.busy = false;
			this.streamText = "";
			this.delegator.cleanup();

			await triggerHooks("Stop", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), resultText: this.resultText, messageCount: this.session.getMessages().length, blocks: this.recorder.blocks.slice() });
			await triggerHooks("SessionEnd", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), resultText: this.resultText });

			this.emit({ type: "agent_end", agentId: this.config.agentId });
		}
	}

	async resume(interruptedTurnSeq?: number): Promise<void> {
		if (this.busy) throw new Error("Agent is already busy");
		log.loop("resume() called, messages:", this.session.getMessages().length);

		this.busy = true;
		this.streamText = "";
		this.thinkingText = "";
		this.resultText = "";
		this.recorder.reset();
		this.abortController = new AbortController();
		const timeout = this.setupTimeout();

		try {
			await this.session.pruneIfNeeded();

			// For resume, the user turn is already in DB
			if (this.config.db && this.config.sessionId) {
				this.stepBaseSeq = this.config.db.getTurnCount(this.config.sessionId);
			}
			this.stepOffset = 0;

			await triggerHooks("SessionStart", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), userMessage: "(resumed)" });

			// After SessionStart, the turn count may have increased (if hook wrote a turn)
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

			await triggerHooks("Stop", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), resultText: this.resultText, messageCount: this.session.getMessages().length, blocks: this.recorder.blocks.slice() });
			await triggerHooks("SessionEnd", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), resultText: this.resultText });

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
		return this.session.getTurns();
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

	private async runWithRetry(): Promise<void> {
		let lastError: any;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				await this.executeStream();
				return;
			} catch (err: any) {
				lastError = err;
				if (err.name === "AbortError" || this.abortController?.signal.aborted) break;

				const cls = classifyError(err);
				log.error("loop", "Attempt " + (attempt + 1) + " failed:", cls, err.message?.slice(0, 200));

				this.recorder.reset();

				if (cls === "prompt_too_long") {
					await this.session.aggressivePrune(0.5);
					log.loop("Context too long, aggressive prune. Messages:", this.session.getMessages().length);
					if (attempt < 1) continue;
				}

				if (!isTransientError(cls) || attempt === MAX_RETRIES) break;

				const delay = BASE_DELAY_MS * Math.pow(2, attempt);
				log.loop("Retrying in " + delay + "ms (attempt " + (attempt + 1) + "/" + MAX_RETRIES + ")");
				this.emit({
					type: "retry_attempt",
					agentId: this.config.agentId,
					attempt: attempt + 1,
					maxAttempts: MAX_RETRIES,
					delayMs: delay,
					errorClass: cls,
				});
				await new Promise(r => setTimeout(r, delay));
			}
		}

		if (lastError && !(lastError.name === "AbortError" || this.abortController?.signal.aborted)) {
			const cls = classifyError(lastError);
			log.error("loop", "All retries exhausted:", cls, lastError.message);
			// [Batch 4] StopFailure with enriched context
			await triggerHooks("StopFailure", {
				agentId: this.config.agentId,
				sessionId: this.session.getSessionId(),
				error: lastError?.message,
				errorClass: cls,
				userFriendlyMsg: userFriendlyMessage(cls, lastError.message),
				retryAttempts: MAX_RETRIES + 1,
				blocks: this.recorder.blocks.slice(),
			});
			this.emit({
				type: "error",
				agentId: this.config.agentId,
				error: userFriendlyMessage(cls, lastError.message),
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

		const tools = await this.buildTools();
		const systemPrompt = await this.assembleSystemPrompt();

		// PreLLMCall: aggregate notification + memory + rag + providerOptions
		const preResult = await triggerHooks("PreLLMCall", {
			agentId: this.config.agentId,
			sessionId: this.session.getSessionId(),
			session: this.session,
			config: this.config,
			providers: this.providers,
			taskRegistry: this.delegator.taskRegistry,
			// Generic: let hooks surface UI/runtime events (e.g. the todo-cleanup
			// hook emits todos_update([]) to clear the completed list at turn start).
			emit: (event: any) => this.emit(event),
		});

		// v0.8 (P2 §11.6): memoryContext is always undefined now — the legacy
		// FTS5 recall hook (registerMemoryHooks) is retired. Memory indexing
		// flows through wikiAnchorsContext below (per-agent memory subtree).
		// Kept as a read for forward compatibility (a future semantic-recall
		// hook may repopulate it).
		const memoryContext = preResult.memoryContext as string | undefined;
		const ragContext = preResult.ragContext as string | undefined;
		const providerOptions = (preResult.providerOptions as Record<string, Record<string, any>>) ?? {};

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

		const ctx = buildContextMessage({
			workspaceDir: this.config.workspaceDir,
			guidelines: this.config.guidelines,
			ragContext,
			memoryContext,
			wikiAnchorsContext: wikiAnchorsContext || undefined,
			currentTask: currentTask || undefined,
			// Inject the agent's current todo list so it can read its own state
			// across turns (not just write blindly). Renderer lives in todo-write.ts.
			todosContext: renderTodosContext(this.config.agentId) ?? undefined,
		});
		const messages = this.prependContext(this.session.getMessages(), ctx);

		log.debug("loop", "streamText called, messages:", messages.length,
			"model:", this.config.providerName + "/" + this.config.modelId,
			"tools:", Object.keys(tools).join(","),
			"lastMsgRole:", messages.at(-1)?.role,
			"hasContext:", !!ctx);

		const result = streamText({
			stopWhen: stepCountIs(200),
			model,
			system: systemPrompt,
			messages,
			tools,
			abortSignal: this.abortController!.signal,
			experimental_context: this.toolContext,
			...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
		});

		await this.processStreamEvents(result);
		await this.finalizeStream(result);
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



	private async processStreamEvents(result: any): Promise<void> {
		for await (const event of result.fullStream) {
			if (!this.busy && this.abortController?.signal.aborted) break;

			if ((event as any).type === "error") {
				const errEvent = event as any;
				log.error("loop", "Stream error:", errEvent.error?.message ?? JSON.stringify(errEvent));
				throw new Error(errEvent.error?.message ?? "Stream error");
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
					this.thinkingText = "";
					this.streamText = "";
					log.debug("loop", "Tool call:", e.toolName);
					const tcId = e.toolCallId ?? e.id ?? `tc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
					this.recorder.addToolStart(e.toolName, e.input, tcId);

					const preResult = await triggerHooks("PreToolUse", {
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

					const postResult = await triggerHooks("PostToolUse", {
						agentId: this.config.agentId,
						sessionId: this.session.getSessionId(),
						toolName: e.toolName,
						result: e.output,
						isError: false,
						toolCallId: resultTcId,
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

					const failResult = await triggerHooks("PostToolUseFailure", {
						agentId: this.config.agentId,
						sessionId: this.session.getSessionId(),
						toolName: e.toolName,
						error: errorStr,
						toolCallId: errTcId,
					});
					if (failResult?.modifiedError) errorStr = failResult.modifiedError as string;
					this.recorder.updateToolResult(errTcId, e.toolName, errorStr, true);
					this.emit({ type: "tool_end", agentId: this.config.agentId, toolName: e.toolName, toolCallId: errTcId, isError: true, result: errorStr });
					break;
				}
				case "finish-step": {
					const e = event as any;
					const stepUsage = e.usage;
					if (stepUsage) {
						if (stepUsage.inputTokens) {
							this.session.calibrateFromActualUsage(stepUsage.inputTokens);
						}
						this.emit({
							type: "usage",
							agentId: this.config.agentId,
							usage: {
								inputTokens: stepUsage.inputTokens ?? 0,
								outputTokens: stepUsage.outputTokens ?? 0,
								totalTokens: (stepUsage.inputTokens ?? 0) + (stepUsage.outputTokens ?? 0),
								cacheReadTokens: (stepUsage as any).cacheReadTokens ?? (stepUsage as any).promptCacheReadTokens,
								cacheWriteTokens: (stepUsage as any).cacheWriteTokens ?? (stepUsage as any).promptCacheWriteTokens,
								reasoningTokens: (stepUsage as any).reasoningTokens,
							},
						});

						// Seal the step, attach usage, persist as individual step row
						this.recorder.sealAndAdvanceStep({
							inputTokens: stepUsage.inputTokens ?? 0,
							outputTokens: stepUsage.outputTokens ?? 0,
							totalTokens: (stepUsage.inputTokens ?? 0) + (stepUsage.outputTokens ?? 0),
						});

						// Persist all completed steps via PostStep hook
						await triggerHooks("PostStep", {
							agentId: this.config.agentId,
							sessionId: this.session.getSessionId(),
							recorder: this.recorder,
							stepBaseSeq: this.stepBaseSeq,
							stepOffset: this.stepOffset,
							usage: {
								inputTokens: stepUsage.inputTokens ?? 0,
								outputTokens: stepUsage.outputTokens ?? 0,
								totalTokens: (stepUsage.inputTokens ?? 0) + (stepUsage.outputTokens ?? 0),
							},
						});
						this.stepOffset++;
					}
					break;
				}
			}
		}
	}

	private async finalizeStream(result: any): Promise<void> {
		this.resultText = await result.text;

		try {
			const usage = await result.usage;
			if (usage?.inputTokens) {
				this.session.calibrateFromActualUsage(usage.inputTokens);
			}
		} catch { /* usage not available for some providers */ }

		this.recorder.sealStep();
		// Final persist for any remaining blocks via PostStep hook
		await triggerHooks("PostStep", {
			agentId: this.config.agentId,
			sessionId: this.session.getSessionId(),
			recorder: this.recorder,
			stepBaseSeq: this.stepBaseSeq,
			stepOffset: this.stepOffset,
		});

		const response = await result.response;
		if (response.messages) {
			for (const msg of response.messages) {
				this.session.addMessage(msg);
			}
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
}
