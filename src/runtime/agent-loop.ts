import { streamText, stepCountIs } from "ai";
import type {
	ModelMessage,
	StreamEvent,
	RuntimeCallbacks,
	RuntimeProviderConfig,
	SessionConfig,
	AgentRuntime,
	RuntimeState,
	ToolExecutionContext,
	ErrorClass,
} from "./types.js";
import { resolveModel, getContextWindow } from "./provider-factory.js";
import { AgentSession } from "./session.js";
import { buildToolsSet, buildToolPolicyDescription } from "./tools/index.js";
import type { SessionDB } from "../server/session-db.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyError(err: any): ErrorClass {
	const msg = (err?.message ?? String(err)).toLowerCase();
	const status = err?.status ?? err?.statusCode;

	if (err?.name === "AbortError") return "timeout";
	if (/timeout|timed out|abort/i.test(msg)) return "timeout";
	if (status === 429 || /rate.?limit|too many requests/i.test(msg)) return "rate_limit";
	if (status === 401 || status === 403 || /unauthorized|invalid.?api.?key|forbidden/i.test(msg)) return "auth";
	if (/context.*(length|window|too.?long|exceed)|prompt.?too.?long/i.test(msg)) return "prompt_too_long";
	if (status >= 500) return "server_error";
	if (/econnrefused|enotfound|econnreset|fetch.*failed|network/i.test(msg) || /ECONNREFUSED|ENOTFOUND|ECONNRESET/.test(err?.code ?? "")) return "network";
	return "unknown";
}

function isTransientError(cls: ErrorClass): boolean {
	return cls === "timeout" || cls === "rate_limit" || cls === "server_error" || cls === "network";
}

function userFriendlyMessage(cls: ErrorClass, raw: string): string {
	switch (cls) {
		case "timeout": return "请求超时，服务器响应时间过长。";
		case "rate_limit": return "请求频率过高，已被限流。请稍后重试。";
		case "server_error": return "服务器出错，请稍后重试。";
		case "auth": return "认证失败，请在设置中检查 API Key。";
		case "network": return "网络错误，请检查网络连接。";
		case "prompt_too_long": return "消息过长，超出模型上下文窗口限制。";
		default: return raw.length > 200 ? raw.slice(0, 200) + "..." : raw;
	}
}

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

function parseThinkingTags(text: string): any[] {
	if (!text) return [];
	const result: any[] = [];
	let remaining = text;
	// Strip leading newlines
	while (remaining.charCodeAt(0) === 10) remaining = remaining.substring(1);
	while (remaining) {
		const openIdx = remaining.indexOf("<think");
		if (openIdx === -1) {
			if (remaining) { let r = remaining; while (r.charCodeAt(r.length - 1) === 10) r = r.substring(0, r.length - 1); if (r) result.push({ type: "text", text: r }); }
			break;
		}
		if (openIdx > 0) { let before = remaining.substring(0, openIdx); while (before.charCodeAt(0) === 10) before = before.substring(1); while (before.charCodeAt(before.length - 1) === 10) before = before.substring(0, before.length - 1); if (before) result.push({ type: "text", text: before }); }
		const tagEnd = remaining.indexOf(">", openIdx);
		if (tagEnd === -1) { result.push({ type: "text", text: remaining }); break; }
		const closeIdx = remaining.indexOf("</think", tagEnd);
		if (closeIdx === -1) {
			let t = remaining.substring(tagEnd + 1);
			if (t.charCodeAt(0) === 10) t = t.substring(1);
			result.push({ type: "thinking", text: t });
			break;
		}
		let t = remaining.substring(tagEnd + 1, closeIdx);
		if (t.charCodeAt(0) === 10) t = t.substring(1);
		if (t.charCodeAt(t.length - 1) === 10) t = t.substring(0, t.length - 1);
		result.push({ type: "thinking", text: t });
		const closeEnd = remaining.indexOf(">", closeIdx);
		let after = closeEnd !== -1 ? remaining.substring(closeEnd + 1) : "";
		if (after.charCodeAt(0) === 10) after = after.substring(1);
		remaining = after;
	}
	return result;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class AgentLoop implements AgentRuntime {
	private session: AgentSession;
	private config: SessionConfig;
	private providers: RuntimeProviderConfig[];
	private callbacks: RuntimeCallbacks;
	private db: SessionDB | null = null;
	private toolContext: ToolExecutionContext;
	private abortController: AbortController | null = null;
	private busy = false;
	private streamText = "";
	private thinkingText = "";
	private currentStepThinking = "";
	private currentStepText = "";
	private turnBlocks: any[] = [];
	private resultText = "";

	constructor(
		config: SessionConfig,
		providers: RuntimeProviderConfig[],
		callbacks: RuntimeCallbacks,
		db?: SessionDB,
	) {
		this.config = config;
		this.providers = providers;
		this.callbacks = callbacks;
		this.db = db ?? null;

		const contextWindow = getContextWindow(providers, config.providerName, config.modelId);
		this.session = new AgentSession(config.systemPrompt, contextWindow, db, config.sessionId);

		const capturedProviders = providers;
		const capturedConfig = config;

		this.toolContext = {
			workingDir: config.workspaceDir,
			agentId: config.agentId,
			emit: (event) => this.emit(event),
			readScope: config.toolPolicy.readScope,
			delegateTask: async (task, options) => {
				const subConfig: SessionConfig = {
					...capturedConfig,
					agentId: `${capturedConfig.agentId}:sub-${Date.now()}`,
					systemPrompt: options?.systemPrompt ?? capturedConfig.systemPrompt,
					modelId: options?.model ?? capturedConfig.modelId,
					maxSteps: 20,
				};
				const subLoop = new AgentLoop(subConfig, capturedProviders, {
					onEvent: () => {},
				});
				await subLoop.run(task);
				return subLoop.getResult();
			},
		};
	}

	async run(userMessage: string): Promise<void> {
		if (this.busy) throw new Error("Agent is already busy");
		log.loop("run() called, msg length:", userMessage.length);

		this.busy = true;
		this.streamText = "";
		this.thinkingText = "";
		this.currentStepThinking = "";
		this.resultText = "";
		this.currentStepText = "";
		this.turnBlocks = [];
		this.abortController = new AbortController();
		const timeout = setTimeout(() => {
			this.abortController?.abort();
		}, 180_000);

		try {
			this.session.addMessage({ role: "user", content: userMessage });
			this.session.saveToDb();
			this.session.pruneIfNeeded();

			// Store user turn
			this.saveUserTurn(userMessage);

			let lastError: any;
			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				try {
					await this.executeStream();
					return;
				} catch (err: any) {
					lastError = err;
					if (err.name === "AbortError" || this.abortController?.signal.aborted) break;

					const cls = classifyError(err);
					log.debug("loop", "Attempt " + (attempt + 1) + " failed:", cls, err.message?.slice(0, 120));
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

			// All retries exhausted or non-transient error
			if (lastError && !(lastError.name === "AbortError" || this.abortController?.signal.aborted)) {
				const cls = classifyError(lastError);
				log.error("loop", "All retries exhausted:", cls, lastError.message);
				this.emit({
					type: "error",
					agentId: this.config.agentId,
					error: userFriendlyMessage(cls, lastError.message),
					errorClass: cls,
				});
			}
		} finally {
			clearTimeout(timeout);
			this.busy = false;
			this.streamText = "";

			this.emit({ type: "agent_end", agentId: this.config.agentId });
		}
	}

	private async executeStream(): Promise<void> {
		const model = resolveModel(this.providers, this.config.providerName, this.config.modelId);
		log.debug("loop", "Model resolved:", this.config.providerName, this.config.modelId);

		let mcpTools: Record<string, any> | undefined;
		if (this.config.getMcpTools) {
			try { mcpTools = await this.config.getMcpTools(this.config.agentId); }
			catch { /* MCP tools unavailable */ }
		}
		let builtInTools: Record<string, any> | undefined;
		if (this.config.getBuiltInTools) {
			try { builtInTools = this.config.getBuiltInTools(); } catch { /* built-in tools unavailable */ }
		}

		const tools = buildToolsSet(this.config.toolPolicy, this.toolContext, mcpTools, builtInTools);
		const toolPolicyDesc = buildToolPolicyDescription(this.config.toolPolicy);
		let systemPrompt = this.session.getSystemPrompt() + "\n\n## Tool Permissions\n\n" + toolPolicyDesc;

		if (this.config.getRagContext) {
			try {
				const ragContext = await this.config.getRagContext(this.config.agentId, "");
				if (ragContext) systemPrompt += "\n\n" + ragContext;
			} catch { /* RAG context unavailable */ }
		}

		const providerOptions: Record<string, Record<string, any>> = {};
		if (this.config.thinkingLevel && this.config.thinkingLevel !== "none") {
			const budgetTokens = ({ low: 4096, medium: 16384, high: 32768 } as Record<string, number>)[this.config.thinkingLevel] ?? 16384;
			providerOptions.anthropic = { thinking: { type: "enabled", budgetTokens } };
		}

		log.debug("loop", "Starting streamText...");
		const result = streamText({
			model,
			system: systemPrompt,
			messages: this.session.getMessages(),
			tools,
			stopWhen: stepCountIs(this.config.maxSteps),
			abortSignal: this.abortController!.signal,
			experimental_context: this.toolContext,
			...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
		});

		for await (const event of result.fullStream) {
			if (!this.busy && this.abortController?.signal.aborted) break;

			switch (event.type) {
				case "text-delta": {
					const text = (event as any).text ?? (event as any).delta ?? "";
					this.streamText += text;
					this.currentStepText += text;
					this.emit({
						type: "text_delta",
						agentId: this.config.agentId,
						text: this.currentStepText,
					});
					break;
				}
				case "reasoning-delta": {
					const text = (event as any).text ?? (event as any).delta ?? "";
					this.thinkingText += text;
					this.currentStepThinking += text;
					this.emit({
						type: "thinking_delta",
						agentId: this.config.agentId,
						text: this.currentStepThinking,
					});
					break;
				}
				case "tool-call": {
					const e = event as any;
					this.sealStep();
					log.debug("loop", "Tool call:", e.toolName);
					this.turnBlocks.push({ type: "tool", name: e.toolName, status: "running", args: e.input });
					this.emit({
						type: "tool_start",
						agentId: this.config.agentId,
						toolName: e.toolName,
						args: e.input,
					});
					break;
				}
				case "tool-result": {
					const e = event as any;
					log.debug("loop", "Tool result:", e.toolName);
					const tb = [...this.turnBlocks].reverse().find((b: any) => b.type === "tool" && b.name === e.toolName && b.status === "running");
					if (tb) { tb.status = "done"; tb.result = e.output; }
					this.emit({
						type: "tool_end",
						agentId: this.config.agentId,
						toolName: e.toolName,
						isError: false,
						result: e.output,
					});
					break;
				}
				case "tool-error": {
					const e = event as any;
					log.debug("loop", "Tool error:", e.toolName, e.errorText?.slice(0, 80));
					const tb = [...this.turnBlocks].reverse().find((b: any) => b.type === "tool" && b.name === e.toolName && b.status === "running");
					if (tb) { tb.status = "error"; tb.result = e.errorText ?? String(e.output); }
					this.emit({
						type: "tool_end",
						agentId: this.config.agentId,
						toolName: e.toolName,
						isError: true,
						result: e.errorText ?? String(e.output),
					});
					break;
				}
			}
		}

		this.resultText = await result.text;
		this.sealStep();

		// Store assistant turn to turns table
		this.saveAssistantTurn();

		// Also store to messages table for model context
		const response = await result.response;
		if (response.messages) {
			for (const msg of response.messages) {
				this.session.addMessage(msg);
			}
		}
		this.session.saveToDb();
		this.emit({
			type: "message_end",
			agentId: this.config.agentId,
			text: this.resultText,
		});
	}

	abort(): void {
		this.abortController?.abort();
	}

	getState(): RuntimeState {
		return {
			isBusy: this.busy,
			streamingText: this.streamText,
			toolCalls: this.turnBlocks.filter((b: any) => b.type === "tool").map((b: any) => ({ name: b.name, status: b.status })),
		};
	}

	getResult(): string {
		return this.resultText;
	}

	resetSession(): void {
		this.session.reset();
	}

	private sealStep(): void {
		if (this.currentStepThinking) {
			let t = this.currentStepThinking;
			while (t.charCodeAt(t.length - 1) === 10) t = t.substring(0, t.length - 1);
			if (t) this.turnBlocks.push({ type: "thinking", text: t });
			this.currentStepThinking = "";
		}
		if (this.currentStepText) {
			for (const b of parseThinkingTags(this.currentStepText)) this.turnBlocks.push(b);
			this.currentStepText = "";
		}
	}

	private saveUserTurn(text: string): void {
		const sessionId = this.session.getSessionId();
		if (!this.db || !sessionId) return;
		const seq = this.db.getTurnCount(sessionId);
		this.db.appendTurn(sessionId, seq, "user", text);
	}

	private saveAssistantTurn(): void {
		const sessionId = this.session.getSessionId();
		if (!this.db || !sessionId) return;
		if (this.turnBlocks.length === 0) return;
		const seq = this.db.getTurnCount(sessionId);
		this.db.appendTurn(sessionId, seq, "assistant", JSON.stringify(this.turnBlocks));
	}
	private emit(event: StreamEvent): void {
		try {
			this.callbacks.onEvent(event);
		} catch { /* ignore subscriber errors */ }
	}
}
