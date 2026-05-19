import { loadConfig } from "../core/config.js";
import { buildSystemPrompt } from "../core/system-prompt.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { loadProjectContext, formatProjectContext } from "../core/project-context.js";
import type { AgentRecord } from "./agent-store.js";
import { AgentLoop } from "../runtime/agent-loop.js";
import type { RuntimeProviderConfig, SessionConfig, StreamEvent, ToolExecutionContext } from "../runtime/types.js";
import { clearProviderCache } from "../runtime/provider-factory.js";
import { SessionDB } from "./session-db.js";
import { mcpManager } from "./mcp-manager.js";
import { buildMcpTools } from "../runtime/tools/mcp-tool.js";
import { KbStore } from "./kb-store.js";
import { KbDB } from "./kb-db.js";
import { createEmbeddingProvider } from "./kb-embeddings.js";
import { search, formatSearchResults } from "./kb-search.js";
import { createAllBuiltInTools } from "./mcp-servers/index.js";

// Timestamp helper for log messages
const ts = () => new Date().toISOString().substring(11, 23);
const log = (...args: unknown[]) => console.log(`[${ts()} agent]`, ...args);

// ---------------------------------------------------------------------------
// Ensure zero-core dirs
// ---------------------------------------------------------------------------

const ZERO_CORE_DIR = process.env.ZERO_CORE_DIR ?? join(homedir(), ".zero-core");

if (!existsSync(ZERO_CORE_DIR)) mkdirSync(ZERO_CORE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StreamCallback = (event: { type: string; [key: string]: unknown }) => void;

export interface ProviderConfig {
	name: string;
	type: "openai" | "anthropic" | "gemini" | "openai-compatible" | "ollama";
	apiKey: string;
	baseUrl: string;
	models: { id: string; name: string; contextWindow?: number; maxTokens?: number }[];
	enabled: boolean;
}

// ---------------------------------------------------------------------------
// Agent Service — long-lived, survives UI disconnects
// Uses Vercel AI SDK runtime with SQLite session persistence
// ---------------------------------------------------------------------------

class AgentService {
	private loops = new Map<string, AgentLoop>();
	private activeLoopId: string | null = null;
	private subscribers = new Set<StreamCallback>();
	private config = loadConfig(process.cwd());
	private workspaceDir: string;
	private isAgentBusy = false;
	private currentStreamText = "";
	private currentToolCalls: { name: string; status: "running" | "done" | "error" }[] = [];
	private providerConfigs: RuntimeProviderConfig[] = [];
	private defaultModel: string | undefined;
	private defaultProvider: string | undefined;
	private db: SessionDB;
	private kbStore: KbStore;
	private kbDb: KbDB;

	constructor(workspaceDir: string) {
		this.workspaceDir = workspaceDir;
		this.db = new SessionDB();
		this.kbStore = new KbStore();
		this.kbDb = new KbDB();
	}

	getDB(): SessionDB {
		return this.db;
	}

	setWorkspaceDir(dir: string): void {
		if (dir !== this.workspaceDir) {
			this.workspaceDir = dir;
			this.invalidateLoops();
		}
	}

	setProviders(providers: ProviderConfig[], defaultModel?: string, defaultProvider?: string): void {
		this.providerConfigs = providers;
		this.defaultModel = defaultModel;
		this.defaultProvider = defaultProvider;
		clearProviderCache();
		this.invalidateLoops();
	}

	subscribe(cb: StreamCallback): () => void {
		this.subscribers.add(cb);
		return () => { this.subscribers.delete(cb); };
	}

	getState(): { isBusy: boolean; streamingText: string; toolCalls: { name: string; status: string }[]; agentId?: string } {
		return {
			isBusy: this.isAgentBusy,
			streamingText: this.currentStreamText,
			toolCalls: [...this.currentToolCalls],
			agentId: this.activeLoopId ?? undefined,
		};
	}

	private getOrCreateLoop(agent?: AgentRecord): AgentLoop {
		const agentId = agent?.id ?? "__default__";

		let loop = this.loops.get(agentId);
		if (loop) {
			this.activeLoopId = agentId;
			return loop;
		}

		// Resolve or create main session for this agent
		let session = this.db.getMainSession(agentId);
		if (!session) {
			session = this.db.createSession(agentId);
			this.db.setMainSession(agentId, session.id);
		}

		return this.createLoopForSession(agentId, session.id, agent);
	}

	recreateLoop(agentId: string, sessionId: string, agent?: AgentRecord): void {
		// Dispose old loop
		const old = this.loops.get(agentId);
		if (old) {
			old.abort();
			this.loops.delete(agentId);
		}

		this.createLoopForSession(agentId, sessionId, agent);
	}

	private createLoopForSession(agentId: string, sessionId: string, agent?: AgentRecord): AgentLoop {
		const cwd = agent?.workspaceDir || this.workspaceDir;
		log("Creating runtime for agent:", agentId, "session:", sessionId, "cwd:", cwd);

		const projectCtx = loadProjectContext(cwd, agent?.contextConfig);

		const systemPrompt = buildSystemPrompt(this.config, {
			cwd,
			activeTools: [],
			originalPrompt: agent?.systemPrompt ?? "",
			projectContext: projectCtx ? formatProjectContext(projectCtx) : undefined,
		});

		const sessionConfig: SessionConfig = {
			agentId,
			workspaceDir: cwd,
			systemPrompt,
			modelId: agent?.model || this.defaultModel || "",
			providerName: agent?.provider || this.defaultProvider || "",
			thinkingLevel: agent?.thinkingLevel,
			maxSteps: 50,
			sessionId,
			toolPolicy: {
				autoApprove: agent?.toolPolicy?.autoApprove ?? this.config.toolPolicy.autoApprove,
				blockedTools: agent?.toolPolicy?.blockedTools ?? this.config.toolPolicy.blockedTools,
				executionMode: agent?.toolPolicy?.executionMode ?? this.config.toolPolicy.executionMode,
				resultMaxTokens: agent?.toolPolicy?.resultMaxTokens ?? this.config.toolPolicy.resultMaxTokens,
					readScope: agent?.toolPolicy?.readScope ?? "filesystem",
			},
			getBuiltInTools: () => createAllBuiltInTools({ workspaceDir: cwd }),
			getMcpTools: async (aid?: string) => {
				const mcpToolInfos = mcpManager.getToolsForAgent(aid);
				return buildMcpTools(mcpToolInfos, (serverId, toolName, args) =>
					mcpManager.callTool(serverId, toolName, args),
				);
			},
		};

		const capturedAgentId = agentId;

		const loop = new AgentLoop(
			sessionConfig,
			this.providerConfigs,
			{
				onEvent: (event: StreamEvent) => {
					if (this.activeLoopId === capturedAgentId) {
						this.handleRuntimeEvent(event);
					}
				},
			},
			this.db,
		);

		this.loops.set(agentId, loop);
		this.activeLoopId = agentId;

		log("Runtime ready for:", agentId, "session:", sessionId);
		return loop;
	}

	async sendPrompt(text: string, agent?: AgentRecord): Promise<void> {
		const loop = this.getOrCreateLoop(agent);

		log("Sending prompt:", text.substring(0, 50));
		this.isAgentBusy = true;
		this.currentStreamText = "";
		this.currentToolCalls = [];

		try {
			await loop.run(text);
			log("Prompt completed");
		} catch (err) {
			console.error(`[${ts()} agent] Prompt error:`, (err as Error).message);
			this.emit({ type: "error", error: (err as Error).message, agentId: this.activeLoopId ?? undefined });
		}
	}

	async abort(): Promise<void> {
		const loop = this.activeLoopId ? this.loops.get(this.activeLoopId) : null;
		loop?.abort();
	}

	private getEmbeddingBaseUrl(provider: string): string {
		// Use the first enabled provider's base URL for OpenAI-compatible
		if (provider === "ollama") return "http://localhost:11434";
		const p = this.providerConfigs.find((p) => p.enabled && p.type !== "ollama");
		return p?.baseUrl ?? "https://api.openai.com/v1";
	}

	private getEmbeddingApiKey(provider: string): string {
		if (provider === "ollama") return "";
		const p = this.providerConfigs.find((p) => p.enabled && p.type !== "ollama");
		return p?.apiKey ?? "";
	}

	dispose(): void {
		for (const loop of this.loops.values()) {
			loop.abort();
		}
		this.loops.clear();
		this.activeLoopId = null;
		this.isAgentBusy = false;
		this.db.close();
		this.kbDb.close();
	}

	private invalidateLoops(): void {
		for (const loop of this.loops.values()) {
			loop.abort();
		}
		this.loops.clear();
		this.activeLoopId = null;
	}

	private handleRuntimeEvent(event: StreamEvent): void {
		switch (event.type) {
			case "text_delta": {
				break;
			}
			case "tool_start": {
				this.currentToolCalls.push({ name: event.toolName, status: "running" });
				break;
			}
			case "tool_end": {
				const tc = this.currentToolCalls.find(t => t.name === event.toolName && t.status === "running");
				if (tc) tc.status = event.isError ? "error" : "done";
				break;
			}
			case "message_end": {
				this.currentStreamText = event.text;
				break;
			}
			case "agent_end": {
				this.isAgentBusy = false;
				this.currentStreamText = "";
				this.currentToolCalls = [];
				break;
			}
		}
		this.emit(event as { type: string; [key: string]: unknown });
	}

	private emit(event: { type: string; [key: string]: unknown }): void {
		for (const cb of this.subscribers) {
			try { cb(event); } catch { /* ignore */ }
		}
	}
}

export function createAgentService(workspaceDir: string): AgentService {
	return new AgentService(workspaceDir);
}
