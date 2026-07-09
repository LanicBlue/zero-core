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
	TaskInfo,
} from "./types.js";
// tool-decoupling sub-5(B2):AgentLoop 直建 CallerCtx(不再经 ctxToCallerCtx 桥)。
import type { CallerCtx, TodoAccessor, TaskRegistryAccessor, DelegateFns, AgentResolvers } from "../tools/types.js";
import { resolveModel, getContextWindow, getMultimodal } from "./provider-factory.js";
import { AgentSession } from "./session.js";
import { buildToolsSet } from "../tools/index.js";
import { renderWorkbench } from "./workbench.js";
import { log } from "../core/logger.js";
import { HookRegistry } from "../core/hook-registry.js";
import { classifyError, isTransientError, userFriendlyMessage, MAX_RETRIES, BASE_DELAY_MS } from "./agent-utils.js";
import { TurnRecorder } from "./turn-recorder.js";
import { SystemPromptAssembler } from "./prompt-sections.js";
import { buildContextMessage } from "./context-message.js";
import { SubagentDelegator } from "./subagent-delegator.js";
import { ToolRateLimiter } from "./tool-rate-limiter.js";
// platform-observability ②.4 (sub-3): turn 级 ALS context,传 tier + 身份给
// provider-factory acquire → 并发队列按 tier 优先级出队。
import { runInConcurrencyContext, turnSourceToTier } from "./concurrency-context.js";
import type { WikiStore } from "../server/wiki-node-store.js";
import type { DelegatedTaskRecord } from "../shared/types.js";
import {
	resolveAnchors,
	anchorNodeIds,
	renderSystemAnchors,
	renderContextAnchors,
	type ResolvedAnchor,
} from "./wiki-anchor-injection.js";
// sub-7 (anchor merger): renderSystemAnchors + renderContextAnchors collapse
// into the single `wiki-system-anchors` system section (root summary + one
// layer, both channels unioned). renderContextAnchors stays exported so tests
// can call it directly; the executeStream path no longer renders it into the
// per-turn <context> block (the context channel now carries only Recalled
// Memories — design §1.2).

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

/**
 * sub-4 (TaskGet recent-calls): compact a tool-call's args string for display
 * in the parent's TaskGet(running) view. Long args get truncated to a one-line
 * summary so the recent-calls list stays readable; output is NEVER included
 * (that's reserved for TaskGet(completed)'s full result). Same intent as
 * tool-factory's summarizeParams but trimmed tighter (parent only needs a hint
 * of what the sub-agent is doing, not the full payload).
 */
function summarizeArgs(argsText: string): string {
	const trimmed = argsText.trim().replace(/\s+/g, " ");
	if (trimmed.length <= 120) return trimmed;
	return trimmed.slice(0, 120) + "…";
}

export class AgentLoop implements AgentRuntime {
	private session: AgentSession;
	private config: SessionConfig;
	private providers: RuntimeProviderConfig[];
	private callbacks: RuntimeCallbacks;
	private toolContext: ToolExecutionContext;
	/**
	 * tool-decoupling sub-5(B2):CallerCtx 直建于 AgentLoop —— 工具 execute 的
	 * 第二参,host 注入的调用者身份 + per-session 访问器。experimental_context
	 * 同时携带它(经 ToolExecHost 包成 {ctx, callerCtx})和旧 toolContext(供
	 * buildTool wrapper 的 hook / rate-limit / usage-log 读)。删 ctxToCallerCtx 后
	 * 这里的构建是 callerCtx 的唯一来源。
	 *
	 * 每次 streamText 调前重建(per-call toolCallId 不同);访问器闭包捕获
	 * this.delegator / this.config —— 热重载突变(delegator 字段 / subagents /
	 * wikiAnchors / toolConfig)经 this.* 自然反映。
	 */
	private callerCtx!: CallerCtx;
	private delegator: SubagentDelegator;
	private promptAssembler: SystemPromptAssembler;
	private abortController: AbortController | null = null;
	private busy = false;
	/**
	 * sub-5 (Wait rewrite): true while a Wait tool call is suspended inside a
	 * step's streamText. Distinct from `busy` — the loop is still mid-run (the
	 * Wait tool's execute is awaiting inside the SDK), but the session is NOT
	 * "running" for UI/queue purposes: it shows idle and accepts user input as a
	 * wake source (which ends the current turn and starts turn+1). Mirrored to
	 * the server via session_waiting/session_running events so runStates stays
	 * the UI truth source.
	 */
	private waiting = false;
	/**
	 * sub-5: set when a Wait woke with reason "user input". executeStream polls
	 * this at the next step boundary and breaks the step loop → the current
	 * turn ends cleanly (Wait's tool-result is the last block); the user's
	 * queued message then runs as turn+1 (drained by agent-service after run()
	 * returns). Reset per-run.
	 */
	private userInterruptQueued = false;
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
		// multimodal-input sub-3 (#3 wiring): resolve image capability on the
		// SAME path as contextWindow (getMultimodal rides the identical
		// provider.models.find — see provider-factory.ts). Passed into
		// AgentSession so getMessagesMultimodal can apply the image-only inline
		// + current-step rule (design 组件 3). `multimodal===undefined` (manually
		// configured / OpenRouter-uncovered models) → false (safe default).
		const multimodal = getMultimodal(providers, config.providerName, config.modelId);
		this.session = new AgentSession(config.systemPrompt, contextWindow, config.sessionId, config.db, multimodal);

		// v0.8 (P1 §10.6): resolve the global WikiStore + the session's wiki
		// anchor set. config.wikiStore is the ProjectWikiStore back-compat
		// view (or already a WikiStore); .getWikiStore() unwraps it.
		this.wikiStoreGlobal = this.resolveGlobalWikiStore(config);

		// Build prompt sections: base + wiki system-anchor section (cacheable) +
		// work-context system section (on-demand). sub-7 merges the context-
		// channel anchors into the existing `wiki-system-anchors` section (root
		// summary + one layer for both channels); the per-turn <context> block
		// no longer renders an anchors sub-block (context channel = Recalled
		// Memories only, design §1.2).
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
			// sub-7 (Wiki Anchors merger): renderSystemAnchors + the context-
			// channel memory index render TOGETHER into this single cached
			// section. The context channel's per-agent memory anchor used to
			// ride inside <context> every turn; it now joins the project
			// outline here so there is exactly one Wiki Anchors block, and it
			// is cache-stable (refresh only on subtree change, design §1.3 #1).
			sections.push({
				name: "wiki-system-anchors",
				compute: () => {
					const sys = renderSystemAnchors({ wiki: this.wikiStoreGlobal!, anchors: this.wikiAnchors });
					const ctx = renderContextAnchors({ wiki: this.wikiStoreGlobal!, anchors: this.wikiAnchors });
					if (!sys && !ctx) return "";
					if (!ctx) return sys;
					if (!sys) return ctx;
					return sys + "\n\n" + ctx;
				},
				cacheBreak: false,
			});
		}
		// sub-7 (work-context → system): Project / Requirement / Wiki Baseline
		// rendered by a server-built closure (config.workContextSystemSection)
		// — on-demand (cacheBreak:false so the closure re-reads store state
		// each turn) but empty for non-work sessions → section dropped.
		if (config.workContextSystemSection) {
			sections.push({
				name: "work-context",
				compute: () => config.workContextSystemSection!() ?? "",
				cacheBreak: false,
			});
		}
		// skill-system sub-9 (Approach A): skills section. Server-built closure
		// (config.getSkillSection) renders Available Skills list (sub-4 三态)
		// via buildSkillsSection. The closure
		// captures agentStore.get(agentId).skillPolicy + scanSkills() at call
		// time (re-read each turn — cacheBreak:false); agent-service hot-swaps
		// the closure on skillPolicy change and invalidate("skills"). Returns ""
		// when no skills / no policy → section dropped. Mirrors work-context /
		// wiki-anchors DI shape (runtime never imports scanner/store directly).
		if (config.getSkillSection) {
			sections.push({
				name: "skills",
				compute: () => config.getSkillSection!() ?? "",
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

		// N1 (runtime-push-ui-sync): TaskRegistry lives in src/runtime/, so it
		// cannot import the server-layer data-change-hub. It coalesces its own
		// change pings; this loop subscribes and translates them into a
		// runtime:tasks:changed agent:event carrying this loop's sessionId. The
		// renderer treats runtime:* pings uniformly (ping → pull active tree).
		// Subscription lifetime = loop lifetime (no unsubscribe needed; the
		// registry only holds a cb reference, and the loop owns its registry).
		this.delegator.taskRegistry.subscribe(() => {
			this.emit({ type: "runtime:tasks:changed", sessionId: this.config.sessionId } as any);
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
			// sub-4 (TaskKill interrupted→abandon): close the frozen child's
			// turn_state terminal + drop from registry. Complement to stopTask.
			abandonTask: (taskId) => this.delegator.abandonTask(taskId),
			acknowledgeTask: (taskId) => this.delegator.acknowledgeTask(taskId),
			requestTaskFinish: (taskId, options) => this.delegator.requestTaskFinish(taskId, options),
			listDelegatedTasks: (filter) => this.delegator.listDelegatedTasks(filter),
			suspendUntilWake: (opts) => this.delegator.suspendUntilWake(opts),
			// sub-5 (Wait): let the Wait tool announce suspend/resume so the loop
			// can release/reacquire the session "running" state and detect a
			// user-input wake (→ end current turn, start turn+1).
			beginWait: () => { this.beginWaitSuspend(); },
			endWait: (reason) => { this.endWaitSuspend(reason); },
			runBackground: (command, timeoutSec) => this.delegator.runBackground(command, timeoutSec),
			// Step 2E: tool-call ↔ task link — let the Agent tool stamp the
			// recorder's tool-call block with the delegated taskId the moment
			// the delegator mints it (before the sub-agent loop starts, so the
			// parent always holds a durable handle). resumeTask is exposed for
			// the parent's DELIBERATE use (parent-driven recovery: parent calls
			// it after TaskStatus shows an interrupted task) — no auto re-attach.
			setToolCallTaskId: (toolCallId, taskId) => {
				this.recorder.setToolBlockTaskId(toolCallId, undefined, taskId);
			},
			// sub-9 (durable relative-timeout Wait): stamp the wall-clock startedAt
			// onto the calling Wait tool's block so the resume path can compute
			// remaining timeout across a restart. Best-effort via the recorder.
			setWaitStartedAt: (toolCallId, startedAt) => {
				this.recorder.setToolBlockStartedAt(toolCallId, "Wait", startedAt);
			},
			resumeTask: (taskId) => this.delegator.resumeTask(taskId),
			// sub-4 (TaskResume, non-blocking): set up sub-loop + turn_seq guard
			// synchronously, detach the run. Agent tasks only.
			resumeTaskBackground: (taskId) => this.delegator.resumeTaskBackground(taskId),
			// sub-4 (TaskGet recent-calls): name+args summary of a running task's
			// last N tool calls (agent → live sub-loop recorder; bash → command).
			// Output is NEVER included here — completed results come through
			// TaskGet(completed). Runtime→runtime; no DB hop.
			getTaskRecentCalls: (taskId, n) => this.delegator.getTaskRecentCalls(taskId, n),
			rateLimiter: new ToolRateLimiter(),
			// tool-decoupling sub-5(B3):app 级服务(wikiStore / requirementStore /
			// pmService / taskStepStore / management)从 ToolExecutionContext 删除 —
			// 工具直读 getter 单例(决策 1)。loop 仍从 config 解 capabilities,但
			// 不再装进 ctx(避免"装了不用 + 单例漂移")。capabilityHandlesFor 仍把
			// 这些 handles 注入 SessionConfig → 各工具 import getXxx 单例读最新实例。
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
			// tool-decoupling sub-5(B3):`management` 已从 ToolExecutionContext 删除 —
			// AgentRegistry/Project/Cron/Work 工具直读 getManagementService() 单例。
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

	/**
	 * tool-decoupling sub-5(B2):build the CallerCtx that migrated tool execute
	 * reads as its 2nd arg. Replaces the old ctxToCallerCtx bridge — the loop
	 * now constructs callerCtx directly from its own state (delegator / config /
	 * recorder), so tool execute reads host-injected identity, not the legacy
	 * service-grab-bag.
	 *
	 * Per-call (toolCallId varies per invocation). Accessor closures capture
	 * `this` (the loop), so hot-reload mutations (subagents / wikiAnchors /
	 * capabilities / toolConfig) reflect naturally — same as the old bridge,
	 * which read from ctx at call time.
	 *
	 * Mirrors the design's "loop 调:{sessionId, agentId, caller:"internal",
	 * toolCallId, turnSeq, workingDir, todos, taskRegistry, delegateFns,
	 * agentResolvers, emit}" + the sub-4 project-flow / Orchestrate session
	 * state (flowActions / orchestratePlanStore / orchestrateManifestStore /
	 * gitIntegration / activeRequirementId / featureWorkspace). sub-5 transitional
	 * fields (toolConfig / readScope / wikiAnchorNodeIds / contextBundle /
	 * projectId) are still filled from this.toolContext — B4 collapses them.
	 */
	private buildCallerCtx(toolCallId: string): CallerCtx {
		const ctx = this.toolContext;
		const sessionId = ctx.sessionId;
		const agentId = ctx.agentId;

		// todos accessor(G1):proxy to the module-level sessionTodos Map in
		// todo-write.ts, keyed by sessionId/agentId. Same shape as the old bridge.
		const todosAccessor: TodoAccessor = {
			list: () => {
				const mod = require("../tools/todo-write.js") as {
					getSessionTodos: (sessionId: string) => any[];
				};
				if (!sessionId && !agentId) return [];
				const key = sessionId ?? agentId ?? "_default";
				return mod.getSessionTodos(key);
			},
			set: (items) => {
				const mod = require("../tools/todo-write.js") as {
					setSessionTodosForCtx?: (sessionId: string | undefined, agentId: string | undefined, items: any[]) => void;
				};
				mod.setSessionTodosForCtx?.(sessionId, agentId, items);
			},
		};

		// TaskRegistry accessor(G1):proxy to this loop's TaskRegistry snapshot view.
		const taskRegistryAccessor: TaskRegistryAccessor | undefined =
			(ctx.listTasks || ctx.getTaskResult)
				? {
					list: (filter) => {
						const all = ctx.listTasks?.(filter) ?? [];
						return all.map((t: any) => ({
							id: t.id, type: t.type, task: t.task, status: t.status,
							targetAgentId: t.targetAgentId,
						}));
					},
					get: (taskId) => {
						const t = ctx.getTaskResult?.(taskId);
						if (!t) return null;
						return {
							id: t.id, type: t.type, task: t.task, status: t.status,
							targetAgentId: t.targetAgentId,
						};
					},
				}
				: undefined;

		// delegateFns(G1):verbatim pass-through of the loop's delegator/suspend/
		// recorder functions. Same signatures as on ToolExecutionContext.
		const delegateFns: DelegateFns = {
			delegateTask: ctx.delegateTask,
			delegateTaskBackground: ctx.delegateTaskBackground,
			getTaskResult: ctx.getTaskResult,
			listTasks: ctx.listTasks,
			stopTask: ctx.stopTask,
			abandonTask: ctx.abandonTask,
			acknowledgeTask: ctx.acknowledgeTask,
			requestTaskFinish: ctx.requestTaskFinish,
			resumeTaskBackground: ctx.resumeTaskBackground,
			getTaskRecentCalls: ctx.getTaskRecentCalls,
			runBackground: ctx.runBackground,
			suspendUntilWake: ctx.suspendUntilWake,
			beginWait: ctx.beginWait,
			endWait: ctx.endWait,
			setWaitStartedAt: ctx.setWaitStartedAt,
			setToolCallTaskId: ctx.setToolCallTaskId,
		};

		// agentResolvers(G1):LIVE agent-record resolvers for delegation tools.
		const agentResolvers: AgentResolvers = {
			resolveAgent: (ctx as any).resolveAgent,
			resolveSubagentTarget: (ctx as any).resolveSubagentTarget,
			subagents: (ctx as any).subagents,
		};

		const callerCtx: CallerCtx = {
			caller: "internal",
			sessionId: ctx.sessionId,
			agentId: ctx.agentId,
			toolCallId: toolCallId || ctx.currentToolCallId,
			turnSeq: ctx.turnSeq,
			workingDir: ctx.workingDir,
			// sub-3 过渡字段(B4 收敛后并入 scope / host 显式填):
			toolConfig: (ctx as any).toolConfig,
			readScope: (ctx as any).readScope,
			wikiAnchorNodeIds: (ctx as any).wikiAnchorNodeIds,
			contextBundle: (ctx as any).contextBundle,
			projectId: (ctx as any).projectId,
			// per-session accessors + delegation fns + agent resolvers (G1).
			todos: todosAccessor,
			taskRegistry: taskRegistryAccessor,
			delegateFns,
			agentResolvers,
			// sub-4: project-flow / Orchestrate session state.
			flowActions: (ctx as any).flowActions,
			orchestratePlanStore: (ctx as any).orchestratePlanStore,
			orchestrateManifestStore: (ctx as any).orchestrateManifestStore,
			gitIntegration: (ctx as any).gitIntegration,
			activeRequirementId: (ctx as any).activeRequirementId,
			featureWorkspace: (ctx as any).featureWorkspace,
		};
		// ctx.emit is the loop's streaming channel (runtime events → UI). Bridge it
		// so the emit contract (CallerCtx.emit) reaches streaming-capable tools.
		if (typeof (ctx as any).emit === "function") {
			callerCtx.emit = (ctx as any).emit;
		}
		return callerCtx;
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
		this.userInterruptQueued = false;
		const timeout = this.setupTimeout();

		// platform-observability ②.4 (sub-3): set the ALS turn context BEFORE
		// any LLM call. Scope covers the whole try/finally (incl. runWithRetry
		// → streamText → provider middleware acquire). provider-factory reads
		// tier + identity from this and attaches to the waiter → release() then
		// dequeues by tier priority. sub-loops are independent AgentLoops, each
		// sets its own context here.
		const turnCtx = {
			sessionId: this.config.sessionId,
			agentId: this.config.agentId,
			tier: turnSourceToTier(this.config.source),
		};

		return runInConcurrencyContext(turnCtx, async () => {
			try {
				// Step 1C: UserPromptSubmit is deleted (no consumer; the input-gate
				// concern merged into TurnStart). addMessage runs unconditionally.
				this.session.addMessage({ role: "user", content: userMessage });
				this.session.saveToDb();
				await this.session.pruneIfNeeded();

				log.loop("Messages after prune:", this.session.getMessages().length, "est tokens:", this.session.getMessages().reduce((s: number, m: any) => s + Math.ceil(JSON.stringify(m).length / 4), 0));

				await this.triggerLocal("TurnStart", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), userMessage, source: this.config.source });

				// TurnStart hook has written user turn; next seq is the first assistant step
				if (this.config.db && this.config.sessionId) {
					this.stepBaseSeq = this.config.db.getTurnCount(this.config.sessionId);
				}
				this.stepOffset = 0;

				// Set the turn group (= user message's seq = stepBaseSeq - 1 for non-resume,
				// but TurnStart already wrote the user turn so getTurnCount includes it)
				const userSeq = this.stepBaseSeq - 1;
				this.recorder.startTurnGroup(userSeq);
				// multimodal-input sub-3 (#3 wiring): mark the current turn's user
				// step seq so getMessagesMultimodal inlines images for THIS step
				// only (design: 当前 step = the turn's user message; all multi-step
				// LLM calls in the turn treat it as current). User steps earlier
				// than userSeq are "history" → meta-info text only.
				this.session.setCurrentUserStepSeq(userSeq);

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
		});
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
		this.userInterruptQueued = false;
		const timeout = this.setupTimeout();

		// ②.4 (sub-3): same ALS turn context as run() — resume is also a turn
		// boundary; LLM calls inside runWithRetry must carry the tier + identity.
		const turnCtx = {
			sessionId: this.config.sessionId,
			agentId: this.config.agentId,
			tier: turnSourceToTier(this.config.source),
		};

		return runInConcurrencyContext(turnCtx, async () => {
			try {
				await this.session.pruneIfNeeded();

				// For resume, the user turn + any completed steps are already in DB.
				// getTurnCount returns the count INCLUDING those, so the next
				// appendStep lands at the correct fresh seq.
				if (this.config.db && this.config.sessionId) {
					this.stepBaseSeq = this.config.db.getTurnCount(this.config.sessionId);
				}
				this.stepOffset = 0;

				// sub-5 (durable Wait): if the crash left a pending Wait tool call
				// whose absolute `until` is still in the future, re-suspend now
				// (before TurnStart / the model runs) so the wait honors its real
				// deadline instead of the model seeing a synthetic "woke: timeout".
				// Past-due / relative-only waits are NOT re-suspended — the rebuild
				// already synthesized `woke: timeout` for them. Best-effort: any
				// error just logs and lets the resume proceed normally.
				await this.detectAndResumePendingWait();

				await this.triggerLocal("TurnStart", { agentId: this.config.agentId, sessionId: this.session.getSessionId(), userMessage: "(resumed)", source: this.config.source });

				// After TurnStart, the turn count may have increased (if hook wrote a turn)
				if (this.config.db && this.config.sessionId) {
					this.stepBaseSeq = this.config.db.getTurnCount(this.config.sessionId);
				}
				const userSeq = this.stepBaseSeq - 1;
				this.recorder.startTurnGroup(userSeq);
				// multimodal-input sub-3 (#3 wiring): same as run() — mark the
				// resumed turn's user step as current for image inlining.
				this.session.setCurrentUserStepSeq(userSeq);

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
		});
	}

	abort(): void {
		this.abortController?.abort();
	}

	/**
	 * platform-observability ②.1 (sub-1): set the turn-source marker for the
	 * NEXT run()/resume() on this loop. Called by the entry that drives the
	 * turn (agent-service sendPrompt/sendProjectPrompt), since one loop can be
	 * driven by different entries across its lifetime (e.g. a chat session
	 * started by chat-router[user] then poked by analyst-service[background]).
	 * The marker is read by durable-hooks TurnStart → createTurnState and
	 * persisted on turn_state.source. Delegated sub-loops never call this, so
	 * they stay at the default 'background'.
	 */
	setTurnSource(source: import("./types.js").TurnSource): void {
		this.config.source = source;
	}

	getState(): RuntimeState {
		return {
			isBusy: this.busy,
			streamingText: this.streamText,
			toolCalls: this.recorder.getToolCalls() as { name: string; status: "running" | "done" | "error" }[],
		};
	}

	// ─── sub-5: Wait suspension coordination ─────────────────────────────
	/**
	 * Whether this loop is currently suspended inside a Wait tool call. While
	 * true the session is NOT "running" for UI/queue purposes (shows idle,
	 * accepts user input as a wake source). Distinct from `busy` (the loop is
	 * still mid-run; the Wait tool's execute is awaiting inside the SDK).
	 */
	isWaiting(): boolean { return this.waiting; }

	/**
	 * Fire the user-input wake source. Called by the server when a user message
	 * arrives while the loop is waiting. Returns true if a Wait was active and
	 * got interrupted; false if the loop wasn't waiting (caller treats the
	 * message as a normal prompt). The interrupted Wait resolves with reason
	 * "user input"; endWaitSuspend then sets userInterruptQueued so executeStream
	 * ends the current turn at the next step boundary → the queued message runs
	 * as turn+1 (agent-service drains the input queue after run() returns).
	 */
	interruptWaitForUserInput(): boolean {
		if (!this.waiting) return false;
		this.delegator.interruptWaitForUserInput();
		return true;
	}

	/**
	 * sub-5: called by the Wait tool (via ctx.beginWait) right before it
	 * suspends. Flips the loop into the waiting state and emits session_waiting
	 * so the server releases the "running" flag (UI shows idle, sendPrompt can
	 * route the next user message to interruptWaitForUserInput instead of a
	 * conflicting second run()).
	 */
	private beginWaitSuspend(): void {
		if (this.waiting) return;
		this.waiting = true;
		this.emit({ type: "session_waiting", sessionId: this.config.sessionId, agentId: this.config.agentId });
	}

	/**
	 * sub-5: called by the Wait tool (via ctx.endWait) right after it resolves.
	 * Reacquires the running state (emits session_running) and, if the wake was
	 * a user-input interrupt, sets userInterruptQueued so executeStream breaks
	 * at the next step boundary (current turn ends; turn+1 follows via drain).
	 */
	private endWaitSuspend(reason: string): void {
		if (!this.waiting) return;
		this.waiting = false;
		if (reason === "user input") this.userInterruptQueued = true;
		this.emit({ type: "session_running", sessionId: this.config.sessionId, agentId: this.config.agentId });
	}

	/**
	 * sub-5 (durable Wait resume): scan the last persisted step for a pending
	 * Wait tool call whose absolute `until` is still in the future, and if so
	 * re-suspend via suspendUntilWake so the wait honors its real deadline. The
	 * rebuild path (synthesizeDanglingToolResultsInPlace) already paired the
	 * dangling Wait with a synthetic `woke: timeout` so the messages are valid;
	 * this re-suspend is what actually makes the resumed turn WAIT again rather
	 * than continuing as if the wait had elapsed.
	 *
	 * Wake sources during the re-suspend are the same three (time / any-task /
	 * user-input). If a background task reached a terminal state during the
	 * outage, it already fired tryWake() into a dead resolver (no Wait was
	 * active) — so on re-suspend we may wake immediately as "timeout" if no
	 * task is currently running. That matches the spec: any-finish "naturally
	 * triggers" via the re-suspend; the reason label may read "timeout" when
	 * the finishing task already left the live registry (accepted, documented).
	 *
	 * Best-effort: any parse/read error logs and falls through (resume proceeds
	 * without re-suspending — the synthesized `woke: timeout` stands).
	 */
	private async detectAndResumePendingWait(): Promise<void> {
		if (!this.config.db || !this.config.sessionId) return;
		try {
			const steps = this.config.db.getSteps(this.config.sessionId);
			if (steps.length === 0) return;
			// Scan assistant steps from the latest backward for a pending Wait.
			for (let i = steps.length - 1; i >= 0; i--) {
				const s = steps[i];
				if (s.role !== "assistant") continue;
				let blocks: any[] = [];
				try { blocks = JSON.parse(s.content ?? "[]"); } catch { continue; }
				const waitBlock = blocks.find((b: any) =>
					b?.type === "tool" && b.name === "Wait" && b.status === "running" && b.result === undefined,
				);
				if (!waitBlock) continue; // this step has no pending Wait; keep scanning up
				const args = typeof waitBlock.args === "string"
					? (JSON.parse(waitBlock.args) ?? {})
					: (waitBlock.args ?? {});
				const untilIso = typeof args?.until === "string" ? args.until : undefined;
				const untilMs = untilIso ? Date.parse(untilIso) : NaN;
				const hasFutureUntil = !Number.isNaN(untilMs) && untilMs > Date.now();
				// sub-9 (durable relative-timeout): a relative-only `timeout` with a
				// persisted block-level `startedAt` (sibling to args) is now durable.
				// Compute remaining = startedAt + timeoutSec*1000 − now; if > 0,
				// re-suspend with that remaining as a fresh relative timeout. Old
				// blocks without startedAt → treated as elapsed (no re-suspend, the
				// synthesized `woke: timeout` stands; does not crash).
				let resumeOpts: { until?: string; timeoutSec?: number } | null = null;
				if (hasFutureUntil) {
					resumeOpts = { until: untilIso };
				} else {
					const startedAt = typeof waitBlock.startedAt === "number" ? waitBlock.startedAt
						: (typeof waitBlock.startedAt === "string" && /^[0-9]+$/.test(waitBlock.startedAt) ? Number(waitBlock.startedAt) : NaN);
					const timeoutSecArg = typeof args?.timeout === "number" ? args.timeout
						: (typeof args?.timeout === "string" && /^[0-9]+(?:\.[0-9]+)?$/.test(args.timeout) ? Number(args.timeout) : NaN);
					if (!Number.isNaN(startedAt) && !Number.isNaN(timeoutSecArg) && timeoutSecArg > 0) {
						const remainingMs = startedAt + timeoutSecArg * 1000 - Date.now();
						if (remainingMs > 0) {
							resumeOpts = { timeoutSec: Math.max(1, Math.round(remainingMs / 1000)) };
						}
					}
				}
				if (!resumeOpts) continue; // already past due / no durable source → synthesized result stands
				// Re-suspend until the resolved point (or any-task / user-input wakes
				// it sooner). Announce suspend/resume so the server's running flag
				// stays consistent during the re-wait. sub-9: pass the REAL wake reason
				// (from the resolver) to endWaitSuspend so a user-input wake during
				// re-suspend correctly triggers turn+1 — DO NOT hardcode "timeout".
				this.beginWaitSuspend();
				let wakeReason: import("./types.js").WakeReason = "timeout";
				try {
					const wr = await this.delegator.suspendUntilWake(resumeOpts);
					wakeReason = wr.reason;
				} finally {
					this.endWaitSuspend(wakeReason);
				}
				return; // at most one re-suspend per resume
			}
		} catch (err: any) {
			log.warn("loop", "detectAndResumePendingWait failed (non-fatal):", err?.message ?? err);
		}
	}

	getLoopState(): { isBusy: boolean; recorderBlocks: any[] } {
		return {
			isBusy: this.busy,
			recorderBlocks: this.recorder.blocks.slice(),
		};
	}

	/**
	 * sub-4 (TaskGet recent-calls source): the last N tool-call blocks from this
	 * loop's recorder, name + args summary only (NO output/result). Used by the
	 * parent's `ctx.getTaskRecentCalls(taskId)` to surface what a running
	 * sub-agent is doing without leaking tool output (that's reserved for the
	 * completed branch of TaskGet). Returns [] if there are no tool blocks yet.
	 *
	 * Same source as the UI's live block view — single source of truth.
	 */
	getRecentToolCalls(n: number = 3): Array<{ name: string; args?: string }> {
		const toolBlocks = this.recorder.blocks.filter((b: any) => b?.type === "tool" && b?.name);
		const recent = toolBlocks.slice(-n);
		return recent.map((b: any) => ({
			name: String(b.name),
			args: typeof b.args === "string" ? summarizeArgs(b.args) : b.args,
		}));
	}

	/**
	 * platform-observability ① (sub-4): the last N steps' tool-call blocks,
	 * grouped per step — {stepSeq, toolCalls:[{name, argsBrief}], status, time}.
	 * Same recorder source as getRecentToolCalls, but keeps the step grouping
	 * (recorder.completedSteps + currentStepBlocks) so each entry is one LLM
	 * step's worth of tool calls. **No tokens** (per design — usage is stripped).
	 * status = aggregate of the step's tool blocks ("running" if any running,
	 * "error" if any error, else "done"); time = the recorder's currentTurnGroup
	 * (best wall-clock proxy available without per-step timestamps). Returns []
	 * when there are no tool-bearing steps. stepSeq is 0-based within the run.
	 */
	getRecentSteps(n: number = 3): Array<{ stepSeq: number; toolCalls: Array<{ name: string; argsBrief?: string }>; status: string; time: number }> {
		const steps = this.recorder.getRecentStepBlocks(n);
		return steps.map((s) => {
			const toolCalls = s.blocks
				.filter((b: any) => b?.type === "tool" && b?.name)
				.map((b: any) => ({
					name: String(b.name),
					argsBrief: typeof b.args === "string" ? summarizeArgs(b.args) : (b.args != null ? String(b.args) : undefined),
				}));
			const statuses = s.blocks.filter((b: any) => b?.type === "tool").map((b: any) => b.status as string);
			const status = statuses.includes("running") ? "running"
				: statuses.includes("error") ? "error"
				: statuses.length > 0 ? "done"
				: "done";
			return { stepSeq: s.stepSeq, toolCalls, status, time: s.time };
		}).filter((s) => s.toolCalls.length > 0);
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

	/**
	 * Current model the loop runs on (provider + model id). Reflects the live
	 * config — updated by hot config-sync / per-call overrides — so the UI can
	 * show the model actually backing a session (incl. delegated sub-agents).
	 */
	getModelId(): { providerName: string; modelId: string } {
		return { providerName: this.config.providerName, modelId: this.config.modelId };
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
	 * Flat list of this loop's live in-memory tasks (its delegator's
	 * TaskRegistry) plus, recursively, every running sub-loop's tree. Each
	 * TaskInfo carries a parentTaskId so the caller rebuilds the tree. This is
	 * the single source the UI TaskTree and the agent TaskList read — they no
	 * longer diverge (bash tasks included; status/count identical). Only
	 * RUNNING sub-loops are recursed (finished ones leave the live view).
	 */
	getRuntimeTaskTree(): TaskInfo[] {
		const out: TaskInfo[] = [...this.delegator.taskRegistry.list()];
		for (const { loop } of this.delegator.getRunningSubloops().values()) {
			const childTree = loop.getRuntimeTaskTree?.();
			if (childTree?.length) out.push(...childTree);
		}
		return out;
	}

	/**
	 * Restore persisted delegated_tasks rows into this loop's live TaskRegistry
	 * (startup / activate history reload). The read path (getRuntimeTaskTree) is
	 * memory-only by design; this is the DB→runtime restore that keeps the
	 * memory view non-empty after restart. Restored tasks are historical (not
	 * actively running) → no abortController. Bash background tasks aren't
	 * persisted, so they're correctly absent after restart.
	 *
	 * sub-8 (interrupted-status seed, design §2.3): for each record whose backing
	 * delegated session has an incomplete turn_state row (session_kind=
	 * 'delegated' + phase ∉ {completed, failed}), seed status="interrupted" so
	 * the parent workbench shows `[taskX] Interrupted` after restart. This is the
	 * AUTHORITATIVE signal — delegated_tasks.status is usually already flipped to
	 * 'interrupted' by markRunningDelegatedTasksInterrupted at startup, but the
	 * turn_state cross-check is what the design pins the workbench display on
	 * (and guards the rare row that drifted). Completed/failed/killed rows are
	 * never re-marked (acceptance #7 — don't mislabel finished children).
	 *
	 * Single batched turn_state query (no N+1): getIncompleteTurnSessionIds
	 * returns the distinct set once; per-record lookup is O(1).
	 */
	restoreDelegatedTasks(records: DelegatedTaskRecord[]): void {
		// Batched cross-table read: which delegated child sessions still have an
		// incomplete turn? Best-effort — when the store doesn't expose the helper
		// (test stubs), fall back to per-record getIncompleteTurn; both miss are
		// acceptable (the row status from markRunningDelegatedTasksInterrupted
		// already reflects interruption in production).
		let incompleteSessionIds: Set<string> | undefined;
		try {
			incompleteSessionIds = this.config.db?.getIncompleteTurnSessionIds?.();
		} catch {
			incompleteSessionIds = undefined;
		}

		for (const rec of records) {
			// Determine whether THIS child's session is frozen (has an incomplete
			// turn). rec.sessionId is the hidden delegated session backing the
			// task; absent on legacy rows / before the sub-loop created its
			// session — in that case fall back to the persisted status.
			let childIncomplete = false;
			if (rec.sessionId) {
				if (incompleteSessionIds) {
					childIncomplete = incompleteSessionIds.has(rec.sessionId);
				} else {
					try {
						childIncomplete = !!this.config.db?.getIncompleteTurn?.(rec.sessionId);
					} catch {
						childIncomplete = false;
					}
				}
			}

			// Seed-status resolution. A non-terminal record (running / finishing /
			// interrupted) over a frozen child → "interrupted". Terminal records
			// (completed / failed / killed) keep their status even if the child's
			// turn_state row is somehow non-terminal — the task itself reached a
			// terminal state and the workbench must reflect THAT (acceptance #7).
			let seedStatus: TaskInfo["status"] = rec.status;
			if (childIncomplete && (rec.status === "running" || rec.status === "finishing" || rec.status === "interrupted")) {
				seedStatus = "interrupted";
			}

			this.delegator.taskRegistry.seed({
				id: rec.id,
				type: "subagent",
				task: rec.task,
				status: seedStatus,
				parentTaskId: rec.parentTaskId,
				step: rec.step,
				turns: rec.turns,
				tokens: rec.tokens,
				currentTool: rec.currentTool,
				result: rec.result,
				error: rec.error,
				startedAt: Date.parse(rec.createdAt) || 0,
				completedAt: rec.completedAt ? Date.parse(rec.completedAt) || undefined : undefined,
				targetAgentId: rec.targetAgentId,
			});
		}
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
		/**
		 * N4 (runtime-push-ui-sync, invariant 1): model / provider hot-sync.
		 * Written back to this.config.{providerName,modelId}; executeStream
		 * re-resolves the model every turn via resolveModel(providers,
		 * this.config.providerName, this.config.modelId) (L588), so the next
		 * turn picks them up with no cache invalidation needed. Undefined is
		 * treated as "no change" (mirrors the other fields' !== undefined guard)
		 * so the caller may pass the new agent record verbatim.
		 */
		providerName?: string;
		modelId?: string;
		/**
		 * N4 (runtime-push-ui-sync, invariant 1): thinkingLevel hot-sync. Written
		 * back to this.config.thinkingLevel; the PreLLMCall provider-options hook
		 * (provider-options-hooks.ts) re-reads ctx.config.thinkingLevel every
		 * turn, so the next turn's providerOptions reflect the new value with no
		 * cache invalidation needed. Undefined = no change.
		 */
		thinkingLevel?: string;
		/**
		 * agent-context-fields C1: per-agent context-block toggle. Written back to
		 * this.config.contextConfig; buildContextMessage re-reads it every turn to
		 * gate the Environment section. Only affects the per-turn <context> block,
		 * never the system prompt (promptAssembler base), so no invalidation.
		 * Undefined = no change.
		 */
		contextConfig?: { useDeviceContext?: boolean };
		/**
		 * Capability service handles (management / wikiStore / requirementStore /
		 * pmService) recomputed by agent-service against the NEW toolPolicy.
		 * buildToolsSet reads toolPolicy fresh every turn, so without these the
		 * policy could enable e.g. Wiki on a running loop while toolContext still
		 * lacks wikiStore → the tool would be offered but fail at call time (and
		 * capabilityHandlesFor warns). The caller passes the handles it wants
		 * surfaced; we mirror them onto the tool context so a tool newly enabled
		 * by policy actually works.
		 */
		capabilities?: { management?: unknown; wikiStore?: unknown; requirementStore?: unknown; pmService?: unknown };
		/**
		 * sub-7 (work-context → system): replacement server-built closure for the
		 * Project / Requirement / Wiki Baseline system section. Pass when the
		 * activeRequirement / workId changes on a RUNNING loop so the next turn's
		 * `work-context` section re-renders the new requirement. Mirrors the
		 * wikiAnchors hot-swap pattern. Undefined = no change.
		 */
		workContextSystemSection?: SessionConfig["workContextSystemSection"];
		/**
		 * sub-7: replacement server-built closure for the Steps Progress
		 * workbench section. Same hot-swap semantics as workContextSystemSection.
		 */
		stepsProgressSection?: SessionConfig["stepsProgressSection"];
		/**
		 * skill-system sub-9: replacement server-built closure for the skills
		 * system section (Available Skills list). Pass when
		 * the agent's skillPolicy (enabledSkills) changes on a
		 * RUNNING loop so the next turn's `skills` section re-renders. Same
		 * hot-swap + invalidate pattern as workContextSystemSection. Undefined =
		 * no change. The section is cacheBreak:false (re-reads each turn), but
		 * we invalidate anyway so the swap is visible immediately.
		 */
		getSkillSection?: SessionConfig["getSkillSection"];
	}): void {
		if (patch.systemPrompt !== undefined && patch.systemPrompt !== this.config.systemPrompt) {
			this.config.systemPrompt = patch.systemPrompt;
			this.session.updateSystemPrompt(patch.systemPrompt);
			this.promptAssembler.invalidate("base");
		}
		if (patch.toolPolicy !== undefined) {
			this.config.toolPolicy = patch.toolPolicy;
		}
		// N4 (invariant 1): model / provider / thinkingLevel write-back. Each is
		// re-read every turn (resolveModel at executeStream; thinkingLevel at the
		// PreLLMCall provider-options hook), so simply writing the new value here
		// is sufficient — no cache invalidation. Undefined preserves the existing
		// value (caller may pass the new agent record verbatim).
		if (patch.providerName !== undefined) {
			this.config.providerName = patch.providerName;
		}
		if (patch.modelId !== undefined) {
			this.config.modelId = patch.modelId;
		}
		// multimodal-input sub-3 (#3 wiring): when the model / provider changes,
		// re-resolve the image capability and push it to the session so the
		// next getMessagesMultimodal reflects the new model's capability (rides
		// the same resolution path as construction — getMultimodal).
		if (patch.providerName !== undefined || patch.modelId !== undefined) {
			const multimodal = getMultimodal(this.providers, this.config.providerName, this.config.modelId);
			this.session.setMultimodal(multimodal);
		}
		if (patch.thinkingLevel !== undefined) {
			this.config.thinkingLevel = patch.thinkingLevel;
		}
		// C1 (agent-context-fields): contextConfig write-back. buildContextMessage
		// re-reads this.config.contextConfig?.useDeviceContext every turn, so a
		// plain write is enough — no cache invalidation. Only gates the
		// per-turn context block, never the system prompt.
		if (patch.contextConfig !== undefined) {
			this.config.contextConfig = patch.contextConfig;
		}
		// Sync capability handles to the new policy so a tool enabled mid-flight
		// (e.g. Wiki turned on while the loop is running) actually works — gating
		// is single-layer toolPolicy, but the tool still needs its service handle
		// present or it fails at call time (capabilityHandlesFor warns).
		if (patch.capabilities) {
			const caps = patch.capabilities;
			// tool-decoupling sub-5(B3):capability handles 不再写进 ToolExecutionContext
			// (那些字段已删,工具直读单例);只同步到 SessionConfig,保留 capability
			// hot-reload 语义(中程开关工具时 SessionConfig 仍带 handle,各工具的单例
			// 也由 server/index.ts 启动时 setXxx 全局注册)。
			const apply = (field: "management" | "wikiStore" | "requirementStore" | "pmService"): void => {
				if (caps[field] !== undefined) {
					(this.config as any)[field] = caps[field];
				}
			};
			apply("management");
			apply("wikiStore");
			apply("requirementStore");
			apply("pmService");
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
		// sub-7 (work-context → system): hot-swap the work-context / Steps
		// Progress closures when activeRequirement / workId / work policy flips
		// on a RUNNING loop. The section closures are cacheBreak:false so they
		// re-read on the next turn anyway; we still invalidate so the swap is
		// visible immediately even if a turn is mid-flight.
		if (patch.workContextSystemSection !== undefined) {
			this.config.workContextSystemSection = patch.workContextSystemSection;
			this.promptAssembler.invalidate("work-context");
		}
		if (patch.stepsProgressSection !== undefined) {
			this.config.stepsProgressSection = patch.stepsProgressSection;
		}
		// skill-system sub-9: hot-swap the skills section closure when the
		// agent's skillPolicy (enabledSkills) flips on a
		// RUNNING loop. The closure re-reads scanSkills each turn
		// (cacheBreak:false), but invalidate anyway so a mid-flight turn picks
		// up the new closure immediately. Mirrors work-context hot-swap.
		if (patch.getSkillSection !== undefined) {
			this.config.getSkillSection = patch.getSkillSection;
			this.promptAssembler.invalidate("skills");
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
				// sub-2: same provider/model/source stamp as the usage event, so
				// the failed step's bucket gets errors +1 in provider_usage.
				provider: this.config.providerName,
				model: this.config.modelId,
				source: this.config.source ?? "background",
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
		// context-channel render (Recalled Memories only — sub-7) are resolved
		// once per turn. Per-step injection (appendMessages from StepStart /
		// PreLLMCall handlers, providerOptions from PreLLMCall) is merged
		// inside the loop. Wiki anchors now live entirely in the cached system
		// prompt (sub-7 merger), so the per-turn <context> block carries only
		// Environment + Guidelines + Recalled Memories.
		const tools = await this.buildTools();
		const systemPrompt = await this.assembleSystemPrompt();

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
			useDeviceContext: this.config.contextConfig?.useDeviceContext,
			// (sub-1) todos moved out of the turn-scoped context block into the
			// per-step workbench channel (renderWorkbench) so they refresh mid-turn.
			// (sub-7) wiki anchors moved into the cached `wiki-system-anchors`
			// system section; the context channel is Recalled Memories only.
		});
		// multimodal-input sub-3 (#3 wiring — consumer): feed the
		// multimodal-aware message list into streamText so images on the CURRENT
		// user step get inlined (when the provider is multimodal) and history /
		// PDF / arbitrary-file attachments render as meta-info text. Falls back
		// to plain messages when there are no attachments (fast path in
		// getMessagesMultimodal). prependContext still wraps the system-level
		// context block around the result.
		let messages = this.prependContext(this.session.getMessagesMultimodal(), baseCtx);
		// Collect each step's response messages so finalizeStream can persist
		// them into the session at turn end (matches the old addMessage loop).
		const pendingPersist: any[] = [];

		const MAX_STEPS = 200; // guard rail (was stepCountIs(200))
		for (let stepNumber = 1; stepNumber <= MAX_STEPS; stepNumber++) {
			// Abort at the step boundary — never start a new model call after cancel.
			if (this.abortController?.signal.aborted) break;
			// sub-5 (Wait): a user-input wake ended the last step. End the turn
			// cleanly here (the Wait tool-result was the last block); the user's
			// queued message runs as turn+1 (agent-service drains the input
			// queue after run() returns). NOT an abort — turn completes normally.
			if (this.userInterruptQueued) {
				this.userInterruptQueued = false;
				break;
			}

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

			// sub-7 (work-context 拆解到三通道): memoryContext is now reserved
			// for the persistent Recalled Memories channel (recall source = wiki
			// memory subtree; not wired in this sub → stays empty). The old T2
			// workflow-context-hook transport (Project / Wiki Baseline /
			// Requirement / Steps Progress) is gone — those ride the system +
			// workbench channels via SessionConfig closures instead. buildContextMessage
			// ALWAYS emits a `## Recalled Memories` section (even empty) per
			// acceptance-7 补遗, so the channel is structurally present for the
			// future recall wiring.
			const memoryContext = preResult.memoryContext as string | undefined;
			const providerOptions = (preResult.providerOptions as Record<string, Record<string, any>>) ?? {};
			const preExtra = (preResult.appendMessages as Array<{ role: string; content: string }>) ?? [];

			// First step: fold the prepared context block into the message list
			// (turn-scoped prefix; subsequent steps reuse the already-prepended
			// baseCtx). We re-render on step 1 (block is derived from session
			// config, stable within a turn) and also when a hook surfaces fresh
			// recalled memories mid-turn (future recall wiring).
			if (stepNumber === 1 || memoryContext !== undefined) {
				const ctx = buildContextMessage({
					workspaceDir: this.config.workspaceDir,
					guidelines: this.config.guidelines,
					useDeviceContext: this.config.contextConfig?.useDeviceContext,
					memoryContext,
				});
				if (ctx) {
					messages = this.prependContext(messages, ctx);
				}
			}

			// Apply appendMessages from StepStart + PreLLMCall to this step only.
			let stepMessages = [...messages, ...stepStartExtra, ...preExtra];

			// (sub-1) workbench: per-step, non-persistent live-state block (todos,
			// later task/wait). Appended as a user message at the end (format-safe:
			// last message is often a tool result mid-turn, can't prepend to it).
			// Not persisted into `messages` — fresh each step, never accumulates.
			// (sub-7) Steps Progress rides this channel too — a per-step server-
			// built closure (config.stepsProgressSection) re-reads the task-step
			// store each render so the workbench always shows fresh step state.
			const workbench = renderWorkbench({
				sessionId: this.config.sessionId,
				agentId: this.config.agentId,
				stepsProgress: this.config.stepsProgressSection?.() ?? "",
			});
			if (workbench) {
				stepMessages = [...stepMessages, { role: "user", content: workbench }];
			}

			log.debug("loop", "streamText called (step " + stepNumber + "), messages:", stepMessages.length,
				"model:", this.config.providerName + "/" + this.config.modelId,
				"tools:", Object.keys(tools).join(","),
				"lastMsgRole:", stepMessages.at(-1)?.role,
				"injectedMsgs:", stepStartExtra.length + preExtra.length);

			// platform-observability ②.2 (sub-2 补遗): capture this step's
			// wall-clock start BEFORE the model call so finalizeOneStep can
			// compute durationMs = (finalize moment − this start). Stamped on
			// the usage event → server-side per-provider latency accumulator.
			// Captured here (post StepStart/PreLLMCall injection, pre stream)
			// so the measurement covers the actual model call + tool round.
			const stepStartMs = Date.now();

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
			// durationMs = wall-clock of this step (model call → finalize).
			await this.finalizeOneStep(step.usage, stepNumber, Date.now() - stepStartMs);

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
				// sub-6 (force-Wait): last-chance hook before the turn ends. A
				// handler (force-wait-hooks) may return { forceContinue: true,
				// message } to inject a nudge and run ONE more step instead of
				// ending. The handler owns per-turn de-dup so a turn that keeps
				// trying to end isn't nudged into a loop; Wait timeout is the
				// backstop. Not fired while a Wait is suspended (turn is mid-run,
				// not ending) — see isWaiting guard in the hook itself.
				const endCheck = await this.triggerLocal("TurnEndCheck", {
					agentId: this.config.agentId,
					sessionId: this.session.getSessionId(),
					resultText: step.text,
					taskRegistry: this.delegator.taskRegistry,
				});
				if (endCheck.forceContinue === true && typeof endCheck.message === "string" && endCheck.message.length > 0) {
					// Inject the nudge as a user message for the next step and
					// continue the while-loop (stepNumber increments naturally).
					// Persist it into the session so it survives a mid-turn crash
					// and is visible on rebuild.
					const nudgeMsg = { role: "user", content: endCheck.message };
					messages = [...messages, nudgeMsg];
					pendingPersist.push(nudgeMsg);
					log.debug("loop", `TurnEndCheck forceContinue: running one more step (${endCheck.message.slice(0, 60)}…)`);
					continue;
				}
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
				// tool-decoupling sub-5(B2):experimental_context 同时携带旧
				// ToolExecutionContext(供 buildTool wrapper 的 hook / rate-limit /
				// usage-log 读)+ AgentLoop 直建的 callerCtx 构造器(供 tool execute
				// 拿 host 注入身份)。per-call 构建(toolCallId 每次 tool 调用不同)。
				experimental_context: {
					ctx: this.toolContext,
					buildCallerCtx: (toolCallId: string) => this.buildCallerCtx(toolCallId),
				},
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
	private async finalizeOneStep(
		usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
		stepNumber?: number,
		durationMs?: number,
	): Promise<void> {
		if (usage) {
			if (usage.inputTokens) {
				this.session.calibrateFromActualUsage(usage.inputTokens);
			}
			// platform-observability ②.2 (sub-2): stamp provider/model/source on
			// the usage event so the server-side adapter (metrics-events) can
			// accumulate into the provider_usage rollup INDEPENDENT of session
			// metrics. All three are known here: this.config.providerName/modelId
			// are the live values (mid-session provider switches update them),
			// and this.config.source is the sub-1 turn-source marker. source
			// defaults to 'background' for unspec'd callers (acceptance-1 6/7).
			//
			// (sub-2 补遗): durationMs = this step's wall-clock (model call →
			// finalize), captured in executeStream's step loop. Stamped here so
			// the server-side per-provider latency accumulator can build an
			// in-process running average (design ②.2: not in DB; restart-safe).
			// Forwarded only when the caller measured it (older call sites that
			// don't pass durationMs leave the field undefined → server skips).
			this.emit({
				type: "usage",
				agentId: this.config.agentId,
				provider: this.config.providerName,
				model: this.config.modelId,
				source: this.config.source ?? "background",
				durationMs,
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
