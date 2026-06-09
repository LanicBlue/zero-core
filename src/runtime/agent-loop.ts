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
import { CheckpointManager } from "./checkpoint-manager.js";
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
	private checkpoint: CheckpointManager;
	private promptAssembler: SystemPromptAssembler;
	private abortController: AbortController | null = null;
	private busy = false;
	private streamText = "";
	private thinkingText = "";
	private recorder = new TurnRecorder();
	private resultText = "";

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

		this.checkpoint = new CheckpointManager(config.db);

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
		this.checkpoint.reset();
		this.abortController = new AbortController();
		const timeout = this.setupTimeout();

		try {
			this.session.addMessage({ role: "user", content: userMessage });
			this.session.saveToDb();
			this.session.pruneIfNeeded();

			log.loop("Messages after prune:", this.session.getMessages().length, "est tokens:", this.session.getMessages().reduce((s: number, m: any) => s + Math.ceil(JSON.stringify(m).length / 4), 0));

			this.checkpoint.saveUserTurn(this.session.getSessionId(), this.recorder, userMessage);

			await triggerHooks("UserPromptSubmit", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), message: userMessage });
			await triggerHooks("SessionStart", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), userMessage });

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

			await triggerHooks("Stop", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), resultText: this.resultText, messageCount: this.session.getMessages().length });
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
		this.checkpoint.reset();
		this.checkpoint.loadResumedTurns(this.session.getSessionId(), this.recorder, interruptedTurnSeq);
		this.abortController = new AbortController();
		const timeout = this.setupTimeout();

		try {
			this.session.pruneIfNeeded();
			await triggerHooks("SessionStart", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), userMessage: "(resumed)" });
			await this.runWithRetry();
		} finally {
			if (timeout) clearTimeout(timeout);
			this.busy = false;
			this.streamText = "";
			this.delegator.cleanup();

			await triggerHooks("Stop", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), resultText: this.resultText, messageCount: this.session.getMessages().length });
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

				this.checkpoint.deletePartialTurn(this.session.getSessionId());
				this.recorder.reset();

				if (cls === "prompt_too_long") {
					this.session.aggressivePrune(0.5);
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
			await triggerHooks("StopFailure", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), error: lastError?.message, errorClass: cls });
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
		log.debug("loop", "Model resolved:", this.config.providerName, this.config.modelId);

		this.checkpoint.resetStreamState();

		if (this.config.getToolConfig) {
			this.toolContext.toolConfig = this.config.getToolConfig();
		}

		const tools = await this.buildTools();
		const systemPrompt = await this.assembleSystemPrompt();
		this.injectTaskNotifications();

		// Build ephemeral context message via PreLLMCall hooks (memory recall, RAG, etc.)
		const hookCtx: Record<string, unknown> = {
			agentId: this.config.agentId,
			sessionId: this.session.getSessionId(),
			session: this.session,
			config: this.config,
			providers: this.providers,
			ragContext: undefined as string | undefined,
			memoryContext: undefined as string | undefined,
		};
		await triggerHooks("PreLLMCall", hookCtx);

		const ctx = buildContextMessage({
			workspaceDir: this.config.workspaceDir,
			guidelines: this.config.guidelines,
			ragContext: hookCtx.ragContext as string | undefined,
			memoryContext: hookCtx.memoryContext as string | undefined,
		});
		const messages = this.prependContext(this.session.getMessages(), ctx);

		const providerOptions = this.buildProviderOptions();

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

	private injectTaskNotifications(): void {
		const completedTasks = this.delegator.taskRegistry.getCompletedUnnotified();
		if (completedTasks.length === 0) return;
		const notifications = completedTasks.map((t) => {
			this.delegator.taskRegistry.markNotified(t.id);
			const r = t.result && t.result.length > 2000 ? t.result.slice(0, 2000) + "..." : t.result;
			const lines = [
				"<task-notification>",
				"<task_id>" + t.id + "</task_id>",
				"<status>" + t.status + "</status>",
				"<task>" + t.task + "</task>",
			];
			if (r) lines.push("<result>" + r + "</result>");
			if (t.error) lines.push("<error>" + t.error + "</error>");
			lines.push("</task-notification>");
			return lines.join(String.fromCharCode(10));
		});
		this.session.addMessage({ role: "user", content: notifications.join(String.fromCharCode(10, 10)) });
	}

	private buildProviderOptions(): Record<string, Record<string, any>> {
		const providerOptions: Record<string, Record<string, any>> = {};
		if (this.config.thinkingLevel && this.config.thinkingLevel !== "none") {
			const budgetTokens = ({ low: 4096, medium: 16384, high: 32768 } as Record<string, number>)[this.config.thinkingLevel] ?? 16384;
			providerOptions.anthropic = { thinking: { type: "enabled", budgetTokens } };
		}
		return providerOptions;
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
				case "tool-call": {
					const e = event as any;
					this.recorder.sealStep();
					this.thinkingText = "";
					this.streamText = "";
					log.debug("loop", "Tool call:", e.toolName);
					const tcId = e.toolCallId ?? e.id ?? `tc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
					this.checkpoint.recordToolCall(tcId, e.toolName, e.input);
					this.recorder.blocks.push({ type: "tool", name: e.toolName, status: "running", args: e.input, toolCallId: tcId });
					this.emit({ type: "tool_start", agentId: this.config.agentId, toolName: e.toolName, toolCallId: tcId, args: e.input });
					break;
				}
				case "tool-result": {
					const e = event as any;
					log.debug("loop", "Tool result:", e.toolName);
					const resultTcId = e.toolCallId ?? e.id;
					const tb = resultTcId
						? [...this.recorder.blocks].reverse().find((b: any) => b.type === "tool" && b.toolCallId === resultTcId)
						: [...this.recorder.blocks].reverse().find((b: any) => b.type === "tool" && b.name === e.toolName && b.status === "running");
					if (tb) { tb.status = "done"; tb.result = e.output; }
					this.emit({ type: "tool_end", agentId: this.config.agentId, toolName: e.toolName, toolCallId: resultTcId, isError: false, result: e.output });
					if (resultTcId) this.checkpoint.saveIncrementalCheckpoint(this.session.getSessionId(), this.recorder, this.session.getMessages(), resultTcId, e.output);
					break;
				}
				case "tool-error": {
					const e = event as any;
					log.debug("loop", "Tool error:", e.toolName, e.errorText?.slice(0, 80));
					const errTcId = e.toolCallId ?? e.id;
					const tb = errTcId
						? [...this.recorder.blocks].reverse().find((b: any) => b.type === "tool" && b.toolCallId === errTcId)
						: [...this.recorder.blocks].reverse().find((b: any) => b.type === "tool" && b.name === e.toolName && b.status === "running");
					if (tb) { tb.status = "error"; tb.result = String(e.error ?? e.errorText ?? ""); }
					this.emit({ type: "tool_end", agentId: this.config.agentId, toolName: e.toolName, toolCallId: errTcId, isError: true, result: String(e.error ?? e.errorText ?? "") });
					if (errTcId) this.checkpoint.saveIncrementalCheckpoint(this.session.getSessionId(), this.recorder, this.session.getMessages(), errTcId, String(e.error ?? e.errorText ?? ""));
					break;
				}
			}
		}
	}

	private async finalizeStream(result: any): Promise<void> {
		this.resultText = await result.text;

		try {
			const usage = await result.usage;
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
			}
		} catch { /* usage not available for some providers */ }

		this.recorder.sealStep();
		this.checkpoint.saveAssistantTurn(this.session.getSessionId(), this.recorder);

		const response = await result.response;
		if (response.messages) {
			for (const msg of response.messages) {
				this.session.addMessage(msg);
			}
		}
		this.session.saveToDb();
		this.emit({ type: "message_end", agentId: this.config.agentId, text: this.resultText });
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
