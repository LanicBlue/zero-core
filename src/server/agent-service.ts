// Agent 服务
//
// # 文件说明书
//
// ## 核心功能
// Agent 执行服务，管理 Agent 循环、会话和配置。
//
// ## 输入
// - AgentRecord - Agent 配置
// - SessionConfig - 会话配置
//
// ## 输出
// - StreamEvent - 流式事件
// - 执行结果
//
// ## 定位
// 服务层核心，被 IPC 处理器调用。
//
// ## 依赖
// - ../core - 核心模块
// - ../runtime - 运行时
// - ./session-db - 会话数据库
// - ./mcp-manager - MCP 管理
//
// ## 维护规则
// - 核心执行逻辑变更时需谨慎
// - 保持向后兼容性
//
import { loadConfig, ZERO_CORE_DIR, type ZeroCoreConfig } from "../core/config.js";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { AgentRecord } from "../shared/types.js";
import { AgentStore } from "./agent-store.js";
import { AgentLoop } from "../runtime/agent-loop.js";
import type { RuntimeProviderConfig, SessionConfig, StreamEvent } from "../runtime/types.js";
import { clearProviderCache, setConcurrencyManager } from "../runtime/provider-factory.js";
import { SessionDB } from "./session-db.js";
import { MCPManager } from "./mcp-manager.js";
import { buildMcpTools } from "../runtime/tools/mcp-tool.js";
import { KbStore } from "./kb-store.js";
import { KbDB } from "./kb-db.js";
import { log } from "../core/logger.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { ProviderConcurrencyManager } from "../runtime/provider-concurrency-manager.js";
import type { SessionManager } from "./session-manager.js";
import { createEventMetricsAdapter, type EventMetricsAdapter } from "./metrics-events.js";
import { setSessionTurnSeq } from "./durable-hooks.js";
import { setTurnSeq } from "../runtime/hooks/turn-hooks.js";
import { buildWorkflowSystemPrompt, getRoleConfig } from "../runtime/agent-roles.js";
// ---------------------------------------------------------------------------
// Ensure zero-core dirs
// ---------------------------------------------------------------------------
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
	agentId: string;
	isBusy: boolean;
	streamingText: string;
	toolCalls: { name: string; status: "running" | "done" | "error" }[];
}
// ---------------------------------------------------------------------------
// Agent Service — supports concurrent multi-agent execution
// ---------------------------------------------------------------------------
export class AgentService {
	private loops = new Map<string, AgentLoop>();        // sessionId → loop
	private runStates = new Map<string, AgentRunState>(); // sessionId → state
	private activeSessions = new Map<string, string>();    // agentId → active sessionId
	private subscribers = new Set<StreamCallback>();
	private config!: ZeroCoreConfig;
	private workspaceDir: string;
	private providerConfigs: RuntimeProviderConfig[] = [];
	private defaultModel: string | undefined;
	private defaultProvider: string | undefined;
	private db: SessionDB;
	private kbStore: KbStore;
	private kbDb: KbDB;
	private registry: ToolRegistry;
	private mcp: MCPManager;
	private concurrencyManager = new ProviderConcurrencyManager();
	private agentStore: AgentStore | null = null;
	private agentToolStore: import("./agent-tool-store.js").AgentToolStore | null = null;
	private sessionManager: SessionManager | null = null;
	private metricsAdapter: EventMetricsAdapter | null = null;

	// Module readiness — modules notify when loaded, deferred actions wait until ready
	private readyModules = new Set<string>();
	private deferredActions: Array<{ waitFor: string[]; action: () => Promise<void> }> = [];
	constructor(workspaceDir: string, sessionDb?: SessionDB, kb?: KbStore, registry?: ToolRegistry, mcp?: MCPManager) {
		this.workspaceDir = workspaceDir;
		this.db = sessionDb ?? new SessionDB();
		this.kbStore = kb ?? new KbStore(this.db);
		this.kbDb = new KbDB();
		this.registry = registry ?? new ToolRegistry(this.db.getKVStore());
		this.mcp = mcp ?? new MCPManager(this.registry);
		this.config = loadConfig(process.cwd(), undefined, this.db.getKVStore());
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
		this.concurrencyManager.reconfigure(providers as any[]);
		setConcurrencyManager(this.concurrencyManager);
		this.invalidateLoops();
		this.notifyReady("providers");
	}
	setAgentStore(store: AgentStore): void {
		this.agentStore = store;
		this.notifyReady("agentStore");
	}
	setAgentToolStore(store: import("./agent-tool-store.js").AgentToolStore): void {
		this.agentToolStore = store;
	}
	setSessionManager(sm: SessionManager): void {
		this.sessionManager = sm;
		this.metricsAdapter = createEventMetricsAdapter(sm);
	}
	getSessionManager(): SessionManager | null {
		return this.sessionManager;
	}

	/** Mark a module as ready (e.g. "providers", "agentStore"). Triggers deferred actions. */
	notifyReady(module: string): void {
		if (this.readyModules.has(module)) return;
		this.readyModules.add(module);
		console.error("[server] Module ready:", module, "(" + [...this.readyModules].join(", ") + ")");

		// Check if any deferred actions can now run
		const ready = [...this.deferredActions];
		this.deferredActions = [];
		for (const entry of ready) {
			if (entry.waitFor.every(m => this.readyModules.has(m))) {
				entry.action().catch((err: any) => log.error("recovery", "Deferred action failed:", err.message));
			} else {
				this.deferredActions.push(entry);
			}
		}
	}

	/** Wait until all specified modules are ready, then run action. Runs immediately if already ready. */
	whenReady(waitFor: string[], action: () => Promise<void>): void {
		if (waitFor.every(m => this.readyModules.has(m))) {
			action().catch((err: any) => log.error("recovery", "Deferred action failed:", err.message));
		} else {
			console.error("[server] Deferring action, waiting for:", waitFor.filter(m => !this.readyModules.has(m)));
			this.deferredActions.push({ waitFor, action });
		}
	}
	getActiveSessionsMap(): ReadonlyMap<string, string> {
		return this.activeSessions;
	}
	evictSessionFromMemory(sessionId: string): void {
		const loop = this.loops.get(sessionId);
		if (loop) { loop.abort(); this.loops.delete(sessionId); }
		this.runStates.delete(sessionId);
		for (const [agentId, sid] of this.activeSessions) {
			if (sid === sessionId) { this.activeSessions.delete(agentId); break; }
		}
	}
	subscribe(cb: StreamCallback): () => void {
		this.subscribers.add(cb);
		return () => { this.subscribers.delete(cb); };
	}
	// ─── State queries — per-agent ─────────────────────────────────
	getState(agentId?: string): { isBusy: boolean; streamingText: string; toolCalls: { name: string; status: string }[]; agentId?: string } {
		if (agentId) {
			const sessionId = this.activeSessions.get(agentId);
			if (sessionId) {
				const s = this.runStates.get(sessionId);
				if (s) return { isBusy: s.isBusy, streamingText: s.streamingText, toolCalls: [...s.toolCalls], agentId };
			}
			return { isBusy: false, streamingText: "", toolCalls: [], agentId };
		}
		// No agentId — return the first busy agent, or idle
		for (const [sid, s] of this.runStates) {
			if (s.isBusy) return { isBusy: true, streamingText: s.streamingText, toolCalls: [...s.toolCalls], agentId: s.agentId };
		}
		return { isBusy: false, streamingText: "", toolCalls: [] };
	}
	getAllStates(): Record<string, { isBusy: boolean; streamingText: string; toolCalls: { name: string; status: string }[] }> {
		const result: Record<string, any> = {};
		for (const [sid, s] of this.runStates) {
			result[s.agentId] = { isBusy: s.isBusy, streamingText: s.streamingText, toolCalls: [...s.toolCalls] };
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
		const activeSessionId = this.activeSessions.get(agentId);
		if (activeSessionId) {
			const loop = this.loops.get(activeSessionId);
			if (loop) return loop;
		}
		let session = this.db.getMainSession(agentId);
		if (!session) {
			session = this.db.createSession(agentId);
			this.db.setMainSession(agentId, session.id);
		}
		this.activeSessions.set(agentId, session.id);
		return this.createLoopForSession(agentId, session.id, agent);
	}
	recreateLoop(agentId: string, sessionId: string, agent?: AgentRecord): void {
		if (this.loops.has(sessionId)) {
			this.activeSessions.set(agentId, sessionId);
			return;
		}
		this.createLoopForSession(agentId, sessionId, agent);
		this.activeSessions.set(agentId, sessionId);
	}
	private createLoopForSession(agentId: string, sessionId: string, agent?: AgentRecord): AgentLoop {
		const cwd = agent?.workspaceDir || this.workspaceDir;
		log.agent("Creating runtime for agent:", agentId, "session:", sessionId, "cwd:", cwd);
		const systemPrompt = agent?.systemPrompt ?? "";
		const guidelines = this.config.systemPrompt?.guidelines;
		const sessionConfig: SessionConfig = {
			agentId,
			workspaceDir: cwd,
			systemPrompt,
			guidelines,
			compression: this.config.compression,
			memory: this.config.memory,
			modelId: agent?.model || this.defaultModel || "",
			providerName: agent?.provider || this.defaultProvider || "",
			thinkingLevel: agent?.thinkingLevel,
			sessionId,
			db: this.db,
			toolPolicy: {
				autoApprove: agent?.toolPolicy?.autoApprove ?? this.config.toolPolicy.autoApprove,
				blockedTools: agent?.toolPolicy?.blockedTools ?? this.config.toolPolicy.blockedTools,
				tools: agent?.toolPolicy?.tools ?? this.config.toolPolicy.tools,
				executionMode: agent?.toolPolicy?.executionMode ?? this.config.toolPolicy.executionMode,
				resultMaxTokens: agent?.toolPolicy?.resultMaxTokens ?? this.config.toolPolicy.resultMaxTokens,
					readScope: agent?.toolPolicy?.readScope ?? "filesystem",
			},
			getMcpTools: async (aid?: string) => {
				const mcpToolInfos = this.mcp.getToolsForAgent(aid);
				return buildMcpTools(mcpToolInfos, (serverId, toolName, args) =>
					this.mcp.callTool(serverId, toolName, args),
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
			getToolConfig: () => this.registry.getToolConfig(),
			};
		// Initialize run state for this session
		if (!this.runStates.has(sessionId)) {
			this.runStates.set(sessionId, { agentId, isBusy: false, streamingText: "", toolCalls: [] });
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
		this.loops.set(sessionId, loop);
		this.sessionManager?.trackSessionCreated(sessionId, agentId);
		this.sessionManager?.trackSessionActivated(sessionId);
		log.agent("Runtime ready for:", agentId, "session:", sessionId);
		return loop;
	}
	// ─── Prompt execution — concurrent ──────────────────────────────
	async sendPrompt(text: string, agent?: AgentRecord, sessionId?: string): Promise<void> {
		const agentId = agent?.id ?? "__default__";
		// If sessionId provided, look up (or create) the loop for that specific session
		let loop: AgentLoop;
		if (sessionId) {
			loop = this.loops.get(sessionId) ?? this.createLoopForSession(agentId, sessionId, agent);
			this.activeSessions.set(agentId, sessionId);
		} else {
			loop = this.getOrCreateLoop(agent);
			sessionId = this.activeSessions.get(agentId) ?? agentId;
		}
		log.agent("Sending prompt to:", agentId, "session:", sessionId, "length:", text.length);
		this.sessionManager?.trackSessionQueued(sessionId);
		const state = this.runStates.get(sessionId) ?? { agentId, isBusy: false, streamingText: "", toolCalls: [] };
		state.isBusy = true;
		state.streamingText = "";
		state.toolCalls = [];
		this.runStates.set(sessionId, state);
		try {
			await loop.run(text);
			log.agent("Prompt completed for:", agentId);
		} catch (err) {
			log.error("agent", "Prompt error:", (err as Error).message);
			this.emit({ type: "error", error: (err as Error).message, agentId });
		}
	}
	/**
	 * Send a prompt with workflow role awareness.
	 * Injects role-specific system prompt, tool policy, and workflow context
	 * (wikiStore, requirementStore, projectId, taskStepStore, createRoleLoop) into the session.
	 */
	async sendRolePrompt(
		agentId: string,
		sessionId: string,
		role: string,
		prompt: string,
		context: {
			projectId?: string;
			projectPath?: string;
			projectName?: string;
			wikiStore?: any;
			requirementStore?: any;
			taskStepStore?: any;
			activeRequirementId?: string;
			createRoleLoop?: any;
		},
	): Promise<void> {
		const agent = this.agentStore?.get(agentId);
		if (!agent) throw new Error(`Agent not found: ${agentId}`);

		const roleConfig = getRoleConfig(role);
		const systemPrompt = agent.systemPrompt || "";
		const cwd = context.projectPath || agent.workspaceDir || this.workspaceDir;

		const sessionConfig: SessionConfig = {
			agentId,
			workspaceDir: cwd,
			systemPrompt,
			guidelines: this.config.systemPrompt?.guidelines,
			compression: this.config.compression,
			memory: this.config.memory,
			modelId: agent.model || this.defaultModel || "",
			providerName: agent.provider || this.defaultProvider || "",
			thinkingLevel: agent.thinkingLevel,
			sessionId,
			db: this.db,
			toolPolicy: {
				autoApprove: roleConfig.toolPolicy.autoApprove,
				blockedTools: roleConfig.toolPolicy.blockedTools,
				tools: agent.toolPolicy?.tools ?? this.config.toolPolicy.tools,
				executionMode: agent.toolPolicy?.executionMode ?? this.config.toolPolicy.executionMode,
				resultMaxTokens: agent.toolPolicy?.resultMaxTokens ?? this.config.toolPolicy.resultMaxTokens,
				readScope: agent.toolPolicy?.readScope ?? "filesystem",
			},
			getMcpTools: async (aid?: string) => {
				const mcpToolInfos = this.mcp.getToolsForAgent(aid);
				return buildMcpTools(mcpToolInfos, (serverId, toolName, args) =>
					this.mcp.callTool(serverId, toolName, args),
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
				for (const a of this.agentStore!.list()) {
					agentMap.set(a.id, { id: a.id, name: a.name, systemPrompt: a.systemPrompt, model: a.model });
				}
				return { entries, agents: agentMap };
			},
			getToolConfig: () => this.registry.getToolConfig(),
			agentRole: role,
			projectContext: context.projectId ? {
				projectId: context.projectId,
				projectName: context.projectName || "",
				projectPath: context.projectPath || "",
				activeRequirementId: context.activeRequirementId,
			} : undefined,
			wikiStore: context.wikiStore,
			requirementStore: context.requirementStore,
		} as any;

		// Inject M3 fields into sessionConfig (via `as any` since SessionConfig doesn't have them typed)
		(sessionConfig as any).taskStepStore = context.taskStepStore;
		(sessionConfig as any).createRoleLoop = context.createRoleLoop;

		let loop = this.loops.get(sessionId);
		if (!loop) {
			loop = new AgentLoop(sessionConfig, this.providerConfigs, {
				onEvent: (event: StreamEvent) => {
					this.handleRuntimeEvent(agentId, event);
				},
			});
			this.loops.set(sessionId, loop);
		}

		this.activeSessions.set(agentId, sessionId);
		if (!this.runStates.has(sessionId)) {
			this.runStates.set(sessionId, { agentId, isBusy: false, streamingText: "", toolCalls: [] });
		}

		const state = this.runStates.get(sessionId)!;
		state.isBusy = true;
		state.streamingText = "";
		state.toolCalls = [];

		log.agent("Sending role prompt to:", agentId, "role:", role, "session:", sessionId);

		try {
			await loop.run(prompt);
			log.agent("Role prompt completed for:", agentId, "role:", role);
		} catch (err) {
			log.error("agent", "Role prompt error:", (err as Error).message);
			this.emit({ type: "error", error: (err as Error).message, agentId });
		}
	}
	/**
	 * Create a role loop factory — used by LeadService to dispatch sub-agents.
	 * Returns a function that creates temporary AgentLoop instances for sub-agent execution.
	 */
	createRoleLoopFactory(
		project: { id: string; name: string; path: string },
		wikiStore: any,
		taskStepStore: any,
	): import("../runtime/types.js").ToolExecutionContext["createRoleLoop"] {
		const self = this;
		return async (params) => {
			// 1. Get role config
			const roleConfig = getRoleConfig(params.role);

			// 2. Build systemPrompt — use provided or fallback to role append
			const systemPrompt = params.systemPrompt || roleConfig.promptAppend;

			// 3. Build tool policy for sub-agent
			const subToolPolicy = {
				autoApprove: roleConfig.toolPolicy.autoApprove,
				blockedTools: roleConfig.toolPolicy.blockedTools,
			};

			// 4. Create temporary AgentLoop (not persisted to DB)
			const subAgentId = `role-${params.role}-${Date.now()}`;
			const subSession = self.db.createSession(subAgentId);
			const subSessionId = subSession.id;

			const subConfig: SessionConfig = {
				agentId: subAgentId,
				workspaceDir: params.workspaceDir || project.path,
				systemPrompt,
				modelId: self.defaultModel || "",
				providerName: self.defaultProvider || "",
				sessionId: subSessionId,
				db: self.db,
				toolPolicy: subToolPolicy,
				agentRole: params.role,
				projectContext: {
					projectId: project.id,
					projectName: project.name,
					projectPath: project.path,
				},
				getMcpTools: async (aid?: string) => {
					const mcpToolInfos = self.mcp.getToolsForAgent(aid);
					return buildMcpTools(mcpToolInfos, (serverId, toolName, args) =>
						self.mcp.callTool(serverId, toolName, args),
					);
				},
				getToolConfig: () => self.registry.getToolConfig(),
			};

			// 5. Create and execute AgentLoop
			const loop = new AgentLoop(subConfig, self.providerConfigs, {
				onEvent: (_event: StreamEvent) => {
					// Silently consume sub-agent events — don't forward to UI
				},
			});

			self.loops.set(subSessionId, loop);
			if (!self.runStates.has(subSessionId)) {
				self.runStates.set(subSessionId, {
					agentId: subAgentId,
					isBusy: false,
					streamingText: "",
					toolCalls: [],
				});
			}

			try {
				await loop.run(params.task);
				const result = loop.getResult();

				// 6. Collect changed files (best effort — git diff)
				let changedFiles: string[] = [];
				try {
					const { execSync } = require("child_process");
					const diffOutput = execSync(
						`git -C "${project.path}" diff --name-only HEAD`,
						{ encoding: "utf-8", timeout: 10000 },
					);
					changedFiles = diffOutput.split("\n").filter(Boolean);
				} catch {
					// git not available or no changes
				}

				return { result, changedFiles };
			} finally {
				// Cleanup temporary loop
				self.loops.delete(subSessionId);
				self.runStates.delete(subSessionId);
			}
		};
	}
	async abort(agentId?: string): Promise<void> {
		if (agentId) {
			const sessionId = this.activeSessions.get(agentId);
			if (sessionId) this.loops.get(sessionId)?.abort();
		} else {
			for (const [sid, s] of this.runStates) {
				if (s.isBusy) {
					this.loops.get(sid)?.abort();
				}
			}
		}
	}
	recoverIncompleteSessions(): void {
		// Defer until providers and agentStore are ready
		this.whenReady(["providers", "agentStore"], () => this.doRecoverIncompleteSessions());
	}

	private async doRecoverIncompleteSessions(): Promise<void> {
		const incomplete = this.db.getIncompleteTurns();
		if (incomplete.length === 0) {
			log.debug("recovery", "No interrupted turns found");
			return;
		}
		console.error(`[server] Recovering ${incomplete.length} interrupted session(s)`);
		for (const turn of incomplete) {
			try {
				const session = this.db.getSession(turn.sessionId);
				if (!session) {
					this.db.failTurnState(turn.sessionId, turn.turnSeq, "Session not found");
					continue;
				}
				const agent = this.agentStore
					? this.agentStore.list().find((a) => a.id === session.agentId)
					: null;
				const agentId = agent?.id ?? session.agentId;
				// Create loop for the specific interrupted session
				let loop = this.loops.get(turn.sessionId);
				if (!loop) {
					loop = this.createLoopForSession(agentId, turn.sessionId, agent ?? undefined);
				}
				this.activeSessions.set(agentId, turn.sessionId);
				// Pre-populate turn seq so SessionStart hook skips creating a duplicate
				setSessionTurnSeq(turn.sessionId, turn.turnSeq);
					setTurnSeq(turn.sessionId, turn.turnSeq);
				// Set lifecycle state based on interrupted phase
				if (turn.phase === "tools_executing") {
					this.sessionManager?.trackSessionExecutingTools(turn.sessionId);
				} else {
					this.sessionManager?.trackSessionStreaming(turn.sessionId);
				}
				const state = this.runStates.get(turn.sessionId) ?? { agentId, isBusy: false, streamingText: "", toolCalls: [] };
				state.isBusy = true;
				state.streamingText = "";
				state.toolCalls = [];
				this.runStates.set(turn.sessionId, state);
				log.db(`Recovering agent ${agentId}, session ${turn.sessionId}, phase ${turn.phase}`);
				// Fire-and-forget: resume in background so we don't block startup
					loop.resume(turn.turnSeq).then(() => {
					log.db(`Resumed session ${turn.sessionId} (agent ${agentId})`);
					// Mark the original incomplete turn as completed
					this.db.completeTurnState(turn.sessionId, turn.turnSeq);
				}).catch((err: any) => {
					log.error("recovery", `Failed to resume ${turn.sessionId}:`, err.message);
					this.db.failTurnState(turn.sessionId, turn.turnSeq, err.message);
				});
			} catch (err) {
				log.error("recovery", `Recovery failed for ${turn.sessionId}:`, (err as Error).message);
				this.db.failTurnState(turn.sessionId, turn.turnSeq, (err as Error).message);
			}
		}
	}

	// ─── Startup: restore all sessions from DB into runtime ───────────────

	async restoreAllSessions(): Promise<void> {
		const allSessions = this.db.listAllSessions();
		console.error(`[server] Restoring ${allSessions.length} session(s) into runtime`);

		for (const session of allSessions) {
			try {
				if (this.loops.has(session.id)) continue;

				const agent = this.agentStore?.list().find((a) => a.id === session.agentId);
				this.createLoopForSession(session.agentId, session.id, agent ?? undefined);
				this.activeSessions.set(session.agentId, session.id);
			} catch (err) {
				log.error("recovery", `Failed to restore ${session.id}:`, (err as Error).message);
			}
		}
	}

	// ─── Session activation — runtime as single source of truth for UI ───
	async activateSession(agentId: string, sessionId?: string): Promise<string> {
		// Resolve target session: explicit id, active session, main session, or create new
		const candidate = sessionId ?? this.activeSessions.get(agentId);
		let resolvedSessionId: string;
		let session: { id: string; agentId: string; isMain: boolean; title: string | null; createdAt: string; updatedAt: string; inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
		if (candidate) {
			session = this.db.getSession(candidate);
		}
		if (!session) {
			session = this.db.getMainSession(agentId);
			if (!session) {
				session = this.db.createSession(agentId);
				this.db.setMainSession(agentId, session.id);
			}
		}
		resolvedSessionId = session.id;
		this.activeSessions.set(agentId, resolvedSessionId);
		// Ensure loop exists — this also creates runState
		let loop = this.loops.get(resolvedSessionId);
		if (!loop) {
			const agent = this.agentStore
				? this.agentStore.list().find((a) => a.id === agentId)
				: undefined;
			loop = this.createLoopForSession(agentId, resolvedSessionId, agent);
		}
		// Refresh turns cache so incremental persists are visible
		loop.refreshTurnsCache();
		const messages = this.buildSessionInitMessages(agentId, resolvedSessionId, loop);
			this.emit({
				type: "session_init",
				agentId,
				sessionId: resolvedSessionId,
				messages,
				// Context info from runtime (rebuilt from DB turns), not from DB session record
				inputTokens: loop.getEstimatedTokens(),
				outputTokens: session?.outputTokens ?? 0,
				totalTokens: (session?.outputTokens ?? 0) + loop.getEstimatedTokens(),
				contextWindow: loop.getContextWindow(),
				contextUsage: loop.getContextUsage(),
			});
			return resolvedSessionId;
		}

	/**
	 * Build UI messages from runtime turns.
	 *
	 * Step-level storage: turns may have `turnGroup` field. When present,
	 * multiple assistant steps with the same turnGroup are merged into one
	 * UI message. Message IDs use `turnGroup` instead of `seq` so that
	 * edit/delete operations target the entire turn group.
	 *
	 * Legacy (no turnGroup): each turn is one UI message, ID uses `seq`.
	 */
	private buildSessionInitMessages(agentId: string, sessionId: string, loop: AgentLoop): any[] {
		// Read from runtime, NOT from DB — runtime is the single source of truth for UI.
		const turns = loop.getSessionTurns();
		const { isBusy, recorderBlocks } = loop.getLoopState();

		// Check if we have step-level data (turnGroup field present)
		const hasStepData = turns.length > 0 && turns[0].turnGroup !== undefined;

		if (hasStepData) {
			return this.buildStepLevelMessages(turns, isBusy, recorderBlocks);
		}

		// Legacy path: no turnGroup, treat each turn as one UI message
		return this.buildLegacyMessages(turns, isBusy, recorderBlocks);
	}

	/** Build UI messages from step-level data, grouping by turnGroup. */
	private buildStepLevelMessages(
		turns: Array<{ seq: number; role: string; content: string | null; createdAt: string; turnGroup?: number }>,
		isBusy: boolean,
		recorderBlocks: any[],
	): any[] {
		const result: any[] = [];

		// Group steps by turnGroup, preserving order
		const groups = new Map<number, Array<{ seq: number; role: string; content: string | null; createdAt: string }>>();
		const groupOrder: number[] = [];
		for (const t of turns) {
			const tg = t.turnGroup ?? t.seq;
			let group = groups.get(tg);
			if (!group) {
				group = [];
				groups.set(tg, group);
				groupOrder.push(tg);
			}
			group.push(t);
		}

		for (let gi = 0; gi < groupOrder.length; gi++) {
			const tg = groupOrder[gi];
			const groupSteps = groups.get(tg)!;
			const isLastGroup = gi === groupOrder.length - 1;

			// Find user step in this group
			const userStep = groupSteps.find(s => s.role === "user");
			// Find assistant steps in this group
			const assistantSteps = groupSteps.filter(s => s.role === "assistant");

			// User message
			if (userStep) {
				result.push({
					id: `m${tg}`,
					role: "user",
					text: userStep.content ?? "",
					timestamp: new Date(userStep.createdAt).getTime(),
				});
			}

			// Assistant message — merge all assistant steps' blocks
			if (assistantSteps.length > 0) {
				const allBlocks: any[] = [];
				for (const step of assistantSteps) {
					let blocks: any[] = [];
					try {
						const parsed = step.content ? JSON.parse(step.content) : null;
						if (Array.isArray(parsed)) {
							blocks = parsed;
						} else if (typeof parsed === "string") {
							blocks = [{ type: "text", text: parsed }];
						}
					} catch {
						if (step.content) blocks = [{ type: "text", text: step.content }];
					}
					allBlocks.push(...blocks);
				}

				// If this is the last group AND the loop is streaming, replace with live recorder blocks
				if (isLastGroup && recorderBlocks.length > 0) {
					allBlocks.length = 0;
					allBlocks.push(...recorderBlocks);
				}

				const text = allBlocks
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text || "")
					.join("");

				result.push({
					id: `m${tg}`,
					role: "assistant",
					text,
					blocks: allBlocks,
					timestamp: new Date(assistantSteps[0].createdAt).getTime(),
					streaming: isLastGroup && isBusy && assistantSteps.length > 0,
				});
			}
		}

		// Runtime fix: if the loop is actively streaming but no assistant steps exist yet
		// (not persisted), append a live assistant message from recorder blocks.
		if (isBusy && recorderBlocks.length > 0) {
			const lastGroup = groupOrder[groupOrder.length - 1];
			const lastGroupSteps = lastGroup !== undefined ? groups.get(lastGroup) : undefined;
			const lastIsUser = !lastGroupSteps || lastGroupSteps.every(s => s.role === "user");
			if (lastIsUser) {
				const text = recorderBlocks
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text || "")
					.join("");
				result.push({
					id: "m-streaming",
					role: "assistant",
					text,
					blocks: recorderBlocks,
					timestamp: Date.now(),
					streaming: true,
				});
			}
		}

		return result;
	}

	/** Legacy path: no turnGroup, each turn is one UI message. */
	private buildLegacyMessages(
		turns: Array<{ seq: number; role: string; content: string | null; createdAt: string }>,
		isBusy: boolean,
		recorderBlocks: any[],
	): any[] {
		const result: any[] = [];
		for (let i = 0; i < turns.length; i++) {
			const t = turns[i];
			const isLastAssistant = (i === turns.length - 1) && t.role === "assistant";
			if (t.role === "user") {
				result.push({
					id: `m${t.seq}`,
					role: "user",
					text: t.content ?? "",
					timestamp: new Date(t.createdAt).getTime(),
				});
			} else {
				// Assistant turn — content is JSON-stringified blocks array (or plain text fallback)
				let blocks: any[] = [];
				try {
					const parsed = t.content ? JSON.parse(t.content) : null;
					if (Array.isArray(parsed)) {
						blocks = parsed;
					} else if (typeof parsed === "string") {
						blocks = [{ type: "text", text: parsed }];
					}
				} catch {
					if (t.content) blocks = [{ type: "text", text: t.content }];
				}
				// If this is the last assistant turn AND the loop is currently streaming
				// (or has partial recorder state from recovery), replace with live recorder blocks
				if (isLastAssistant && recorderBlocks.length > 0) {
					blocks = recorderBlocks;
				}
				const text = blocks
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text || "")
					.join("");
				result.push({
					id: `m${t.seq}`,
					role: "assistant",
					text,
					blocks,
					timestamp: new Date(t.createdAt).getTime(),
					streaming: isLastAssistant && isBusy,
				});
			}
			// Runtime fix: if the loop is actively streaming but the DB has no
			// assistant turn yet (not persisted until message_end), append a live
			// assistant message from recorder blocks so session_init is complete.
			if (isBusy && recorderBlocks.length > 0) {
				const lastTurn = turns[turns.length - 1];
				const lastIsUser = !lastTurn || lastTurn.role === "user";
				if (lastIsUser) {
					const text = recorderBlocks
						.filter((b: any) => b.type === "text")
						.map((b: any) => b.text || "")
						.join("");
					result.push({
						id: "m-streaming",
						role: "assistant",
						text,
						blocks: recorderBlocks,
						timestamp: Date.now(),
						streaming: true,
					});
				}
			}
		}
		return result;
	}
	dispose(): void {
		this.sessionManager?.stopTtlCleanup();
		this.sessionManager?.dispose();
		// Close DB BEFORE aborting loops. This prevents Stop hooks from
		// completing turn_state rows — they stay incomplete so that
		// recoverIncompleteSessions() can resume them on next startup.
		this.db.close();
		this.kbDb.close();
		for (const loop of this.loops.values()) {
			loop.abort();
		}
		this.loops.clear();
		this.runStates.clear();
		this.activeSessions.clear();
		this.concurrencyManager.clear();
	}
	private invalidateLoops(): void {
		for (const [sessionId, loop] of this.loops) {
			const state = this.runStates.get(sessionId);
			if (state?.isBusy) continue; // Don't abort busy loops (e.g. recovery in progress)
			loop.abort();
			this.loops.delete(sessionId);
			this.runStates.delete(sessionId);
		}
		this.activeSessions.clear();
	}
	// ─── Event handling — per-agent state ──────────────────────────
	private handleRuntimeEvent(agentId: string, event: StreamEvent): void {
		const sessionId = (event as any).sessionId;
		const state = sessionId
			? this.runStates.get(sessionId)
			: this.findStateByAgentId(agentId);
		if (!state) return;
		if (this.metricsAdapter && sessionId) {
			this.metricsAdapter.onEvent(event, sessionId);
		}
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
	private findStateByAgentId(agentId: string): AgentRunState | undefined {
		for (const [, s] of this.runStates) {
			if (s.agentId === agentId) return s;
		}
		return undefined;
	}
	private emit(event: { type: string; [key: string]: unknown }): void {
		for (const cb of this.subscribers) {
			try { cb(event); } catch { /* ignore */ }
		}
	}
}
export function createAgentService(workspaceDir: string, sessionDb?: SessionDB, kb?: KbStore, registry?: ToolRegistry, mcp?: MCPManager): AgentService {
	return new AgentService(workspaceDir, sessionDb, kb, registry, mcp);
}
export function registerAgentToolEntries(agentToolStore: import("./agent-tool-store.js").AgentToolStore, registry: ToolRegistry): void {
	registry.unregister("agent");
	for (const entry of agentToolStore.list()) {
		if (!entry.enabled) continue;
		registry.register({
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
	registry.notifyChange();
}
