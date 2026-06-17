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
import { buildAgentTools } from "./tools/agent-tool.js";
import { log } from "../core/logger.js";
import { triggerHooks } from "../core/hook-registry.js";
import { classifyError, isTransientError, userFriendlyMessage, MAX_RETRIES, BASE_DELAY_MS } from "./agent-utils.js";
import { TurnRecorder } from "./turn-recorder.js";
import { SystemPromptAssembler } from "./prompt-sections.js";
import { buildContextMessage } from "./context-message.js";
import { SubagentDelegator } from "./subagent-delegator.js";
import { ToolRateLimiter } from "./tool-rate-limiter.js";

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

		this.promptAssembler = new SystemPromptAssembler([
			{ name: "base", compute: () => this.session.getSystemPrompt(), cacheBreak: false },
		]);

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
			agentRole: config.agentRole,
			projectPath: config.projectContext?.projectPath,
			activeRequirementId: config.projectContext?.activeRequirementId,
			// v0.8 (M0): createRoleLoop removed — sub-agent dispatch flows
			// through delegateTask (extended signature).
			// v0.8 (M0): session context bundle (D-B) — exposed on the context
			// so workflow tools (and downstream M1 cron / M3 notification) can
			// read the current (projectId, workspaceDir, wikiRootNodeId).
			contextBundle: config.contextBundle,
			// v0.8 (M0): ZeroAdminService handle for the zero role's tools.
			zeroAdmin: config.zeroAdmin,
			// v0.8 (M3): surface the agent-tool resolver so Orchestrate can
			// dispatch DSL task nodes by user-facing agent-tool name.
			getAgentToolEntries: config.getAgentToolEntries,
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
		});

		const memoryContext = preResult.memoryContext as string | undefined;
		const ragContext = preResult.ragContext as string | undefined;
		const providerOptions = (preResult.providerOptions as Record<string, Record<string, any>>) ?? {};

		const ctx = buildContextMessage({
			workspaceDir: this.config.workspaceDir,
			guidelines: this.config.guidelines,
			ragContext,
			memoryContext,
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
		let agentTools: Record<string, any> | undefined;
		if (this.config.getAgentToolEntries) {
			try {
				const { entries, agents } = await this.config.getAgentToolEntries();
				agentTools = buildAgentTools(entries, agents, this.toolContext);
			} catch { /* agent tools unavailable */ }
		}
		return buildToolsSet(this.config.toolPolicy, this.toolContext, mcpTools, agentTools);
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
