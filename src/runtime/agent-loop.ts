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
} from "./types.js";
import { resolveModel, getContextWindow } from "./provider-factory.js";
import { AgentSession } from "./session.js";
import { buildToolsSet, buildToolPolicyDescription } from "./tools/index.js";
import type { SessionDB } from "../server/session-db.js";

export class AgentLoop implements AgentRuntime {
	private session: AgentSession;
	private config: SessionConfig;
	private providers: RuntimeProviderConfig[];
	private callbacks: RuntimeCallbacks;
	private toolContext: ToolExecutionContext;
	private abortController: AbortController | null = null;
	private busy = false;
	private streamText = "";
	private thinkingText = "";
	private toolCalls: { name: string; status: "running" | "done" | "error" }[] = [];
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
				// Sub-agents are ephemeral — no DB
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

		this.busy = true;
		this.streamText = "";
		this.thinkingText = "";
		this.resultText = "";
		this.toolCalls = [];
		this.abortController = new AbortController();

		try {
			this.session.addMessage({ role: "user", content: userMessage });
			this.session.saveToDb();

			this.session.pruneIfNeeded();

			const model = resolveModel(this.providers, this.config.providerName, this.config.modelId);
			// Get MCP tools if available
			let mcpTools: Record<string, any> | undefined;
			if (this.config.getMcpTools) {
				try { mcpTools = await this.config.getMcpTools(this.config.agentId); }
				catch { /* MCP tools unavailable */ }
			}
			// Get built-in MCP server tools if available
			let builtInTools: Record<string, any> | undefined;
			if (this.config.getBuiltInTools) {
				try { builtInTools = this.config.getBuiltInTools(); } catch { /* built-in tools unavailable */ }
			}

			const tools = buildToolsSet(this.config.toolPolicy, this.toolContext, mcpTools, builtInTools);

			const toolPolicyDesc = buildToolPolicyDescription(this.config.toolPolicy);
			let systemPrompt = this.session.getSystemPrompt() + "\n\n## Tool Permissions\n\n" + toolPolicyDesc;

			// Inject RAG context if available
			if (this.config.getRagContext) {
				try {
					const ragContext = await this.config.getRagContext(this.config.agentId, userMessage);
					if (ragContext) systemPrompt += "\n\n" + ragContext;
				} catch { /* RAG context unavailable */ }
			}

			const providerOptions: Record<string, Record<string, any>> = {};
			if (this.config.thinkingLevel && this.config.thinkingLevel !== "none") {
				const budgetTokens = ({ low: 4096, medium: 16384, high: 32768 } as Record<string, number>)[this.config.thinkingLevel] ?? 16384;
				providerOptions.anthropic = { thinking: { type: "enabled", budgetTokens } };
			}

			const result = streamText({
				model,
				system: systemPrompt,
				messages: this.session.getMessages(),
				tools,
				stopWhen: stepCountIs(this.config.maxSteps),
				abortSignal: this.abortController.signal,
				experimental_context: this.toolContext,
				...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
			});

			for await (const event of result.fullStream) {
				if (!this.busy && this.abortController?.signal.aborted) break;

				switch (event.type) {
					case "text-delta": {
						const text = (event as any).text ?? (event as any).delta ?? "";
						this.streamText += text;
						this.emit({
							type: "text_delta",
							agentId: this.config.agentId,
							text: this.streamText,
						});
						break;
					}
					case "reasoning-delta": {
						const text = (event as any).text ?? (event as any).delta ?? "";
						this.thinkingText += text;
						this.emit({
							type: "thinking_delta",
							agentId: this.config.agentId,
							text: this.thinkingText,
						});
						break;
					}
					case "tool-call": {
						const e = event as any;
						this.toolCalls.push({ name: e.toolName, status: "running" });
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
						const tc = this.toolCalls.find(
							(t) => t.name === e.toolName && t.status === "running",
						);
						if (tc) tc.status = "done";
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
						const tc = this.toolCalls.find(
							(t) => t.name === e.toolName && t.status === "running",
						);
						if (tc) tc.status = "error";
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
		} catch (err: any) {
			if (err.name === "AbortError" || this.abortController?.signal.aborted) {
				// Aborted
			} else {
				this.emit({
					type: "error",
					agentId: this.config.agentId,
					error: err.message,
				});
			}
		} finally {
			this.busy = false;
			this.streamText = "";
			this.toolCalls = [];
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
			toolCalls: [...this.toolCalls],
		};
	}

	getResult(): string {
		return this.resultText;
	}

	resetSession(): void {
		this.session.reset();
	}

	private emit(event: StreamEvent): void {
		try {
			this.callbacks.onEvent(event);
		} catch { /* ignore subscriber errors */ }
	}
}
