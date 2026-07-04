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
import type { AgentRecord, DelegatedTaskRecord } from "../shared/types.js";
import { AgentStore } from "./agent-store.js";
import { AgentLoop } from "../runtime/agent-loop.js";
import type { RuntimeProviderConfig, SessionConfig, StreamEvent } from "../runtime/types.js";
import { clearProviderCache, setConcurrencyManager } from "../runtime/provider-factory.js";
import { SessionDB } from "./session-db.js";
import { InputQueueStore } from "./input-queue-store.js";
import { MCPManager } from "./mcp-manager.js";
import { buildMcpTools } from "../runtime/tools/mcp-tool.js";
import { log } from "../core/logger.js";
import { emitTransition } from "./data-change-hub.js";
import { ToolRegistry, RENAMED_TOOLS } from "../core/tool-registry.js";
import { ProviderConcurrencyManager } from "../runtime/provider-concurrency-manager.js";
import type { SessionManager } from "./session-manager.js";
import { createEventMetricsAdapter, type EventMetricsAdapter } from "./metrics-events.js";
import { setSessionTurnSeq } from "./durable-hooks.js";
import { setTurnSeq } from "../runtime/hooks/turn-hooks.js";
import { registerHooksForLoop, type HookWiringDeps } from "../runtime/hooks/index.js";
import { getSessionTodos } from "../runtime/tools/todo-write.js";
import { pendingResponses } from "../runtime/pending-responses.js";
// (WORKFLOW_ROLES / sendRolePrompt 已退役 —— 去-role 统一走 sendProjectPrompt)

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
// toolEnabled — mirror of buildToolsSet.isEnabled
// ---------------------------------------------------------------------------
// Single source of truth lives in src/runtime/tools/index.ts (buildToolsSet).
// Duplicated here as a pure reader so the server layer can decide which domain
// service handles to inject WITHOUT importing the runtime tool layer (would
// create a server→runtime/tools cycle). Keep these two in sync if the
// enabled-check rule changes.
const DEFAULT_ENABLED_TOOLS = new Set(["Shell", "Read", "Write", "Edit", "Grep", "Glob"]);
function toolEnabled(
	policy: { tools?: Record<string, { enabled?: boolean } | null> | null; autoApprove?: string[] } | null | undefined,
	name: string,
): boolean {
	if (!policy) return DEFAULT_ENABLED_TOOLS.has(name);
	if (policy.tools) {
		// Mirror buildToolsSet's rename: legacy lowercase keys (e.g. "wiki")
		// must be normalized to their canonical PascalCase names so capability
		// injection agrees with the tool-set assembly. Otherwise a config with
		// {wiki:{enabled:true}} would pass buildToolsSet's gate but fail here
		// → wikiStore never injected → CONDITIONAL_TOOLS filters Wiki out.
		const normalized: Record<string, { enabled?: boolean } | null> = {};
		for (const [key, val] of Object.entries(policy.tools)) {
			normalized[RENAMED_TOOLS[key] ?? key] = val;
		}
		if (name in normalized) return normalized[name]?.enabled === true;
		return DEFAULT_ENABLED_TOOLS.has(name);
	}
	const aa = new Set(policy.autoApprove ?? []);
	if (aa.has("*")) return true;
	if (aa.size > 0) return aa.has(name);
	return DEFAULT_ENABLED_TOOLS.has(name);
}

/**
 * The domain capability handles (management / wikiStore / requirementStore /
 * pmService) a session should surface, given a toolPolicy. A handle is included
 * only when its domain tool(s) are enabled by the policy AND the backing
 * service is present. Single source for both loop creation and hot config-sync
 * (applyConfigUpdate) so enabling e.g. Wiki on a RUNNING loop actually injects
 * wikiStore — otherwise buildToolsSet would enable the tool but CONDITIONAL_TOOLS
 * (which gates on ctx.wikiStore) would still filter it out.
 */
type CapabilityHandles = {
	management?: unknown;
	wikiStore?: unknown;
	requirementStore?: unknown;
	pmService?: unknown;
};

// ---------------------------------------------------------------------------
// Agent Service — supports concurrent multi-agent execution
// ---------------------------------------------------------------------------
export class AgentService {
	private loops = new Map<string, AgentLoop>();        // sessionId → loop
	private runStates = new Map<string, AgentRunState>(); // sessionId → state
	private activeSessions = new Map<string, string>();    // agentId → active sessionId
	/** Per-session input queue (C2): inputs submitted while a session is busy. */
	readonly inputQueue = new InputQueueStore();
	private subscribers = new Set<StreamCallback>();
	private config!: ZeroCoreConfig;
	private workspaceDir: string;
	private providerConfigs: RuntimeProviderConfig[] = [];
	private defaultModel: string | undefined;
	private defaultProvider: string | undefined;
	private db: SessionDB;
	private registry: ToolRegistry;
	private mcp: MCPManager;
	private concurrencyManager = new ProviderConcurrencyManager();
	private agentStore: AgentStore | null = null;
	private sessionManager: SessionManager | null = null;
	private metricsAdapter: EventMetricsAdapter | null = null;
	// v0.8 (P3): ManagementService handle (renamed from ZeroAdminService),
	// injected into zero sessions only.
	private management: import("./management-service.js").ManagementService | null = null;
	// v0.8 (M4): PmService + RequirementStore handles, injected into PM
	// (roleTag='pm') sessions so the CreateRequirementWithDoc tool can call
	// PmService.createRequirementWithDoc from a cron-triggered sendPrompt loop.
	// wikiStore (ProjectWikiStore) is also injected so PM can read archivist's
	// wiki to write better requirements (acceptance-M4 line 3).
	private pmService: any = null;
	private requirementStore: any = null;
	private wikiStore: any = null;
	// v0.8 (M5): the global WikiStore (not the ProjectWikiStore back-compat
	// wrapper). Surfaced onto every session config so extractor A can write
	// global memory nodes (decision 46 N2 — memory hangs under global type
	// nodes, NOT under any project subtree), and so recall (memory-hooks)
	// can read those nodes back.
	private wikiStoreGlobal: any = null;
	// v0.8 (M5): extractor config (extractors.A/B enabled + provider/model
	// overrides + checkpointThresholds). Threaded into every session config
	// so the extraction hook can gate + build extractor services.
	private extractorsConfig: any = null;
	// v0.8 (P3 §7.7 #4): tool-call usage log. Surfaced onto every session
	// config so tool-factory can record one row per tool invocation. Best-effort
	// (logging failures are swallowed in tool-factory).
	private toolUsageStore: any = null;
	/**
	 * Step 1B: per-loop hook wiring deps. Assembled by server/index.ts (which
	 * owns the M5 extractor deps + workflow-context stores) and injected here.
	 * Each loop built by this service registers the main hook set on its own
	 * registry from these deps; delegated sub-loops inherit the same deps via
	 * config.hookWiringDeps (threaded through AgentLoop → SubagentDelegator).
	 */
	private hookDeps: HookWiringDeps = {};

	// Module readiness — modules notify when loaded, deferred actions wait until ready
	private readyModules = new Set<string>();
	private deferredActions: Array<{ waitFor: string[]; action: () => Promise<void> }> = [];
	constructor(workspaceDir: string, sessionDb?: SessionDB, registry?: ToolRegistry, mcp?: MCPManager) {
		this.workspaceDir = workspaceDir;
		this.db = sessionDb ?? new SessionDB();
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
		// v0.8 (delegation refactor): when an agent record changes, hot-apply
		// the new config (prompt/toolPolicy/subagents/wikiAnchors) to every
		// running loop bound to that agent — so edits via the AgentRegistry
		// tool or UI take effect on the next turn without restarting. System-
		// prompt changes invalidate the prompt cache (acceptable, infrequent).
		store.onChange((agentId) => {
			const agent = store.get(agentId);
			if (!agent) return;

			const activeSessionId = this.activeSessions.get(agentId) ?? this.db.getMainSession(agentId)?.id;
			const activeState = activeSessionId ? this.runStates.get(activeSessionId) : undefined;
			if (activeSessionId && !activeState?.isBusy) {
				// Step 1C: SessionClose for the loop being torn down before the
				// fresh rebuild. Fire-and-forget; createLoopForSession fires
				// SessionStart for the replacement.
				const oldLoop = this.loops.get(activeSessionId);
				if (oldLoop) void this.fireSessionClose(oldLoop, agentId, activeSessionId, "main");
				this.loops.delete(activeSessionId);
				this.createLoopForSession(agentId, activeSessionId, agent);
				this.activeSessions.set(agentId, activeSessionId);
				return;
			}

			for (const loop of this.loops.values()) {
				if (loop.getConfigAgentId() !== agentId) continue;
				loop.applyConfigUpdate({
					systemPrompt: agent.systemPrompt,
					toolPolicy: agent.toolPolicy,
					subagents: agent.subagents,
					wikiAnchors: agent.wikiAnchors,
					// N4 (invariant 1): hot-sync model / provider / thinkingLevel
					// from the new agent record. applyConfigUpdate treats each as
					// "undefined = no change", so passing them verbatim is safe
					// even when the record leaves a field unset. executeStream
					// re-resolves the model and the PreLLMCall hook re-reads
					// thinkingLevel every turn, so the next turn uses the new
					// values without a loop rebuild.
					providerName: agent.provider,
					modelId: agent.model,
					thinkingLevel: agent.thinkingLevel,
					// C1 (agent-context-fields): per-agent context-block toggle.
					contextConfig: agent.contextConfig,
					// Re-inject capability handles for the NEW policy so a tool
					// enabled mid-flight (e.g. Wiki turned on while the loop is
					// running) actually surfaces — CONDITIONAL_TOOLS gates on
					// these ctx fields, not just toolPolicy.
					capabilities: this.capabilityHandlesFor(agent.toolPolicy),
				});
			}
		});
		this.notifyReady("agentStore");
	}
	setSessionManager(sm: SessionManager): void {
		this.sessionManager = sm;
		this.metricsAdapter = createEventMetricsAdapter(sm);
	}
	/** v0.8 (P3): inject the ManagementService (renamed from ZeroAdminService),
	 * gated to zero sessions only. */
	setManagement(svc: import("./management-service.js").ManagementService): void {
		this.management = svc;
	}
	/**
	 * v0.8 (M4): inject the PmService + RequirementStore + wikiStore. These are
	 * surfaced onto PM (roleTag='pm') session tool contexts so the
	 * CreateRequirementWithDoc tool (and the read-only wiki tools) can call
	 * PmService / read the project wiki from a cron-triggered sendPrompt loop
	 * — without requiring the caller to thread them through sendProjectPrompt.
	 */
	setPmService(pmService: any, requirementStore: any, wikiStore?: any): void {
		this.pmService = pmService;
		this.requirementStore = requirementStore;
		this.wikiStore = wikiStore ?? null;
	}
	/**
	 * v0.8 (M5): inject the global WikiStore. The global WikiStore is the
	 * writer target for extractor A's memory nodes (decision 46 N2).
	 * Extractor config (extractors.A/B enabled + provider/model overrides +
	 * checkpointThresholds) is read from this.config.extractors (loaded in
	 * the constructor via loadConfig).
	 */
	setWikiStoreGlobal(wikiStoreGlobal: any): void {
		this.wikiStoreGlobal = wikiStoreGlobal ?? null;
		this.extractorsConfig = (this.config as any).extractors ?? null;
	}
	/** v0.8 (P3 §7.7 #4): inject the tool-call usage log store. */
	setToolUsageStore(store: any): void {
		this.toolUsageStore = store ?? null;
	}
	/**
	 * Step 1B: inject the per-loop hook wiring deps. Called once by
	 * server/index.ts after the M5 extractor deps + workflow-context stores
	 * are built. The service merges its own always-available handles (db /
	 * sessionManager / inputQueue) on top at read time (buildHookDeps).
	 */
	setHookDeps(deps: HookWiringDeps): void {
		this.hookDeps = deps ?? {};
	}
	getSessionManager(): SessionManager | null {
		return this.sessionManager;
	}
	/**
	 * Step 1B: assemble the per-loop hook wiring deps. Service-owned handles
	 * (db / sessionDb / sessionManager / inputQueue) are always available and
	 * override any same-key field injected via setHookDeps; the rest
	 * (extractionDeps / workflowContext) come from server/index.ts injection.
	 */
	private buildHookDeps(): HookWiringDeps {
		return {
			...this.hookDeps,
			db: this.db,
			sessionDb: this.db,
			sessionManager: this.sessionManager ?? undefined,
			inputQueue: this.inputQueue,
		};
	}

	/**
	 * Step 1C: fire the session-lifecycle SessionStart hook on a freshly built
	 * loop. Fires AFTER the loop is registered + added to `this.loops` so a
	 * handler that re-enters the service (e.g. metrics via sessionManager) sees
	 * a consistent map. loopKind defaults to "main" — agent-service only builds
	 * main loops (delegated sub-loops are built in subagent-delegator and
	 * register/fire their own lifecycle on their own registry).
	 */
	private async fireSessionStart(loop: AgentLoop, agentId: string, sessionId: string, loopKind: "main" | "delegated" = "main"): Promise<void> {
		try {
			await loop.registry.trigger("SessionStart", {
				agentId,
				sessionId,
				loopKind,
				timestamp: Date.now(),
			});
		} catch (err) {
			log.warn("agent", `SessionStart fire failed for ${sessionId}: ${(err as Error)?.message}`);
		}
	}

	/**
	 * Step 1C: fire the session-lifecycle SessionClose hook on a loop about to
	 * be destroyed. Best-effort — must run BEFORE SessionManager.dispose() /
	 * db.close() on the shutdown path so handlers (e.g. metrics idle) can still
	 * touch live stores. Swallows errors so a failing handler can't block
	 * teardown.
	 */
	private async fireSessionClose(loop: AgentLoop, agentId: string, sessionId: string, loopKind: "main" | "delegated" = "main"): Promise<void> {
		try {
			await loop.registry.trigger("SessionClose", {
				agentId,
				sessionId,
				loopKind,
				timestamp: Date.now(),
			});
		} catch (err) {
			log.warn("agent", `SessionClose fire failed for ${sessionId}: ${(err as Error)?.message}`);
		}
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
	/**
	 * Live in-memory task tree for a session (the same source the agent's
	 * TaskList reads), so the UI TaskTree and the agent agree on count/status
	 * and bash background tasks are visible. Flat TaskInfo[] with parentTaskId;
	 * empty when the session has no live loop yet.
	 */
	getRuntimeTaskTree(sessionId: string): import("../runtime/types.js").TaskInfo[] {
		// Memory-only by design (UI TaskTree and agent TaskList share this live
		// source, including bash background tasks that aren't persisted). The
		// restart history reload happens at loop creation — see
		// createLoopForSession → loop.restoreDelegatedTasks — NOT here.
		return this.loops.get(sessionId)?.getRuntimeTaskTree() ?? [];
	}

	/**
	 * Compute the domain capability handles to surface for a toolPolicy. See
	 * the CapabilityHandles type above for the rationale (single source shared
	 * by loop creation and hot config-sync).
	 */
	private capabilityHandlesFor(policy: SessionConfig["toolPolicy"] | undefined): CapabilityHandles {
		const on = (name: string): boolean => toolEnabled(policy, name);
		const caps: CapabilityHandles = {};
		if (this.management && (on("Project") || on("AgentRegistry") || on("Cron"))) caps.management = this.management;
		if (this.wikiStore && on("Wiki")) caps.wikiStore = this.wikiStore;
		// project-flow F3: Flow is the single requirement-flow entry point (old
		// CreateRequirement / CreateRequirementWithDoc / verify retired). Flow's
		// compound verify action needs the requirement store + pmService (the
		// archivist-merge close). delegateTask is wired by agent-loop on every
		// session, so it's not gated here.
		if (this.requirementStore && on("Flow")) caps.requirementStore = this.requirementStore;
		if (this.pmService && on("Flow")) caps.pmService = this.pmService;
		return caps;
	}
	evictSessionFromMemory(sessionId: string): void {
		// v0.8 (M5): mechanism 3 — close flush. Fire extractor A on the tail
		// batch (anything after the last extraction cursor) so session death
		// doesn't lose content. fire-and-forget: we kick it off and don't
		// await (eviction is synchronous from the session-manager's POV and
		// must not block on LLM calls).
		try {
			if (this.wikiStoreGlobal) {
				const { closeFlushSession } = require("../runtime/hooks/extraction-hooks.js") as typeof import("../runtime/hooks/extraction-hooks.js");
				void closeFlushSession({
					sessionId,
					resolveConfig: () => this.buildSessionConfigForEviction(sessionId),
					resolveProviders: () => this.providerConfigs,
				}).catch((err: any) => log.warn("agent", `close flush failed: ${err?.message}`));
			}
		} catch (err) {
			log.warn("agent", `close flush dispatch failed: ${(err as Error)?.message}`);
		}
		const loop = this.loops.get(sessionId);
		if (loop) {
			// Resolve the owning agentId BEFORE we clear activeSessions below.
			let ownerAgentId = "__default__";
			for (const [aid, sid] of this.activeSessions) {
				if (sid === sessionId) { ownerAgentId = aid; break; }
			}
			// Step 1C: SessionClose for the loop being evicted. Fire-and-forget
			// (eviction is synchronous from session-manager's POV); metrics idle
			// + registry teardown must not block eviction.
			void this.fireSessionClose(loop, ownerAgentId, sessionId, "main");
			loop.abort();
			this.loops.delete(sessionId);
		}
		this.runStates.delete(sessionId);
		for (const [agentId, sid] of this.activeSessions) {
			if (sid === sessionId) { this.activeSessions.delete(agentId); break; }
		}
	}

	/**
	 * v0.8 (M5): reconstruct a minimal SessionConfig for a session being
	 * evicted, so the close-flush extractor (which needs provider/model +
	 * wikiStoreGlobal + db) can run. We don't have the original loop's
	 * SessionConfig in hand anymore; rebuild from agent + defaults.
	 */
	private buildSessionConfigForEviction(sessionId: string): import("../runtime/types.js").SessionConfig | undefined {
		// Find the agent that owned this session by scanning activeSessions
		// (already partially cleared, but the lookup happens BEFORE we clear
		// below in evictSessionFromMemory — actually, this is called from
		// evictSessionFromMemory; we resolved sessionId from the caller and
		// haven't cleared activeSessions yet at the point closeFlushSession
		// runs). To be safe, also check by scanning runStates (the agentId
		// is recorded there).
		let agentId = "__default__";
		for (const [aid, sid] of this.activeSessions) {
			if (sid === sessionId) { agentId = aid; break; }
		}
		const state = this.runStates.get(sessionId);
		if (state?.agentId) agentId = state.agentId;
		const agent = this.agentStore?.get(agentId);
		const sessionRec = this.db.getSession(sessionId);
		const cfg: import("../runtime/types.js").SessionConfig = {
			agentId,
			workspaceDir: sessionRec?.context?.workspaceDir || agent?.workspaceDir || this.workspaceDir,
			systemPrompt: "",
			modelId: agent?.model || this.defaultModel || "",
			providerName: agent?.provider || this.defaultProvider || "",
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
		};
		// Re-attach M5 fields used by the extraction hooks.
		if (this.wikiStoreGlobal) (cfg as any).wikiStoreGlobal = this.wikiStoreGlobal;
		if (this.extractorsConfig) (cfg as any).extractors = this.extractorsConfig;
		// Re-attach compression config (the extraction hook doesn't strictly
		// need it but other code paths might run during the flush).
		(cfg as any).compression = this.config.compression;
		return cfg;
	}
	subscribe(cb: StreamCallback): () => void {
		this.subscribers.add(cb);
		return () => { this.subscribers.delete(cb); };
	}
	// ─── State queries — per-agent ─────────────────────────────────
	/** 该 session 是否正在跑(isBusy)。供 ProjectPage activeSessions 标"running"。 */
	isSessionRunning(sessionId: string): boolean {
		return !!this.runStates.get(sessionId)?.isBusy;
	}

	/**
	 * Mark a session as running (isBusy=true) and emit the authoritative
	 * "turn started" signal. The renderer's streaming flag / button state
	 * follows this event instead of an optimistic UI flag, so every entry
	 * point — chat sendPrompt, work trigger (sendProjectPrompt), cron, and
	 * recovery — flips the UI the same way. Mirrors agent_end clearing
	 * isBusy in handleRuntimeEvent.
	 */
	private markRunning(sessionId: string, agentId: string): void {
		const state = this.runStates.get(sessionId) ?? { agentId, isBusy: false, streamingText: "", toolCalls: [] };
		state.isBusy = true;
		state.streamingText = "";
		state.toolCalls = [];
		this.runStates.set(sessionId, state);
		this.emit({ type: "session_running", sessionId, agentId });
	}

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
		// v0.8: context handles are injected by CONFIG (which domain tools the
		// agent's toolPolicy enables), NOT by identity/roleTag. toolPolicy is the
		// single source of truth; buildToolsSet still makes the final tool
		// visibility call downstream, so injecting a handle that goes unused is
		// harmless — this only opens the door, policy walks through it. See the
		// injection block below (replaces the retired roleTag dispatch).
		// cwd + contextBundle 都从 session 记录取(与右侧文件树同源 session.context)。
		// 不设 contextBundle → resolveAnchors 退到 GLOBAL_ROOT、不注入项目 wiki outline,
		// chat 在 project session 发消息时 agent 看不到 wiki → 只好用文件工具探索。
		const sessionRec = this.db.getSession(sessionId);
		const cwd = sessionRec?.context?.workspaceDir || agent?.workspaceDir || this.workspaceDir;
		log.agent("Creating runtime for agent:", agentId, "session:", sessionId, "cwd:", cwd);
		const systemPrompt = agent?.systemPrompt ?? "";
		const guidelines = this.config.systemPrompt?.guidelines;
		const sessionConfig: SessionConfig = {
			agentId,
			workspaceDir: cwd,
			contextBundle: sessionRec?.context,
			systemPrompt,
			guidelines,
			contextConfig: agent?.contextConfig,
			compression: this.config.compression,
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
			// v0.8 (P2 §11.5): subagents + target resolver (replaces retired
			// getAgentToolEntries). subagents come from AgentRecord.subagents;
			// the resolver reads the target agent's identity from agentStore.
			subagents: agent?.subagents ?? [],
			resolveSubagentTarget: (targetId: string) => {
				const a = this.agentStore?.get(targetId);
				if (!a) return undefined;
				return {
					id: a.id,
					name: a.name,
					systemPrompt: a.systemPrompt,
					model: a.model,
					toolPolicy: a.toolPolicy,
				};
			},
			// v0.8 (delegation refactor): LIVE resolver — same source as
			// resolveSubagentTarget but also surfaces subagents, so the Agent
			// tool can list the caller's delegatable set + resolve named targets
			// fresh every call (independent of the loop-build-time snapshot).
			resolveAgent: (agentId: string) => {
				const a = this.agentStore?.get(agentId);
				if (!a) return undefined;
				return {
					id: a.id,
					name: a.name,
					systemPrompt: a.systemPrompt,
					model: a.model,
					toolPolicy: a.toolPolicy,
					subagents: a.subagents,
				};
			},
			getToolConfig: () => this.registry.getToolConfig(),
		};
		// v0.8: inject context handles by CONFIG. `on(name)` mirrors
		// buildToolsSet's enabled-check (toolPolicy.tools → autoApprove →
		// DEFAULT_ENABLED). Domain tools declare the capability; the matching
		// service handle is surfaced so CONDITIONAL_TOOLS lets the tool through.
		const caps = this.capabilityHandlesFor(sessionConfig.toolPolicy);
		if (caps.management) (sessionConfig as any).management = caps.management;
		if (caps.wikiStore) (sessionConfig as any).wikiStore = caps.wikiStore;
		if (caps.requirementStore) (sessionConfig as any).requirementStore = caps.requirementStore;
		if (caps.pmService) (sessionConfig as any).pmService = caps.pmService;
		// project-flow F2: surface the hub's emitTransition so the Flow tool can
		// fire named hook signals (requirements.<signal>) without the runtime
		// layer importing the server-layer hub (conventions.md). Only Flow-
		// capable sessions need it; requirementStore gating already implies Flow.
		if (caps.requirementStore) (sessionConfig as any).emitTransition = emitTransition;
		// v0.8 (M5): surface the global WikiStore + extractors config onto
		// EVERY session (memory written by extractor A is global/cross-project,
		// so even non-project sessions need access). The extraction hook reads
		// config.extractors + config.wikiStoreGlobal; recall (memory-hooks)
		// reaches config.wikiStoreGlobal for searchMemoryNodes.
		if (this.wikiStoreGlobal) (sessionConfig as any).wikiStoreGlobal = this.wikiStoreGlobal;
		if (this.extractorsConfig) (sessionConfig as any).extractors = this.extractorsConfig;
		// v0.8 (P3 §7.7 #4): surface the tool-call usage log on every session
		// so tool-factory records one row per tool invocation.
		if (this.toolUsageStore) (sessionConfig as any).toolUsageStore = this.toolUsageStore;
		// v0.8 (P1 §10.6): copy the agent's free wikiAnchors onto the session
		// config so the loop can resolve + inject them (system + context
		// channels). Auto anchors (memory + project) are derived from the
		// contextBundle inside the loop.
		if (agent?.wikiAnchors) (sessionConfig as any).wikiAnchors = agent.wikiAnchors;
		// Step 1B: attach hook wiring deps so this loop's SubagentDelegator can
		// register delegated sub-loops with the same set. The main loop's own
		// registration happens below (right after construction).
		sessionConfig.hookWiringDeps = this.buildHookDeps();
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
		// Step 1B: register the main-loop hook set on the loop's own registry.
		registerHooksForLoop(loop.registry, "main", this.buildHookDeps());
		this.loops.set(sessionId, loop);
		// Restore persisted delegated tasks into the live registry so the
		// memory-only getRuntimeTaskTree reflects history after restart/eviction.
		// Roots = tasks this chat session dispatched (parent_session_id); expand
		// each by root_task_id to pull nested sub-agents (whose parent_session_id
		// is a delegated session). Bash background tasks aren't persisted — they
		// stay gone on restart, which is correct.
		try {
			const roots = this.db.listDelegatedTasks?.({ parentSessionId: sessionId }) ?? [];
			const seenRoot = new Set<string>();
			const toRestore: DelegatedTaskRecord[] = [];
			for (const root of roots) {
				const rid = root.rootTaskId ?? root.id;
				if (seenRoot.has(rid)) continue;
				seenRoot.add(rid);
				const subtree = this.db.listDelegatedTasks?.({ rootTaskId: rid }) ?? [];
				toRestore.push(...(subtree.length ? subtree : [root]));
			}
			if (toRestore.length) loop.restoreDelegatedTasks(toRestore);
		} catch {
			// db optional / not yet initialized — skip history restore.
		}
		this.sessionManager?.trackSessionCreated(sessionId, agentId);
		this.sessionManager?.trackSessionActivated(sessionId);
		log.agent("Runtime ready for:", agentId, "session:", sessionId);
		// Step 1C: fire session-lifecycle SessionStart now that the loop is
		// built + registered + tracked. Fire-and-forget: handlers must not
		// block loop creation (the loop is returned synchronously to callers
		// like sendPrompt which then drive run()).
		void this.fireSessionStart(loop, agentId, sessionId, "main");
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
		// C2 input queue: if this session is already running, enqueue instead of
		// starting a concurrent run on the same loop (which would clash). The
		// running sendPrompt drains the queue after its run() returns.
		if (this.isSessionRunning(sessionId)) {
			this.inputQueue.enqueue(sessionId, text);
			log.agent("Session busy — input queued for:", agentId, "session:", sessionId);
			return;
		}
		log.agent("Sending prompt to:", agentId, "session:", sessionId, "length:", text.length);
		this.sessionManager?.trackSessionQueued(sessionId);
		this.markRunning(sessionId, agentId);
		try {
			await loop.run(text);
			log.agent("Prompt completed for:", agentId);
		} catch (err) {
			log.error("agent", "Prompt error:", (err as Error).message);
			// sessionId is REQUIRED on terminal events: the renderer keys
			// finishStreaming off it. Without it, a background run's error would
			// be attributed to whatever session the user is viewing and wrongly
			// flip its Stop button back to Send mid-run.
			this.emit({ type: "error", sessionId, error: (err as Error).message, agentId });
		}
		// C2 drain: send queued inputs as subsequent turns while any remain.
		// insert_now items are handled mid-run by the PrepareStep hook; this
		// drain only handles "queued" items (next-turn semantics).
		let next = this.inputQueue.drainNextQueued(sessionId);
		while (next !== undefined) {
			try {
				await loop.run(next);
			} catch (err) {
				log.error("agent", "Drained prompt error:", (err as Error).message);
				this.emit({ type: "error", sessionId, error: (err as Error).message, agentId });
				break;
			}
			next = this.inputQueue.drainNextQueued(sessionId);
		}
	}
	/**
	 * v0.8 project-work(取代工作流角色的去-role 触发器):身份 prompt + toolPolicy
	 * 全用 agent 自带(来自模板),不调任何 role config。注入 wikiStore/projectContext/
	 * wikiAnchors + 可选 stores(req/task/orchestrate/git)+ workId(供 T2 hook 按
	 * work.contextPolicy 注入)。所有可触发工作(cron/hook/手动 + lead/analyst)走这里。
	 */
	async sendProjectPrompt(
		agentId: string,
		sessionId: string,
		prompt: string,
		context: {
			projectId?: string;
			projectPath?: string;
			projectName?: string;
			wikiStore?: any;
			activeRequirementId?: string;
			/** v0.8 project-work:触发本 turn 的工位(workflow-context-hook 据此注入 T2)。 */
			workId?: string;
			/** 可选注入(需求管理工位等需要):工具上下文 stores + git。 */
			requirementStore?: any;
			taskStepStore?: any;
			orchestratePlanStore?: any;
			orchestrateManifestStore?: any;
			gitIntegration?: any;
		},
	): Promise<{ skipped?: "busy" }> {
		const agent = this.agentStore?.get(agentId);
		if (!agent) throw new Error(`Agent not found: ${agentId}`);

		const systemPrompt = agent.systemPrompt || "";
		const cwd = context.projectPath || agent.workspaceDir || this.workspaceDir;

		const sessionConfig: SessionConfig = {
			agentId,
			workspaceDir: cwd,
			systemPrompt,
			guidelines: this.config.systemPrompt?.guidelines,
			compression: this.config.compression,
			modelId: agent.model || this.defaultModel || "",
			providerName: agent.provider || this.defaultProvider || "",
			thinkingLevel: agent.thinkingLevel,
			sessionId,
			db: this.db,
			// 去-role:toolPolicy 全用 agent 自带(来自模板),不再 roleConfig 覆盖。
			toolPolicy: {
				autoApprove: agent.toolPolicy?.autoApprove ?? this.config.toolPolicy.autoApprove ?? [],
				blockedTools: agent.toolPolicy?.blockedTools ?? this.config.toolPolicy.blockedTools ?? [],
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
			subagents: agent.subagents ?? [],
			resolveSubagentTarget: (targetId: string) => {
				const a = this.agentStore?.get(targetId);
				if (!a) return undefined;
				return { id: a.id, name: a.name, systemPrompt: a.systemPrompt, model: a.model, toolPolicy: a.toolPolicy };
			},
			resolveAgent: (otherId: string) => {
				const a = this.agentStore?.get(otherId);
				if (!a) return undefined;
				return { id: a.id, name: a.name, systemPrompt: a.systemPrompt, model: a.model, toolPolicy: a.toolPolicy, subagents: a.subagents };
			},
			getToolConfig: () => this.registry.getToolConfig(),
			// workId 由 project-work 触发器传入(供 T2 hook 按 work.contextPolicy 注入)。
			workId: context.workId,
			projectContext: context.projectId ? {
				projectId: context.projectId,
				projectName: context.projectName || "",
				projectPath: context.projectPath || "",
				activeRequirementId: context.activeRequirementId,
			} : undefined,
			// v0.8 (P1 §10.6): contextBundle 派生自动项目锚点(wiki-root:<projectId>)。
			// 漏设会让 resolveAnchors 退到 GLOBAL_ROOT → scope=整棵树(跨项目泄露)+
			// 项目子树 outline 不注入 system prompt → agent 看不到项目节点,只能 search。
			contextBundle: context.projectId ? {
				projectId: context.projectId,
				workspaceDir: cwd,
				wikiRootNodeId: "wiki-root:" + context.projectId,
			} : undefined,
			wikiStore: context.wikiStore,
		} as any;

		// 可选工具上下文 stores + git(需求管理工位等需要,与 sendRolePrompt 对齐)。
		(sessionConfig as any).requirementStore = context.requirementStore;
		(sessionConfig as any).taskStepStore = context.taskStepStore;
		(sessionConfig as any).orchestratePlanStore = context.orchestratePlanStore;
		(sessionConfig as any).orchestrateManifestStore = context.orchestrateManifestStore;
		(sessionConfig as any).gitIntegration = context.gitIntegration;

		// P1 §10.6 wiki anchor injection —— archivist 写 wiki 靠它解析锚点。
		if (this.wikiStoreGlobal) (sessionConfig as any).wikiStoreGlobal = this.wikiStoreGlobal;
		if (agent?.wikiAnchors) (sessionConfig as any).wikiAnchors = agent.wikiAnchors;
		// Step 1B: thread hook wiring deps (subagent-delegator uses them).
		sessionConfig.hookWiringDeps = this.buildHookDeps();

		let loop = this.loops.get(sessionId);
		if (!loop) {
			loop = new AgentLoop(sessionConfig, this.providerConfigs, {
				onEvent: (event: StreamEvent) => {
					this.handleRuntimeEvent(agentId, event);
				},
			});
			// Step 1B: register the main-loop hook set on the loop's own registry.
			registerHooksForLoop(loop.registry, "main", this.buildHookDeps());
			this.loops.set(sessionId, loop);
			// Step 1C: fire session-lifecycle SessionStart for this newly-built
			// project loop (mirrors createLoopForSession). Fire-and-forget.
			void this.fireSessionStart(loop, agentId, sessionId, "main");
		}

		this.activeSessions.set(agentId, sessionId);
		if (!this.runStates.has(sessionId)) {
			this.runStates.set(sessionId, { agentId, isBusy: false, streamingText: "", toolCalls: [] });
		}

		const state = this.runStates.get(sessionId)!;
		// A 方案:上一 turn 未完成(session 正在跑)→ 干净 skip,不丢/不排,不覆盖
		// in-flight 的流式状态(work 都有重发源:cron/hook/手动重试,skip 比 heap 排队合理)。
		if (state.isBusy) return { skipped: "busy" };
		this.markRunning(sessionId, agentId);

		log.agent("Sending project prompt to:", agentId, "session:", sessionId);

		// fire-and-forget(对齐 chat-router 的 sendPrompt):立即返回,长任务
		// (wiki 充实/重建等几分钟到十几分钟)不再把 trigger 的 HTTP 响应挂到
		// 整轮跑完 → 修复 UND_ERR_HEADERS_TIMEOUT(主进程 fetch 等响应头到 5min)。
		// isBusy 由 agent_end 事件复位(见 handleRuntimeEvent),与 await 路径等价;
		// busy-skip 仍同步生效(state.isBusy 已在上方置 true);错误经 onEvent →
		// error 事件推前端。
		void loop.run(prompt).then(() => {
			log.agent("Project prompt completed for:", agentId);
		}).catch((err) => {
			log.error("agent", "Project prompt error:", (err as Error).message);
			// sessionId required so the renderer scopes the error to THIS
			// session instead of clobbering the viewed session's streaming flag.
			this.emit({ type: "error", sessionId, error: (err as Error).message, agentId });
		});
		return {};
	}
	// v0.8 (M0): createRoleLoopFactory removed. Sub-agent dispatch now flows
	// through delegateTask (extended signature carries target agent full
	// config + per-call override + caller bundle inheritance). Lead/orchestrate
	// callers must use the agent-as-tool + toolPolicy path (decision 16).
	/**
	 * Abort a running session. sessionId is the authoritative target — session
	 * state is independent, so stopping one session must never touch another.
	 * The chat Stop button always passes the sessionId it wants stopped.
	 *
	 * Legacy no-arg / agentId calls (raw WS path) abort ALL busy sessions —
	 * kept for back-comat but intentionally not used by the chat UI, which
	 * would otherwise cascade-stop other sessions of the same agent.
	 */
	async abort(agentId?: string, sessionId?: string): Promise<void> {
		if (sessionId) {
			this.loops.get(sessionId)?.abort();
			return;
		}
		if (agentId) {
			const sid = this.activeSessions.get(agentId);
			if (sid) this.loops.get(sid)?.abort();
			return;
		}
		// No target specified (legacy): abort every busy session.
		for (const [sid, s] of this.runStates) {
			if (s.isBusy) this.loops.get(sid)?.abort();
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
				// Pre-populate turn seq so the TurnStart hook skips creating a
				// duplicate turn_state row (the existing row carries the step
				// checkpoint we resume from).
				setSessionTurnSeq(turn.sessionId, turn.turnSeq);
				setTurnSeq(turn.sessionId, turn.turnSeq);
				// Step 2D: UI state derived from the step checkpoint. The legacy
				// phase-based "tools_executing" branch is gone (durable phase is
				// now only a terminal marker). A recovered session always shows
				// as streaming so the user sees the resume in flight; the step
				// checkpoint determines resume-from, not UI state.
				this.sessionManager?.trackSessionStreaming(turn.sessionId);
				this.markRunning(turn.sessionId, agentId);
				log.db(`Recovering agent ${agentId}, session ${turn.sessionId}, phase ${turn.phase}, lastStep=${turn.lastCompletedStepSeq ?? "none"}`);
				// Fire-and-forget: resume in background so we don't block startup.
				// Pass the step checkpoint so resume() continues from the next
				// step (completed steps already in messages via turns-table rebuild).
				loop.resume(turn.turnSeq, turn.lastCompletedStepSeq ?? undefined).then(() => {
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

		// listAllSessions is ordered by updated_at DESC, so for each agent the
		// FIRST session we encounter is its most-recently-active one. Track
		// which agents we've already anchored so the loop (which iterates
		// oldest→newest within later agents) doesn't overwrite the most-recent
		// anchor with a stale session — that was the bug: every iteration did
		// `activeSessions.set(agentId, session.id)`, leaving each agent pointing
		// at whatever session the loop visited LAST (the oldest).
		const anchoredAgents = new Set<string>();

		for (const session of allSessions) {
			try {
				if (this.loops.has(session.id)) continue;

				const agent = this.agentStore?.list().find((a) => a.id === session.agentId);
				this.createLoopForSession(session.agentId, session.id, agent ?? undefined);
				if (!anchoredAgents.has(session.agentId)) {
					this.activeSessions.set(session.agentId, session.id);
					anchoredAgents.add(session.agentId);
				}
			} catch (err) {
				log.error("recovery", `Failed to restore ${session.id}:`, (err as Error).message);
			}
		}
	}

	// ─── Session activation — runtime as single source of truth for UI ───
	async activateSession(agentId: string, sessionId?: string): Promise<string> {
		// Resolve target session. Precedence:
		//   1. explicit sessionId (switch)
		//   2. the session already live in memory for this agent
		//   3. the MOST RECENTLY ACTIVE session (by updated_at) — i.e. the one
		//      the user last chatted in. This is what should open when they
		//      pick the agent again.
		//   4. the sticky main session (legacy fallback)
		//   5. create a new session
		// (3) is the fix: previously this fell straight to (4) getMainSession,
		// whose is_main flag only moves on new/switch/clear — so chatting in a
		// non-main session bumped its updated_at but left is_main pointing
		// elsewhere, and re-opening the agent showed the stale main.
		const candidate = sessionId ?? this.activeSessions.get(agentId);
		let resolvedSessionId: string;
		let session: { id: string; agentId: string; isMain: boolean; title: string | null; createdAt: string; updatedAt: string; inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
		if (candidate) {
			session = this.db.getSession(candidate);
		}
		if (!session) {
			session = this.db.getMostRecentSession(agentId);
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
		// Build the full init payload (messages + tokens + todos + pending AskUser)
		// and emit session_init. getSessionInitPayload is also the pull path used
		// by GET /api/sessions/init/:sessionId — push and pull share ONE builder
		// so they can never drift.
		const payload = this.getSessionInitPayload(resolvedSessionId);
		if (payload) {
			this.emit({
				type: "session_init",
				agentId,
				sessionId: resolvedSessionId,
				...payload,
			});
		}
		return resolvedSessionId;
	}

	/**
	 * 构建 session 的完整 init payload(messages + token 信息 + todos + 未决
	 * AskUser 问题)。供两条路径共用,保证 push(activateSession 的 session_init)
	 * 与 pull(前端显示时 GET /api/sessions/init/:sessionId)永不漂移。
	 *
	 * 纯读:确保 loop 存在(读 DB turns + 实时 streaming 状态),不改 active 指针。
	 * 找不到 session 返回 null。
	 */
	getSessionInitPayload(sessionId: string): {
		messages: any[];
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		contextWindow: number;
		contextUsage: number;
		todos: any[];
		pendingQuestion: { requestId: string; questions: any[] } | null;
		isRunning: boolean;
	} | null {
		const session = this.db.getSession(sessionId);
		if (!session) return null;
		const agentId = session.agentId;
		// Ensure loop exists — this also creates runState
		let loop = this.loops.get(sessionId);
		if (!loop) {
			const agent = this.agentStore
				? this.agentStore.list().find((a) => a.id === agentId)
				: undefined;
			loop = this.createLoopForSession(agentId, sessionId, agent);
		}
		// Refresh turns cache so incremental persists are visible
		loop.refreshTurnsCache();
		const messages = this.buildSessionInitMessages(agentId, sessionId, loop);
		const pendingQuestion = pendingResponses.getPendingForSession(sessionId);
		return {
			messages,
			inputTokens: loop.getEstimatedTokens(),
			outputTokens: session.outputTokens ?? 0,
			totalTokens: (session.outputTokens ?? 0) + loop.getEstimatedTokens(),
			contextWindow: loop.getContextWindow(),
			contextUsage: loop.getContextUsage(),
			todos: getSessionTodos(sessionId),
			pendingQuestion,
			// 该 session 当前是否在跑。前端 pull-on-display 据此自愈清掉残留的
			// streaming 指示(后台报错停止后 agent_end 若被丢会卡 streaming → Send 禁用)。
			isRunning: !!this.runStates.get(sessionId)?.isBusy,
		};
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
	/**
	 * Normalize tool-call blocks' `args` to a JSON STRING. The renderer's
	 * ToolBlock treats `block.args` as a string (JSON.parse(block.args)) and the
	 * ToolCallBlock type declares `args?: string`. But the DB stores args as a
	 * raw OBJECT (turn-recorder.addToolStart stores e.input verbatim, and the
	 * stringify/parse round-trip preserves the object shape) — so on session
	 * restore, JSON.parse(object) throws and the UI silently drops the call
	 * arguments (only the result shows). The live path avoids this because
	 * AppLayout stringifies args before addToolCall. This restores parity.
	 */
	private normalizeBlockArgs(blocks: any[]): any[] {
		return normalizeBlockArgsForUi(blocks);
	}

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
					// id prefix distinguishes role so user/assistant in the same
					// turnGroup get DIFFERENT React keys. Editing/deleting parses
					// the trailing number via parseInt(id.slice(1)), so the prefix
					// letter is opaque to the router. Duplicate keys (both `m${tg}`)
					// caused React to mis-reconcile on session switch and leave
					// stale DOM bubbles — see tests/e2e/session-switch-repeated.
					id: `u${tg}`,
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

				this.normalizeBlockArgs(allBlocks);

				const text = allBlocks
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text || "")
					.join("");

				result.push({
					id: `a${tg}`,
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
				const liveBlocks = this.normalizeBlockArgs(recorderBlocks.map((b: any) => ({ ...b })));
				const text = liveBlocks
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text || "")
					.join("");
				result.push({
					id: "a-streaming",
					role: "assistant",
					text,
					blocks: liveBlocks,
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
					id: `u${t.seq}`,
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
				this.normalizeBlockArgs(blocks);
				const text = blocks
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text || "")
					.join("");
				result.push({
					id: `a${t.seq}`,
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
						id: "a-streaming",
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
	/**
	 * Step 1C: now async. SessionClose MUST fire BEFORE SessionManager.dispose()
	 * / db.close() so handlers (e.g. metrics idle, registry teardown) still see
	 * live stores. We snapshot the live loops + their owning agentIds, await all
	 * SessionClose fires, then proceed with the existing teardown order:
	 * SessionManager.dispose() → db.close() → loop.abort() (DB-first keeps
	 * turn_state rows incomplete for recovery on next startup).
	 *
	 * Each SessionClose fire is awaited individually but errors are swallowed
	 * inside fireSessionClose, so one failing handler can't block shutdown.
	 */
	async dispose(): Promise<void> {
		// Snapshot loops + owning agentIds BEFORE mutating any maps (the fires
		// below must not race with eviction/invalidation mid-shutdown).
		const live: Array<{ loop: AgentLoop; agentId: string; sessionId: string }> = [];
		for (const [sessionId, loop] of this.loops) {
			const state = this.runStates.get(sessionId);
			let agentId = state?.agentId;
			if (!agentId) {
				for (const [aid, sid] of this.activeSessions) {
					if (sid === sessionId) { agentId = aid; break; }
				}
			}
			live.push({ loop, agentId: agentId ?? "__default__", sessionId });
		}
		// SessionClose first — handlers can still touch SessionManager + DB.
		await Promise.all(live.map(({ loop, agentId, sessionId }) =>
			this.fireSessionClose(loop, agentId, sessionId, "main"),
		));

		this.sessionManager?.stopTtlCleanup();
		this.sessionManager?.dispose();
		// Close DB BEFORE aborting loops. This prevents TurnEnd hooks from
		// completing turn_state rows — they stay incomplete so that
		// recoverIncompleteSessions() can resume them on next startup.
		this.db.close();
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
			// Step 1C: SessionClose for the loop being invalidated (provider/
			// workspace change tore it down). Fire-and-forget.
			void this.fireSessionClose(loop, state?.agentId ?? "__default__", sessionId, "main");
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
export function createAgentService(workspaceDir: string, sessionDb?: SessionDB, registry?: ToolRegistry, mcp?: MCPManager): AgentService {
	return new AgentService(workspaceDir, sessionDb, registry, mcp);
}

/**
 * Normalize tool-call blocks' `args` to a JSON STRING (mutates + returns).
 *
 * Contract gap this closes: the renderer's ToolBlock treats `block.args` as a
 * STRING and does `JSON.parse(block.args)`, and `ToolCallBlock.args?: string`.
 * But the DB stores args as a raw OBJECT (turn-recorder.addToolStart stores
 * e.input verbatim; the JSON.stringify/parse round-trip preserves object
 * shape). So on session restore JSON.parse(object) throws → the UI silently
 * drops the call arguments (only the result shows). The live path avoids this
 * because AppLayout stringifies args in the tool_start handler. This restores
 * parity for the restore path. Exported so the contract is unit-testable.
 */
export function normalizeBlockArgsForUi(blocks: any[]): any[] {
	for (const b of blocks) {
		if (b && b.type === "tool" && b.args !== undefined && typeof b.args !== "string") {
			try {
				b.args = JSON.stringify(b.args);
			} catch {
				b.args = String(b.args);
			}
		}
	}
	return blocks;
}
