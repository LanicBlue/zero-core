import { loadConfig } from "../core/config.js";
import { buildSystemPrompt } from "../core/system-prompt.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { loadDeviceContext } from "../core/device-context.js";
import type { AgentRecord } from "./agent-store.js";
import { AgentStore } from "./agent-store.js";
import { AgentLoop } from "../runtime/agent-loop.js";
import type { RuntimeProviderConfig, SessionConfig, StreamEvent } from "../runtime/types.js";
import { clearProviderCache } from "../runtime/provider-factory.js";
import { SessionDB } from "./session-db.js";
import { mcpManager } from "./mcp-manager.js";
import { buildMcpTools } from "../runtime/tools/mcp-tool.js";
import { KbStore } from "./kb-store.js";
import { KbDB } from "./kb-db.js";
import { log } from "../core/logger.js";
import { toolRegistry } from "../core/tool-registry.js";

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

interface AgentRunState {
	isBusy: boolean;
	streamingText: string;
	toolCalls: { name: string; status: "running" | "done" | "error" }[];
}

// ---------------------------------------------------------------------------
// Agent Service — supports concurrent multi-agent execution
// ---------------------------------------------------------------------------

class AgentService {
	private loops = new Map<string, AgentLoop>();
	private runStates = new Map<string, AgentRunState>();
	private subscribers = new Set<StreamCallback>();
	private config = loadConfig(process.cwd());
	private workspaceDir: string;
	private providerConfigs: RuntimeProviderConfig[] = [];
	private defaultModel: string | undefined;
	private defaultProvider: string | undefined;
	private db: SessionDB;
	private kbStore: KbStore;
	private kbDb: KbDB;
	private agentStore: AgentStore | null = null;
	private agentToolStore: import("./agent-tool-store.js").AgentToolStore | null = null;

	constructor(workspaceDir: string, sessionDb?: SessionDB, kb?: KbStore) {
		this.workspaceDir = workspaceDir;
		this.db = sessionDb ?? new SessionDB();
		this.kbStore = kb ?? new KbStore(this.db.getDb());
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

	setAgentStore(store: AgentStore): void {
		this.agentStore = store;
	}

	setAgentToolStore(store: import("./agent-tool-store.js").AgentToolStore): void {
		this.agentToolStore = store;
	}

	subscribe(cb: StreamCallback): () => void {
		this.subscribers.add(cb);
		return () => { this.subscribers.delete(cb); };
	}

	// ─── State queries — per-agent ─────────────────────────────────

	getState(agentId?: string): { isBusy: boolean; streamingText: string; toolCalls: { name: string; status: string }[]; agentId?: string } {
		if (agentId) {
			const s = this.runStates.get(agentId);
			return s
				? { isBusy: s.isBusy, streamingText: s.streamingText, toolCalls: [...s.toolCalls], agentId }
				: { isBusy: false, streamingText: "", toolCalls: [], agentId };
		}
		// No agentId — return the first busy agent, or idle
		for (const [id, s] of this.runStates) {
			if (s.isBusy) return { isBusy: true, streamingText: s.streamingText, toolCalls: [...s.toolCalls], agentId: id };
		}
		return { isBusy: false, streamingText: "", toolCalls: [] };
	}

	getAllStates(): Record<string, { isBusy: boolean; streamingText: string; toolCalls: { name: string; status: string }[] }> {
		const result: Record<string, any> = {};
		for (const [id, s] of this.runStates) {
			result[id] = { isBusy: s.isBusy, streamingText: s.streamingText, toolCalls: [...s.toolCalls] };
		}
		return result;
	}

	isAnyBusy(): boolean {
		for (const s of this.runStates.values()) {
			if (s.isBusy) return true;
		}
		return false;
	}

	// ─── Loop management ───────────────────────────────────────────

	private getOrCreateLoop(agent?: AgentRecord): AgentLoop {
		const agentId = agent?.id ?? "__default__";

		let loop = this.loops.get(agentId);
		if (loop) return loop;

		let session = this.db.getMainSession(agentId);
		if (!session) {
			session = this.db.createSession(agentId);
			this.db.setMainSession(agentId, session.id);
		}

		return this.createLoopForSession(agentId, session.id, agent);
	}

	recreateLoop(agentId: string, sessionId: string, agent?: AgentRecord): void {
		const old = this.loops.get(agentId);
		if (old) {
			old.abort();
			this.loops.delete(agentId);
		}

		this.createLoopForSession(agentId, sessionId, agent);
	}

	private createLoopForSession(agentId: string, sessionId: string, agent?: AgentRecord): AgentLoop {
		const cwd = agent?.workspaceDir || this.workspaceDir;
		log.agent("Creating runtime for agent:", agentId, "session:", sessionId, "cwd:", cwd);

		const deviceContext = loadDeviceContext() || undefined;

		const systemPrompt = buildSystemPrompt(this.config, {
			cwd,
			activeTools: [],
			originalPrompt: agent?.systemPrompt ?? "",
			deviceContext,
			useDeviceContext: agent?.contextConfig?.useDeviceContext,
			useGuidelines: agent?.contextConfig?.useGuidelines,
			useMemoryContext: agent?.contextConfig?.useMemoryContext,
			enabledSkills: agent?.skillPolicy?.enabledSkills,
		});

		const sessionConfig: SessionConfig = {
			agentId,
			workspaceDir: cwd,
			systemPrompt,
			modelId: agent?.model || this.defaultModel || "",
			providerName: agent?.provider || this.defaultProvider || "",
			thinkingLevel: agent?.thinkingLevel,
			sessionId,
			toolPolicy: {
				autoApprove: agent?.toolPolicy?.autoApprove ?? this.config.toolPolicy.autoApprove,
				blockedTools: agent?.toolPolicy?.blockedTools ?? this.config.toolPolicy.blockedTools,
				executionMode: agent?.toolPolicy?.executionMode ?? this.config.toolPolicy.executionMode,
				resultMaxTokens: agent?.toolPolicy?.resultMaxTokens ?? this.config.toolPolicy.resultMaxTokens,
					readScope: agent?.toolPolicy?.readScope ?? "filesystem",
			},
			getMcpTools: async (aid?: string) => {
				const mcpToolInfos = mcpManager.getToolsForAgent(aid);
				return buildMcpTools(mcpToolInfos, (serverId, toolName, args) =>
					mcpManager.callTool(serverId, toolName, args),
				);
			},
		getAgentToolEntries: async () => {
					if (!this.agentToolStore || !this.agentStore) {
						return { entries: [], agents: new Map() };
					}
					const entries = this.agentToolStore.list().filter((e) => {
						if (!e.enabled) return false;
						if (e.type === "internal") return e.agentId !== agentId;
						return true;
					});
					const agentMap = new Map<string, { id: string; name: string; systemPrompt?: string; model?: string }>();
					for (const agent of this.agentStore.list()) {
						agentMap.set(agent.id, {
							id: agent.id,
							name: agent.name,
							systemPrompt: agent.systemPrompt,
							model: agent.model,
						});
					}
					return { entries, agents: agentMap };
				},
			};

		// Initialize run state for this agent
		if (!this.runStates.has(agentId)) {
			this.runStates.set(agentId, { isBusy: false, streamingText: "", toolCalls: [] });
		}

		const capturedAgentId = agentId;

		const loop = new AgentLoop(
			sessionConfig,
			this.providerConfigs,
			{
				onEvent: (event: StreamEvent) => {
					this.handleRuntimeEvent(capturedAgentId, event);
				},
			},
		);

		this.loops.set(agentId, loop);

		log.agent("Runtime ready for:", agentId, "session:", sessionId);
		return loop;
	}

	// ─── Prompt execution — concurrent ──────────────────────────────

	async sendPrompt(text: string, agent?: AgentRecord): Promise<void> {
		const agentId = agent?.id ?? "__default__";
		const loop = this.getOrCreateLoop(agent);

		log.agent("Sending prompt to:", agentId, "length:", text.length);

		const state = this.runStates.get(agentId) ?? { isBusy: false, streamingText: "", toolCalls: [] };
		state.isBusy = true;
		state.streamingText = "";
		state.toolCalls = [];
		this.runStates.set(agentId, state);

		try {
			await loop.run(text);
			log.agent("Prompt completed for:", agentId);
		} catch (err) {
			log.error("agent", "Prompt error:", (err as Error).message);
			this.emit({ type: "error", error: (err as Error).message, agentId });
		}
	}

	async abort(agentId?: string): Promise<void> {
		if (agentId) {
			const loop = this.loops.get(agentId);
			loop?.abort();
		} else {
			// Abort all running agents
			for (const [id, s] of this.runStates) {
				if (s.isBusy) {
					this.loops.get(id)?.abort();
				}
			}
		}
	}

	dispose(): void {
		for (const loop of this.loops.values()) {
			loop.abort();
		}
		this.loops.clear();
		this.runStates.clear();
		this.db.close();
		this.kbDb.close();
	}

	private invalidateLoops(): void {
		for (const loop of this.loops.values()) {
			loop.abort();
		}
		this.loops.clear();
		this.runStates.clear();
	}

	// ─── Event handling — per-agent state ──────────────────────────

	private handleRuntimeEvent(agentId: string, event: StreamEvent): void {
		const state = this.runStates.get(agentId);
		if (!state) return;

		switch (event.type) {
			case "text_delta": {
				break;
			}
			case "tool_start": {
				state.toolCalls.push({ name: event.toolName, status: "running" });
				break;
			}
			case "tool_end": {
				const tc = state.toolCalls.find(t => t.name === event.toolName && t.status === "running");
				if (tc) tc.status = event.isError ? "error" : "done";
				break;
			}
			case "message_end": {
				state.streamingText = event.text;
				break;
			}
			case "agent_end": {
				state.isBusy = false;
				state.streamingText = "";
				state.toolCalls = [];
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

export function createAgentService(workspaceDir: string, sessionDb?: SessionDB, kb?: KbStore): AgentService {
	return new AgentService(workspaceDir, sessionDb, kb);
}

export function registerAgentToolEntries(agentToolStore: import("./agent-tool-store.js").AgentToolStore): void {
	toolRegistry.unregister("agent");

	for (const entry of agentToolStore.list()) {
		if (!entry.enabled) continue;
		toolRegistry.register({
			name: entry.name,
			description: entry.description || `Run the "${entry.name}" agent`,
			category: "agent",
			source: "agent",
			agentToolId: entry.id,
			configSchema: [],
			meta: {
				isReadOnly: entry.type === "internal" || entry.transport === "http",
				isDestructive: entry.type === "external" && entry.transport === "cli",
				isConcurrencySafe: false,
				requiresConfirmation: false,
			},
		});
	}
	toolRegistry.notifyChange();
}
