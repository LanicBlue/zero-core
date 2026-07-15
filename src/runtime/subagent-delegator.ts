// Sub-agent delegation orchestrator.
//
// Creates sub-agent loops for delegated tasks, supports blocking/non-blocking
// execution, graceful finish (request_finish), hard stop, and persistence of
// each delegated task + its hidden session for restart-aware inspection.
//
// # Persistence model (Q1: always persistent)
// Every delegation (blocking or background) creates:
//   1. a hidden "delegated" session (sessionKind="delegated", visibility=
//      "hidden") so the sub-agent's turn history lands in the turns table and
//      survives restart — but is excluded from chat session lists.
//   2. a delegated_tasks row tracking status/turns/tokens/result for the
//      TaskTree UI and crash recovery (markRunningDelegatedTasksInterrupted).
// The sub-loop runs with that real sessionId, so session.saveToDb() persists
// turns automatically (gated on `db && sessionId`).
//
// # agentId
// The sub-loop's agentId is the bare targetAgentId (e.g. "Developer") so the
// delegated session is attributed to the target agent. This does NOT collide:
// sub-loops are built directly here (not via agent-service), so they never
// touch the only agentId-keyed map (activeSessions). Runtime identity is
// sessionId + taskId, both unique.
import type {
	StreamEvent,
	RuntimeProviderConfig,
	SessionConfig,
	TaskInfo,
	RuntimeCallbacks,
	AgentRuntime,
	WaitSuspendOptions,
	WaitWakeResult,
} from "./types.js";
import type { SessionContextBundle, DelegatedTaskRecord } from "../shared/types.js";
import { spawn } from "node:child_process";
import { TaskRegistry } from "./task-registry.js";
import { log } from "../core/logger.js";
import { triggerHooks } from "../core/hook-registry.js";
import { OUTPUT_TRUNCATION_CHARS, EXEC_MAX_BUFFER_BYTES } from "../core/constants.js";
import { decodeShellBuffer } from "../core/encoding.js";
import { registerHooksForLoop, type HookWiringDeps } from "./hooks/index.js";
// sub-4 (TaskResume turn_seq guard): pre-populate the shared turn_seq cursor +
// turn_state-precreate marker BEFORE loop.resume(), so the child's TurnStart
// doesn't allocate turn_seq+1. Same pattern as the server-side
// doRecoverIncompleteSessions (which calls setSessionTurnSeq+setTurnSeq for
// chat-session recovery). The runtime path uses the underlying shared
// accessors directly (setTurnSeq + markTurnStatePrecreated) — the
// setSessionTurnSeq shim lives in the server layer, which runtime can't import.
import { setTurnSeq, markTurnStatePrecreated } from "./hooks/turn-seq-tracker.js";

type LoopFactory = (
	config: SessionConfig,
	providers: RuntimeProviderConfig[],
	callbacks: RuntimeCallbacks,
) => AgentRuntime;

/**
 * Extended delegateTask options (RFC §2.11 / decision 16).
 *
 * Synchronous sub-agent calls inherit the CALLER session's context bundle
 * (workspaceDir / wikiRootNodeId / projectId); the caller may override pieces
 * per-call. Identity, toolPolicy and history come from the target agent —
 * passed via targetAgentId / toolPolicy / systemPrompt so the runtime builds
 * the sub-loop against the target agent's config rather than the caller's.
 */
export interface DelegateTaskOptions {
	/** Target agent id (the agent being delegated to). */
	targetAgentId?: string;
	/** Target agent's full system prompt (overrides caller's prompt). */
	systemPrompt?: string;
	/** Target agent's model id. */
	model?: string;
	/** Target agent's toolPolicy (overrides caller's policy). */
	toolPolicy?: SessionConfig["toolPolicy"];
	/** Caller-provided context bundle override (per-call). */
	contextOverride?: Partial<SessionContextBundle>;
	/**
	 * Per-call workspace override. Falls back to caller bundle's workspaceDir,
	 * then to the caller SessionConfig.workspaceDir.
	 */
	workspaceDir?: string;
	/** Parent task in a delegation chain (sub-agent of a sub-agent). */
	parentTaskId?: string;
	/** Root of the delegation chain; defaults to parentTaskId or this task. */
	rootTaskId?: string;
	/** Title override for the delegated session (default: derived from task). */
	title?: string;
	/**
	 * Step 2E: the parent step's tool-call id that triggered this delegation.
	 * Persisted on the delegated_tasks row as parent_tool_call_id so the parent
	 * resume path can resolve a dangling Agent tool-call → its delegated task.
	 */
	parentToolCallId?: string;
	/**
	 * Step 2E: callback fired once with the freshly-minted taskId, right after
	 * the delegated_tasks row is created. Lets the caller (Agent tool) annotate
	 * its recorder tool-call block with the taskId the moment it is known, even
	 * on the blocking path where delegateTask awaits completion before
	 * returning. Best-effort — errors here are swallowed by the caller.
	 */
	onDispatched?: (taskId: string) => void;
}

/** Tracked running sub-loop, for request_finish turn-budget enforcement. */
interface RunningSubloop {
	loop: AgentRuntime;
	abort: AbortController;
	/** Set when request_finish is called with a maxTurns budget. */
	finishState?: { maxTurns: number; turnsDone: number };
}

export interface SubagentDelegatorDeps {
	config: SessionConfig;
	providers: RuntimeProviderConfig[];
	emit: (event: StreamEvent) => void;
	createSubLoop: LoopFactory;
	getToolConfig: () => Record<string, Record<string, any>>;
	/**
	 * Step 1B: per-loop hook wiring deps. When provided, every sub-loop gets the
	 * delegated hook set registered on its own registry right after build.
	 * Omit only in test stubs that don't run real hooks.
	 */
	hookDeps?: HookWiringDeps;
	/**
	 * steps-overhaul sub-8 (archive): fired when a delegated task reaches a
	 * terminal state (`completed` / `failed`) so the caller can run the archive
	 * pipeline on the CHILD session. The callback receives the taskId, the
	 * terminal status, and the child session id (resolved from the
	 * delegated_tasks row). Fire-and-forget from the delegator's POV — the
	 * callback owns its own error handling; a rejection is logged but does NOT
	 * propagate to the task caller.
	 *
	 * Set by agent-service (server layer) to call archive-service.archiveSession.
	 * Omitted in test stubs. NOTE: this fires ONLY for delegated sub-agent
	 * terminal states — it does NOT fire for cron/main (parent) completion,
	 * preserving the "cron/main 不自动归档" invariant (acceptance-8).
	 */
	onTaskTerminal?: (taskId: string, status: "completed" | "failed", childSessionId: string, childAgentId?: string, childModelId?: string) => Promise<void> | void;
}

const DEFAULT_FINISH_MESSAGE =
	"Stop expanding work. Return the best available summary of completed work, partial findings, artifacts, and remaining gaps.";

/**
 * Sub-agent tool policy: inherits the caller's policy but force-blocks AskUser.
 * A sub-agent runs in a hidden delegated session; its ask_user event carries
 * that hidden sessionId, which the renderer never displays — so an AskUser from
 * a sub-agent would hang forever waiting for a reply the user never sees.
 * Blocking it at the tool-policy level (buildToolsSet honors blockedTools) is
 * the cleanest knob; no ToolExecutionContext change needed. If parent↔child
 * communication is added later (route the sub-agent's question up via a hook),
 * remove this entry.
 */
export function delegatedToolPolicy(base: SessionConfig["toolPolicy"]): SessionConfig["toolPolicy"] {
	const blocked = new Set<string>(base?.blockedTools ?? []);
	blocked.add("AskUser");
	return { ...(base ?? {}), blockedTools: [...blocked] };
}

export class SubagentDelegator {
	readonly taskRegistry = new TaskRegistry();
	private config: SessionConfig;
	private providers: RuntimeProviderConfig[];
	private emit: (event: StreamEvent) => void;
	private createSubLoop: LoopFactory;
	private getToolConfig: () => Record<string, Record<string, any>>;
	private hookDeps: HookWiringDeps | undefined;
	private onTaskTerminal: SubagentDelegatorDeps["onTaskTerminal"];
	private runningSubloops = new Map<string, RunningSubloop>();

	constructor(deps: SubagentDelegatorDeps) {
		this.config = deps.config;
		this.providers = deps.providers;
		this.emit = deps.emit;
		this.createSubLoop = deps.createSubLoop;
		this.getToolConfig = deps.getToolConfig;
		this.hookDeps = deps.hookDeps;
		this.onTaskTerminal = deps.onTaskTerminal;
	}

	// -----------------------------------------------------------------------
	// Persistence helpers
	// -----------------------------------------------------------------------

	/** Create the hidden delegated session backing a task. Returns its id. */
	private createDelegatedSession(
		taskId: string,
		targetAgentId: string,
		task: string,
		inheritedBundle: SessionContextBundle | undefined,
		options: DelegateTaskOptions | undefined,
	): string | undefined {
		const db = this.config.db;
		if (!db?.createSession) return undefined;
		const title = options?.title ?? `Delegated: ${task.slice(0, 60)}`;
		const session = db.createSession(targetAgentId, title, inheritedBundle, {
			sessionKind: "delegated",
			parentSessionId: this.config.sessionId,
			parentTaskId: taskId,
			visibility: "hidden",
		});
		return session.id;
	}

	/** Insert the delegated_tasks row for a new task. */
	private createDelegatedTask(
		taskId: string,
		targetAgentId: string,
		task: string,
		sessionId: string | undefined,
		options: DelegateTaskOptions | undefined,
	): void {
		this.config.db?.createDelegatedTask?.({
			id: taskId,
			parentTaskId: options?.parentTaskId,
			rootTaskId: options?.rootTaskId ?? options?.parentTaskId ?? taskId,
			ownerAgentId: this.config.agentId,
			targetAgentId,
			// Effective model at delegation time: the Subagent tool's override,
			// else the caller's configured model (named delegations already
			// folded target.model into options.model upstream in the Agent tool).
			modelId: options?.model ?? this.config.modelId,
			parentSessionId: this.config.sessionId,
			sessionId,
			task,
			status: "running",
			depth: (this.config.spawnDepth ?? 0) + 1,
			parentToolCallId: options?.parentToolCallId,
		});
		// Step 2E: notify the caller of the taskId so it can annotate its
		// recorder tool-call block. Swallow errors — annotation is best-effort.
		try { options?.onDispatched?.(taskId); } catch { /* best-effort */ }
	}

	/** Patch a delegated_tasks row (status/progress/result/...). Best-effort. */
	private updateDelegatedTask(taskId: string, patch: Partial<DelegatedTaskRecord>): void {
		this.config.db?.updateDelegatedTask?.(taskId, patch as any);
	}

	/**
	 * archive-no-residual sub-1 (D1): run terminal bookkeeping + (optionally)
	 * fire the `onTaskTerminal` callback when a delegated task reaches a
	 * terminal state. Two phases, strictly ordered:
	 *
	 *   ① terminal bookkeeping (UNCONDITIONAL — only needs db):
	 *        markArchivedTransient(childSessionId)   // idempotent crash checkpoint
	 *        deleteDelegatedTask(taskId)             // row vanishes immediately,
	 *                                                // no re-seed on next loop
	 *      This runs even when onTaskTerminal is unwired, so a crashed/missed
	 *      archive leaves a mark → recoverInterruptedArchives picks it up on
	 *      next startup. Invariant: zero residual in delegated_tasks regardless
	 *      of wiring. The mark + delete are decoupled from the (slow, async)
	 *      memory/archive pipeline so the row stops re-seeding into the UI the
	 *      moment the task hits its terminal state.
	 *
	 *   ② memory preservation (WIRED — fire-and-forget):
	 *        onTaskTerminal(taskId, status, childSessionId, childAgentId, childModelId)
	 *      Only fires when the caller wired the callback. agentId/modelId are
	 *      passed in (the row is already deleted in ①, so the callee cannot
	 *      re-read it). A rejection/throw is logged + swallowed — archiving is
	 *      a detached post-terminal side-effect, never part of the task's own
	 *      contract.
	 *
	 * Only fires for `completed` / `failed` (NOT `killed` — killed is a
	 * parent-initiated stop via stopTask/abandonTask; the child session there
	 * is abandoned, not "completed work", and the parent owns its cleanup,
	 * including row deletion via abandonTask/acknowledgeTask).
	 *
	 * Wiring: ② is wired by agent-service's buildAndRegisterLoop — the shared
	 * construction point used by BOTH createLoopForSession (chat) AND
	 * sendProjectPrompt's lazy-rebuild (work/cron/automation). archive-no-residual
	 * sub-2 closed the gap: every parent loop that dispatches sub-agents now
	 * fires ②. tempLoop (memory-turn runner), subagent-delegator's own subLoop
	 * (the child itself), and cli.ts do not wire ② — by design (none dispatch
	 * sub-agents in turn). An unwired path still runs ① (no residual in
	 * delegated_tasks) and leans on recovery for ②.
	 */
	private fireOnTaskTerminal(taskId: string, status: "completed" | "failed"): void {
		const row = this.config.db?.getDelegatedTask?.(taskId);
		const childSessionId = row?.sessionId;
		if (!childSessionId) {
			// No child session (e.g. test stub without persistence, or the row
			// was already cleared). Nothing to bookkeep or archive.
			return;
		}
		const childAgentId = row?.targetAgentId;
		const childModelId = row?.modelId;
		// ① terminal bookkeeping — UNCONDITIONAL. markArchivedTransient is the
		// idempotent crash checkpoint (reuses the sessions.archived column);
		// deleteDelegatedTask removes the row so it stops re-seeding into the
		// UI / restoreDelegatedTasks on the next loop rebuild. Order matters:
		// mark BEFORE delete so a crash between them still leaves a recoverable
		// mark on the sessions row (the delegated_tasks row is gone either way).
		this.config.db?.markArchivedTransient?.(childSessionId);
		this.config.db?.deleteDelegatedTask?.(taskId);
		// ② memory preservation — only when wired. The row is already gone, so
		// the callee must take agentId/modelId from the args (it cannot
		// re-read the row). Fire-and-forget; reject/throw is logged + swallowed.
		if (!this.onTaskTerminal) return;
		try {
			const ret = this.onTaskTerminal(taskId, status, childSessionId, childAgentId, childModelId);
			if (ret && typeof (ret as Promise<void>).then === "function") {
				void (ret as Promise<void>).catch((err: unknown) => {
					// Log only — archiving is a detached post-terminal side-effect.
					log.warn("delegator", `onTaskTerminal archive failed (task=${taskId}, child=${childSessionId}):`, (err as Error)?.message ?? err);
				});
			}
		} catch (err) {
			// Synchronous throw in the callback — log + swallow.
			log.warn("delegator", `onTaskTerminal archive threw (task=${taskId}, child=${childSessionId}):`, (err as Error)?.message ?? err);
		}
	}

	/**
	 * Build an onEvent handler for a sub-loop that threads token/turn telemetry
	 * into the task registry (if the task is registered) and the delegated_tasks
	 * row, and enforces the request_finish turn budget.
	 */
	private buildSubEventHandler(taskId: string, entry: RunningSubloop) {
		let tokens = 0;
		let turns = 0;
		let step = 0;
		return (event: StreamEvent) => {
			const e = event as any;
			if (e.type === "tool_start") {
				step += 1;
				this.taskRegistry.updateProgress(taskId, step, e.toolName);
				this.updateDelegatedTask(taskId, { step, currentTool: e.toolName });
				this.emit({
					type: "subagent_progress",
					agentId: this.config.agentId,
					taskId,
					step,
					toolName: e.toolName,
				});
			} else if (e.type === "usage") {
				const total: number = e.usage?.totalTokens ?? 0;
				tokens += total;
				turns += 1;
				this.taskRegistry.addUsage(taskId, total, true);
				this.updateDelegatedTask(taskId, { tokens, turns });
				// Enforce request_finish turn budget: force-stop after maxTurns.
				const fs = entry.finishState;
				if (fs) {
					fs.turnsDone += 1;
					if (fs.turnsDone >= fs.maxTurns) {
						entry.abort.abort();
						this.updateDelegatedTask(taskId, {
							status: "killed",
							error: "request_finish turn budget exhausted; force stopped.",
						});
					}
				}
			}
		};
	}

	// -----------------------------------------------------------------------
	// delegateTask — blocking sub-agent execution (Orchestrate's task nodes).
	// sub-1: the auto-background race was removed; this is now pure blocking.
	// Background sub-agent dispatch goes via delegateTaskBackground (called
	// directly by the Subagent tool's `delegate` action).
	// -----------------------------------------------------------------------

	async delegateTask(task: string, options?: DelegateTaskOptions): Promise<string> {
		const toolConfig = this.getToolConfig();
		const targetAgentId = options?.targetAgentId ?? `${this.config.agentId}:sub`;
		const taskId = `${targetAgentId}-${Date.now()}`;
		const callerBundle = this.config.contextBundle;
		const inheritedBundle: SessionContextBundle | undefined = callerBundle
			? { ...callerBundle, ...options?.contextOverride }
			: undefined;
		const resolvedWorkspaceDir = options?.workspaceDir ?? inheritedBundle?.workspaceDir ?? this.config.workspaceDir;

		// Always persistent (Q1): create hidden session + delegated_tasks row.
		const sessionId = this.createDelegatedSession(taskId, targetAgentId, task, inheritedBundle, options);
		this.createDelegatedTask(taskId, targetAgentId, task, sessionId, options);

		const subConfig: SessionConfig = {
			...this.config,
			agentId: targetAgentId,
			// Real sessionId → turns auto-persist via saveToDb. This is the
			// sub-agent's OWN session (not the parent's), so rebuildFromTurns
			// loads its own (initially empty) history — no parent leak.
			sessionId,
			systemPrompt: options?.systemPrompt ?? this.config.systemPrompt,
			modelId: options?.model ?? this.config.modelId,
			toolPolicy: delegatedToolPolicy(options?.toolPolicy ?? this.config.toolPolicy),
			workspaceDir: resolvedWorkspaceDir,
			contextBundle: inheritedBundle,
			parentSessionId: this.config.sessionId,
			spawnDepth: (this.config.spawnDepth ?? 0) + 1,
			// The sub-loop runs UNDER this task → tasks it later dispatches are
			// children of taskId in the in-memory task tree.
			ownerTaskId: taskId,
			timeoutSec: toolConfig?.Subagent?.timeout,
			// Step 1B: mark as a delegated loop so handlers registered on its
			// own registry know their kind (task-control fires; notification /
			// input-queue / metrics don't).
			loopKind: "delegated",
			// sub-1 (platform-observability ②.1): delegated sub-loops are
			// background work — they're spawned by a parent agent mid-turn, not
			// by a user/cron/work entry. Stamped on every sub-loop turn; the
			// parent's own source is NOT inherited (the parent is the entry's
			// turn; the child is parent-driven automation). Matches acceptance-1
			// case 5.
			source: "background",
		};

		await triggerHooks("SubagentStart", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, task });

		const subAbort = new AbortController();
		// Build entry first so the telemetry handler can close over it (it
		// uses entry.finishState / entry.abort only — not entry.loop); the loop
		// is filled in right after createSubLoop returns.
		const entry: RunningSubloop = { loop: undefined as unknown as AgentRuntime, abort: subAbort };
		const telemetryOnEvent = this.buildSubEventHandler(taskId, entry);
		const subLoop = this.createSubLoop(subConfig, this.providers, { onEvent: telemetryOnEvent });
		this.registerSubLoopHooks(subLoop);
		entry.loop = subLoop;
		this.runningSubloops.set(taskId, entry);
		subAbort.signal.addEventListener("abort", () => subLoop.abort(), { once: true });

		// sub-1 (execution-entry-redesign): the auto-background branch that used
		// to race this run against a timeout was removed. The Subagent tool now
		// calls delegateTaskBackground directly for background work, and
		// delegateTask here is pure blocking — used only by Orchestrate's task
		// nodes (orchestrate-tool.ts), which never sets the Subagent.auto_background
		// config so the branch was dead anyway. If async-to-background semantics are
		// ever needed again, route via delegateTaskBackground instead of
		// re-introducing an auto-bg race here.

		// Plain blocking path.
		try {
			await subLoop.run(task);
			const result = subLoop.getResult();
			this.updateDelegatedTask(taskId, { status: "completed", result });
			await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result });
			this.fireOnTaskTerminal(taskId, "completed");
			return result;
		} catch (err: any) {
			const message = err.message || "Unknown error";
			// Race fix: if kill()/request_finish budget already marked the task
			// killed, don't overwrite with failed.
			const cur = this.taskRegistry.get(taskId)?.status;
			if (cur === "killed") {
				this.updateDelegatedTask(taskId, { status: "killed", error: message });
			} else {
				this.updateDelegatedTask(taskId, { status: "failed", error: message });
				this.fireOnTaskTerminal(taskId, "failed");
			}
			await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: cur === "killed" ? "killed" : "failed", result: message });
			throw err;
		} finally {
			this.runningSubloops.delete(taskId);
		}
	}

	// -----------------------------------------------------------------------
	// delegateTaskBackground — non-blocking sub-agent execution
	// -----------------------------------------------------------------------

	delegateTaskBackground(task: string, options?: DelegateTaskOptions): string {
		const toolConfig = this.getToolConfig();
		const targetAgentId = options?.targetAgentId ?? `${this.config.agentId}:sub`;
		const taskId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const callerBundle = this.config.contextBundle;
		const inheritedBundle: SessionContextBundle | undefined = callerBundle
			? { ...callerBundle, ...options?.contextOverride }
			: undefined;

		// Always persistent (Q1).
		const sessionId = this.createDelegatedSession(taskId, targetAgentId, task, inheritedBundle, options);
		this.createDelegatedTask(taskId, targetAgentId, task, sessionId, options);
		this.emit({ type: "subagent_dispatched", agentId: this.config.agentId, taskId, task });

		const subConfig: SessionConfig = {
			...this.config,
			agentId: targetAgentId,
			sessionId,
			systemPrompt: options?.systemPrompt ?? this.config.systemPrompt,
			modelId: options?.model ?? this.config.modelId,
			toolPolicy: delegatedToolPolicy(options?.toolPolicy ?? this.config.toolPolicy),
			workspaceDir: options?.workspaceDir ?? inheritedBundle?.workspaceDir ?? this.config.workspaceDir,
			contextBundle: inheritedBundle,
			timeoutSec: toolConfig?.Subagent?.timeout,
			parentSessionId: this.config.sessionId,
			spawnDepth: (this.config.spawnDepth ?? 0) + 1,
			// The sub-loop runs UNDER this task → its dispatched tasks are
			// children of taskId in the in-memory task tree.
			ownerTaskId: taskId,
			// Step 1B: delegated loop → task-control fires, main-only hooks don't.
			loopKind: "delegated",
			// sub-1: delegated sub-loops are background work (see first config
			// site above for rationale). Stamped on every sub-loop turn.
			source: "background",
		};

		const registry = this.taskRegistry;
		const subAbort = new AbortController();
		registry.create(taskId, "subagent", task, subAbort, this.config.ownerTaskId, targetAgentId);
		triggerHooks("TaskCreated", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, task }).catch(() => {});
		triggerHooks("SubagentStart", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, task }).catch(() => {});

		const parentEmit = (event: StreamEvent) => this.emit(event);

		setImmediate(async () => {
			const entry: RunningSubloop = { loop: undefined as unknown as AgentRuntime, abort: subAbort };
			const telemetryOnEvent = this.buildSubEventHandler(taskId, entry);
			const subLoop = this.createSubLoop(subConfig, this.providers, { onEvent: telemetryOnEvent });
			this.registerSubLoopHooks(subLoop);
			entry.loop = subLoop;
			this.runningSubloops.set(taskId, entry);
			subAbort.signal.addEventListener("abort", () => subLoop.abort(), { once: true });

			try {
				await subLoop.run(task);
				const result = subLoop.getResult();
				registry.complete(taskId, result);
				this.updateDelegatedTask(taskId, { status: "completed", result });
				parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "completed", result });
				await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result });
				await triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result });
				this.fireOnTaskTerminal(taskId, "completed");
			} catch (err: any) {
				const message = err.message || "Unknown error";
				const cur = registry.get(taskId)?.status;
				if (cur === "killed") {
					this.updateDelegatedTask(taskId, { status: "killed", error: message });
				} else {
					registry.fail(taskId, message);
					this.updateDelegatedTask(taskId, { status: "failed", error: message });
				}
				parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "failed", result: message });
				await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: message });
				await triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: message });
				if (cur !== "killed") this.fireOnTaskTerminal(taskId, "failed");
			} finally {
				this.runningSubloops.delete(taskId);
			}
		});

		return taskId;
	}

	// -----------------------------------------------------------------------
	// Task query / control
	// -----------------------------------------------------------------------

	getTaskResult(taskId: string): TaskInfo | null {
		return this.taskRegistry.get(taskId) ?? null;
	}

	listTasks(filter?: "running" | "completed"): TaskInfo[] {
		return this.taskRegistry.list(filter);
	}

	/**
	 * Read-only view of this delegator's currently-running sub-loops, keyed by
	 * taskId. Used by AgentLoop.getRuntimeTaskTree to recurse into nested
	 * delegators so the live in-memory task tree reflects sub-agent-of-sub-agent
	 * chains. Returns only RUNNING sub-loops (completed ones are removed from
	 * the map on completion — their tasks vanish with them, matching the
	 * "finished tasks leave the live view once acknowledged" lifecycle).
	 */
	getRunningSubloops(): ReadonlyMap<string, { loop: AgentRuntime }> {
		const out = new Map<string, { loop: AgentRuntime }>();
		for (const [id, entry] of this.runningSubloops) out.set(id, { loop: entry.loop });
		return out;
	}

	/**
	 * archive-no-residual (parent-archive fast path): abort EVERY running
	 * sub-loop this delegator owns, by triggering each sub-loop's
	 * AbortController (wired at dispatch to `subLoop.abort()`). Raw abort —
	 * no stopTask hooks, no status/row mutation. The archive flow owns row +
	 * session lifecycle from here.
	 *
	 * Why raw abort, not stopTask-per-task: stopTask fires SubagentStop /
	 * TaskCompleted hooks + marks the row killed, which is noise for a batch
	 * archive kill. The fast bookkeeping deletes the rows anyway; we only need
	 * the runtime loops to stop so they stop writing to sessions about to be
	 * exported + deleted. The aborted sub-loops' own completion handlers still
	 * run their normal `runningSubloops.delete` + row-update cleanup; any row
	 * write they attempt is an idempotent no-op (bookkeeping already deleted
	 * the row).
	 *
	 * MUST be called while the owning parent loop is still alive (pre-teardown)
	 * — the delegator is torn down with the loop. Called by
	 * agent-service.archiveBookkeepingSync in the chat-manual-archive SYNC
	 * phase, before teardownSessionForArchive evicts the parent loop.
	 */
	abortAllSubloops(): void {
		for (const [, entry] of this.runningSubloops) {
			try { entry.abort.abort(); } catch { /* already aborted */ }
		}
	}

	stopTask(taskId: string): boolean {
		const killed = this.taskRegistry.kill(taskId);
		if (killed) {
			this.updateDelegatedTask(taskId, { status: "killed", error: "Stopped via stop." });
			triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed" }).catch(() => {});
			triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed" }).catch(() => {});
		}
		return killed;
	}

	/**
	 * sub-4 (TaskKill interrupted→abandon): the parent has chosen NOT to resume
	 * a frozen delegated child. Mark the child's interrupted turn_state row
	 * terminal (failed) so it stops resurfacing as "needs resume" on next
	 * startup, mark the delegated_tasks row killed, and drop the task from the
	 * live registry (acknowledge — workbench moves on). Best-effort: if the
	 * child session id is missing or the turn_state row is already terminal,
	 * the registry drop still happens. Returns false only if the task is
	 * unknown or not in an interrupted state (the caller surfaces that).
	 */
	abandonTask(taskId: string): boolean {
		const info = this.taskRegistry.get(taskId);
		if (!info) return false;
		if (info.status !== "interrupted") return false;
		// Close the child's interrupted turn_state row + delegated_tasks row.
		const childSessionId = this.config.db?.getDelegatedTask?.(taskId)?.sessionId;
		if (childSessionId) {
			this.config.db?.abandonInterruptedTurn?.(childSessionId, `Abandoned via TaskKill (task ${taskId})`);
		}
		this.updateDelegatedTask(taskId, { status: "killed", error: "Abandoned via TaskKill." });
		// Drop from the live registry → leaves the workbench / TaskList.
		this.taskRegistry.acknowledge(taskId);
		// sub-4 (#1): also hard-delete the delegated_tasks row so the next
		// turn loop's restoreDelegatedTasks doesn't re-seed it as
		// interrupted/killed. The updateDelegatedTask(killed) above is kept
		// as a defensive fallback if the delete somehow fails.
		this.config.db?.deleteDelegatedTask?.(taskId);
		triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed" }).catch(() => {});
		triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed" }).catch(() => {});
		return true;
	}

	/**
	 * sub-4 (TaskGet recent-calls source, design §4.2): the last N tool-call
	 * records of a running task — NAME + ARGS SUMMARY ONLY, no output/result.
	 * Dispatch by task type:
	 *   - subagent: read the live sub-loop's recorder (same source as the UI's
	 *     live block view). Frozen/interrupted sub-loops aren't in
	 *     `runningSubloops`, so they return [] — recent calls only appear after
	 *     TaskResume re-attaches the loop. This matches design §4.2
	 *     ("近期调用记录待 TaskResume 后").
	 *   - bash: a single shell command has no call sequence — surface just the
	 *     status + elapsed + command (the task's `task` field), NOT stdout.
	 *
	 * Pure runtime→runtime read; no DB hop, no cross-layer.
	 */
	getTaskRecentCalls(taskId: string, n: number = 3): Array<{ name: string; args?: string }> {
		const info = this.taskRegistry.get(taskId);
		if (!info) return [];
		if (info.type === "bash") {
			// Bash has no call sequence. Surface the command (info.task) as a
			// single pseudo-call so the parent sees "what's running" without
			// leaking stdout. Status is already in TaskInfo (caller has it).
			return [{ name: "Shell", args: info.task }];
		}
		// subagent: read live sub-loop's recorder.
		const entry = this.runningSubloops.get(taskId);
		const loop = entry?.loop as unknown as { getRecentToolCalls?: (n: number) => Array<{ name: string; args?: string }> } | undefined;
		if (!loop?.getRecentToolCalls) return [];
		return loop.getRecentToolCalls(n);
	}

	/**
	 * Parent-agent "confirm completion": drop a FINISHED task from the live
	 * registry so it leaves the UI TaskTree and the agent's TaskList. Refuses
	 * running tasks (stop them first). Returns false if not terminal / absent.
	 */
	acknowledgeTask(taskId: string): boolean {
		const ok = this.taskRegistry.acknowledge(taskId);
		// sub-4 (#1): also hard-delete the delegated_tasks DB row so a later
		// restoreDelegatedTasks (new turn loop) doesn't re-seed it — the root
		// cause of "Task get → disappears → next turn it's back". Best-effort:
		// ?. short-circuits when no db is wired (test stubs).
		if (ok) {
			this.config.db?.deleteDelegatedTask?.(taskId);
		}
		return ok;
	}

	/**
	 * Advisory finish request (Q3). Marks the task "finishing" and injects a
	 * control message into the sub-agent's next agent-loop boundary (does NOT
	 * abort the current step). If `maxTurns` is given, force-stops after that
	 * many additional turns; without it the request is purely advisory and
	 * never force-stops (use stopTask for unconditional hard stop).
	 */
	requestTaskFinish(taskId: string, options?: { message?: string; maxTurns?: number }): boolean {
		const entry = this.runningSubloops.get(taskId);
		const message = options?.message ?? DEFAULT_FINISH_MESSAGE;
		const marked = this.taskRegistry.requestFinish(taskId, message);
		// Persist the control message on the delegated_tasks row — a PreLLMCall
		// hook (task-control hook, Phase C2) reads it by sessionId and injects
		// it into the sub-agent's context at the next turn boundary. The turn
		// budget (maxTurns) is enforced here via buildSubEventHandler counting
		// usage events; reaching the budget force-aborts.
		this.updateDelegatedTask(taskId, {
			status: "finishing",
			controlMessage: message,
			finishRequestedAt: new Date().toISOString(),
		});
		if (!entry) return marked;
		if (options?.maxTurns !== undefined && options.maxTurns > 0) {
			entry.finishState = { maxTurns: options.maxTurns, turnsDone: 0 };
		}
		return true;
	}

	/**
	 * Step 2E: resume a delegated task by taskId. Called from the parent
	 * session's resume path when it encounters a dangling Agent tool-call whose
	 * delegated task is still recoverable. The delegated sub-session resumes
	 * from its own lastCompletedStepSeq (case1/case2 recursive), and the
	 * resolved result is returned so the parent can back-fill its dangling
	 * tool-call block — WITHOUT re-invoking the delegation (no new task, no
	 * reset of the sub-agent's step history).
	 *
	 * Returns the delegated task's terminal result text, or throws if the task
	 * is missing / already terminal / the sub-loop can't be rebuilt. The caller
	 * is responsible for back-filling the tool-call block from the returned
	 * value.
	 *
	 * NOTE (design — parent-driven recovery, NOT a TODO): the taskId is
	 * allocated + persisted (delegated_tasks row with parentToolCallId) and
	 * stamped on the parent's tool-call block BEFORE the sub-agent loop is
	 * created (see delegateTaskBackground / delegateTask). So the parent
	 * always holds a durable handle to any sub-agent it dispatched.
	 *
	 * On parent crash recovery, `markRunningDelegatedTasksInterrupted` marks
	 * in-flight sub-agents `interrupted`. The PARENT then decides on its next
	 * turn: TaskGet / tree shows the interrupted task → the parent calls
	 * `resumeTask(taskId)` deliberately to continue it (this primitive), or
	 * accepts the interrupted result. There is NO automatic scan-backfill of
	 * dangling Agent tool-calls on parent restart — by design. resumeTask is
	 * the primitive for the parent's deliberate use, not something the resume
	 * loader invokes automatically.
	 */
	async resumeTask(taskId: string): Promise<string> {
		const db = this.config.db;
		if (!db?.getDelegatedTask) throw new Error(`resumeTask: db unavailable`);
		const rec = db.getDelegatedTask(taskId);
		if (!rec) throw new Error(`resumeTask: task ${taskId} not found`);
		if (rec.status === "completed") return rec.result ?? "(no output)";
		if (rec.status === "failed" || rec.status === "killed") {
			throw new Error(rec.error ?? `task ${taskId} is ${rec.status}`);
		}
		// Delegate to the sub-loop's resume via the same loop factory used for
		// fresh delegations. The sub-session rebuilds its messages from its own
		// step rows and continues from its lastCompletedStepSeq.
		const toolConfig = this.getToolConfig();
		const subConfig: SessionConfig = {
			...this.config,
			agentId: rec.targetAgentId,
			sessionId: rec.sessionId,
			systemPrompt: this.config.systemPrompt,
			modelId: this.config.modelId,
			workspaceDir: this.config.workspaceDir,
			contextBundle: this.config.contextBundle,
			parentSessionId: this.config.sessionId,
			spawnDepth: (this.config.spawnDepth ?? 0) + 1,
			// The resumed sub-loop runs UNDER this task → its dispatched tasks
			// are children of taskId in the in-memory task tree.
			ownerTaskId: taskId,
			// Same AskUser block as fresh delegations (sub-agent hidden session).
			toolPolicy: delegatedToolPolicy(this.config.toolPolicy),
			timeoutSec: toolConfig?.Subagent?.timeout,
			loopKind: "delegated",
			// sub-1: delegated sub-loops are background work (see first config
			// site above for rationale). Stamped on every sub-loop turn.
			source: "background",
		};
		const subAbort = new AbortController();
		const entry: RunningSubloop = { loop: undefined as unknown as AgentRuntime, abort: subAbort };
		const telemetryOnEvent = this.buildSubEventHandler(taskId, entry);
		const subLoop = this.createSubLoop(subConfig, this.providers, { onEvent: telemetryOnEvent });
		this.registerSubLoopHooks(subLoop);
		entry.loop = subLoop;
		this.runningSubloops.set(taskId, entry);
		subAbort.signal.addEventListener("abort", () => subLoop.abort(), { once: true });
		try {
			// ⚠️ sub-4 turn_seq guard (acceptance case 9): pre-populate the
			// child's turn_seq cursor + turn_state-precreate marker BEFORE
			// loop.resume(). The child's interrupted turn_state row already
			// exists in the DB; without this, the child's TurnStart would
			// create a NEW turn_state at turn_seq+1 (the "turn+1 bug"). We look
			// up the interrupted turn from the runtime store interface (no
			// server import), then set both the cursor (turn-hooks TurnStart
			// skips the user-row write — correct, the row exists) and the
			// precreate marker (durable-hooks TurnStart skips createTurnState —
			// preserves the existing row + checkpoint). Mirrors
			// doRecoverIncompleteSessions for the chat-session resume path.
			const childSessionId = rec.sessionId;
			if (childSessionId) {
				const incomplete = db.getIncompleteTurn?.(childSessionId);
				if (incomplete) {
					setTurnSeq(childSessionId, incomplete.turnSeq);
					markTurnStatePrecreated(childSessionId);
				}
			}
			// The sub-session's lastCompletedStepSeq lives in its own turn_state
			// row; AgentLoop.resume reads it. We pass undefined and let the loop
			// self-resolve.
			await (subLoop as any).resume?.();
			const result = subLoop.getResult();
			this.updateDelegatedTask(taskId, { status: "completed", result });
			await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result });
			this.fireOnTaskTerminal(taskId, "completed");
			return result;
		} catch (err: any) {
			const message = err.message || "Unknown error";
			this.updateDelegatedTask(taskId, { status: "failed", error: message });
			await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: message });
			this.fireOnTaskTerminal(taskId, "failed");
			throw err;
		} finally {
			this.runningSubloops.delete(taskId);
		}
	}

	/**
	 * sub-4 (TaskResume, non-blocking): the SAME setup + turn_seq guard as
	 * resumeTask, but the sub-loop's resume runs DETACHED (setImmediate). The
	 * parent gets control back immediately ("child resumed, task_id:X") and
	 * watches progress via workbench / TaskGet. This is the design §2.3 entry
	 * point — "non-blocking, parent decides to continue a frozen child".
	 *
	 * The turn_seq guard runs SYNCHRONOUSLY before we return, so even though
	 * loop.resume() is deferred, the child's TurnStart (when it fires) will see
	 * the pre-populated cursor + precreate marker and NOT allocate turn_seq+1.
	 *
	 * Throws synchronously for the same preconditions as resumeTask (db missing,
	 * task not found, already terminal). Returns the taskId on success.
	 */
	resumeTaskBackground(taskId: string): string {
		const db = this.config.db;
		if (!db?.getDelegatedTask) throw new Error(`resumeTaskBackground: db unavailable`);
		const rec = db.getDelegatedTask(taskId);
		if (!rec) throw new Error(`resumeTaskBackground: task ${taskId} not found`);
		if (rec.status === "completed") return taskId; // nothing to do
		if (rec.status === "failed" || rec.status === "killed") {
			throw new Error(rec.error ?? `task ${taskId} is ${rec.status}`);
		}
		// Idempotent: already resumed / still running — return as-is.
		if (this.runningSubloops.has(taskId)) return taskId;

		// ⚠️ sub-4 turn_seq guard (acceptance case 9) — runs SYNCHRONOUSLY,
		// before the detached resume, so the child's TurnStart (deferred) sees
		// the pre-populated cursor + precreate marker. Same lookup as resumeTask.
		const childSessionId = rec.sessionId;
		if (childSessionId) {
			const incomplete = db.getIncompleteTurn?.(childSessionId);
			if (incomplete) {
				setTurnSeq(childSessionId, incomplete.turnSeq);
				markTurnStatePrecreated(childSessionId);
			}
		}

		const toolConfig = this.getToolConfig();
		const subConfig: SessionConfig = {
			...this.config,
			agentId: rec.targetAgentId,
			sessionId: rec.sessionId,
			systemPrompt: this.config.systemPrompt,
			modelId: this.config.modelId,
			workspaceDir: this.config.workspaceDir,
			contextBundle: this.config.contextBundle,
			parentSessionId: this.config.sessionId,
			spawnDepth: (this.config.spawnDepth ?? 0) + 1,
			ownerTaskId: taskId,
			toolPolicy: delegatedToolPolicy(this.config.toolPolicy),
			timeoutSec: toolConfig?.Subagent?.timeout,
			loopKind: "delegated",
			// sub-1: delegated sub-loops are background work (see first config
			// site above for rationale). Stamped on every sub-loop turn.
			source: "background",
		};
		const subAbort = new AbortController();
		const entry: RunningSubloop = { loop: undefined as unknown as AgentRuntime, abort: subAbort };
		// Build the loop synchronously so the parent has a live handle to kill /
		// TaskGet-recent-calls against immediately (before the deferred resume
		// fires). The registry task moves to running so workbench reflects it.
		const telemetryOnEvent = this.buildSubEventHandler(taskId, entry);
		const subLoop = this.createSubLoop(subConfig, this.providers, { onEvent: telemetryOnEvent });
		this.registerSubLoopHooks(subLoop);
		entry.loop = subLoop;
		this.runningSubloops.set(taskId, entry);
		subAbort.signal.addEventListener("abort", () => subLoop.abort(), { once: true });
		this.taskRegistry.seed({
			id: taskId,
			type: "subagent",
			task: rec.task,
			status: "running",
			parentTaskId: rec.parentTaskId,
			step: rec.step,
			turns: rec.turns,
			tokens: rec.tokens,
			startedAt: Date.parse(rec.createdAt) || Date.now(),
			targetAgentId: rec.targetAgentId,
		});
		this.updateDelegatedTask(taskId, { status: "running" });
		triggerHooks("SubagentStart", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, task: rec.task }).catch(() => {});

		const parentEmit = (event: StreamEvent) => this.emit(event);
		setImmediate(async () => {
			try {
				await (subLoop as any).resume?.();
				const result = subLoop.getResult();
				this.taskRegistry.complete(taskId, result);
				this.updateDelegatedTask(taskId, { status: "completed", result });
				parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "completed", result });
				await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result });
				await triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result });
				this.fireOnTaskTerminal(taskId, "completed");
			} catch (err: any) {
				const message = err.message || "Unknown error";
				const cur = this.taskRegistry.get(taskId)?.status;
				if (cur === "killed") {
					this.updateDelegatedTask(taskId, { status: "killed", error: message });
				} else {
					this.taskRegistry.fail(taskId, message);
					this.updateDelegatedTask(taskId, { status: "failed", error: message });
				}
				parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "failed", result: message });
				await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: message });
				await triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: message });
				if (cur !== "killed") this.fireOnTaskTerminal(taskId, "failed");
			} finally {
				this.runningSubloops.delete(taskId);
			}
		});

		return taskId;
	}

	/** List delegated-task records (persisted) for this owner, optionally scoped. */
	listDelegatedTasks(filter?: { rootTaskId?: string; parentTaskId?: string }): DelegatedTaskRecord[] {
		return this.config.db?.listDelegatedTasks?.({
			ownerAgentId: filter?.rootTaskId ? undefined : this.config.agentId,
			rootTaskId: filter?.rootTaskId,
			parentTaskId: filter?.parentTaskId,
		}) ?? [];
	}

	suspendUntilWake(opts: WaitSuspendOptions): Promise<WaitWakeResult> {
		return this.taskRegistry.suspendUntilWake(opts);
	}

	/** sub-5: expose the user-input wake source for the loop. */
	interruptWaitForUserInput(): void {
		this.taskRegistry.interruptWaitForUserInput();
	}

	// -----------------------------------------------------------------------
	// runBackground — spawn a background shell process (NOT a delegated agent;
	// tracked in TaskRegistry only, no delegated_tasks row)
	// -----------------------------------------------------------------------

	runBackground(command: string, timeoutSec?: number): string {
		const taskId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const isWin = process.platform === "win32";
		const shell = isWin ? "cmd.exe" : "/bin/bash";
		// Accumulate raw Buffer chunks; decode once on close to avoid splitting
		// multi-byte chars and to fall back to GBK on invalid UTF-8 (Windows).
		const shellArgs = isWin ? ["/c", command] : ["-c", command];
		const registry = this.taskRegistry;
		const parentEmit = (event: StreamEvent) => this.emit(event);

		registry.create(taskId, "bash", command, undefined, this.config.ownerTaskId);
		triggerHooks("TaskCreated", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, task: command }).catch(() => {});

		let child: any;
		try {
			child = spawn(shell, shellArgs, { cwd: this.config.workspaceDir });
		} catch (err: any) {
			const msg = `Launch failed: ${(err as Error).message}`;
			registry.fail(taskId, msg);
			parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "failed", result: msg });
			triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: msg }).catch(() => {});
			return taskId;
		}
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout.on("data", (d: Buffer) => { stdoutChunks.push(d); });
		child.stderr.on("data", (d: Buffer) => { stderrChunks.push(d); });

		child.on("close", (code: number) => {
			const stdout = decodeShellBuffer(Buffer.concat(stdoutChunks));
			const stderr = decodeShellBuffer(Buffer.concat(stderrChunks));
			let result = "";
			if (stdout) result += stdout;
			if (stderr) result += (result ? "\n" : "") + "[stderr] " + stderr;
			if (result.length > OUTPUT_TRUNCATION_CHARS) result = result.slice(0, OUTPUT_TRUNCATION_CHARS) + "\n... (output truncated)";
			if (code === 0) {
				registry.complete(taskId, result || "(no output)");
			} else {
				registry.fail(taskId, `Exit code ${code}: ${result}`);
			}
			parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: code === 0 ? "completed" : "failed", result });
			triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: code === 0 ? "completed" : "failed", result }).catch(() => {});
		});

		child.on("error", (err: Error) => {
			registry.fail(taskId, err.message);
			parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "failed", result: err.message });
			triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: err.message }).catch(() => {});
		});

		return taskId;
	}

	// -----------------------------------------------------------------------
	// adoptBackgroundTask — sub-3 (Shell timeout auto-background):
	// adopt an ALREADY-SPAWNED child process into the task registry as a "bash"
	// background task. Used by the Shell tool's blocking-mode timeout path:
	// bash.ts spawns with `spawn` + manual timeout detection; on timeout the
	// child is NOT killed — instead it's handed off here along with the
	// stdout/stderr chunks collected so far. The delegator wires the child's
	// close event to the registry's complete/fail, and an AbortController to
	// child.kill() so TaskKill actually terminates the process. Returns taskId.
	//
	// Unlike runBackground (which spawns a NEW process), this method takes
	// ownership of a process the CALLER already started. The caller's existing
	// `data` listeners on child.stdout/stderr MUST remain attached — they keep
	// appending to the stdoutChunks/stderrChunks arrays passed in here, and
	// this method's close handler reads those same arrays (by reference) at
	// completion. No new `data` listeners are attached here.
	//
	// Lifecycle:
	//   - On handoff: registry.create(taskId, "bash", command, ac, ownerTaskId).
	//     ac is wired to child.kill() so TaskKill → registry.kill → ac.abort
	//     → SIGTERM. Unlike runBackground (which passes abortController=
	//     undefined, so kill is bookkeeping-only), adopt's kill actually
	//     terminates the process.
	//   - On child close: if status is already "killed" (TaskKill fired
	//     first), skip complete/fail (status is already terminal — registry
	//     otherwise has no terminal-state guard and would override). Otherwise
	//     decode buffers + complete(code===0)/fail(code!==0).
	//   - On child 'error' event: same skip-if-killed, then fail.
	//
	// No delegated_tasks row (matches runBackground — these are pure in-memory
	// background shell tasks, no persistence). Survives in registry until
	// cleanup (maxAgeMs 1h default) or acknowledge.
	//
	// NOT a regression risk to runBackground: separate code path, separate
	// taskId namespace (same `bg-` prefix shared by both — identical shape in
	// the registry). The two methods never interact (runBackground spawns
	// fresh; adopt receives an already-running child).
	// -----------------------------------------------------------------------

	adoptBackgroundTask(
		child: import("node:child_process").ChildProcess,
		command: string,
		stdoutChunks: Buffer[],
		stderrChunks: Buffer[],
	): string {
		const taskId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const registry = this.taskRegistry;
		const parentEmit = (event: StreamEvent) => this.emit(event);

		// AbortController wires TaskKill → child.kill(). On abort, SIGTERM the
		// child; the subsequent 'close' event will see status="killed" and
		// skip complete/fail (skip-if-killed guard below).
		const ac = new AbortController();
		ac.signal.addEventListener("abort", () => {
			try { child.kill(); } catch { /* already exited */ }
		}, { once: true });

		registry.create(taskId, "bash", command, ac, this.config.ownerTaskId);
		triggerHooks("TaskCreated", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, task: command }).catch(() => {});

		// m1: shared settled flag for close+error. Node may emit BOTH on
		// fatal errors (error first, then close) — without this guard,
		// finalize would run twice → duplicate registry.fail + emit + hook.
		// First event wins; second is a no-op.
		let settled = false;

		// finalize: unified close + error handler. Always decodes chunks
		// (covers all paths — m2 killed + m4 error + normal close + M1
		// maxbuffer detection via chunks total size).
		const finalize = (reason: "close" | "error", code: number | null, err?: Error) => {
			if (settled) return;
			settled = true;

			// Decode chunks (always — covers m4 error path + m2 killed path
			// + normal close). Same UTF-8/GBK fallback as runBackground.
			const stdout = decodeShellBuffer(Buffer.concat(stdoutChunks));
			const stderr = decodeShellBuffer(Buffer.concat(stderrChunks));
			let partial = "";
			if (stdout) partial += stdout;
			if (stderr) partial += (partial ? "\n" : "") + "[stderr] " + stderr;

			// M1: detect maxbuffer via chunks size. bash.ts's data listener
			// detaches itself + kills child when totalBytes > MAX. We don't
			// have a shared-state channel — totalBytes is the proxy. If
			// chunks > MAX, maxbuffer was the root cause (chunks can't grow
			// past MAX without the listener firing). Prefix the message +
			// always fail (a child that hit maxbuffer never "succeeds").
			const totalBytes = stdoutChunks.reduce((s, c) => s + c.length, 0)
				+ stderrChunks.reduce((s, c) => s + c.length, 0);
			const maxBufferHit = totalBytes > EXEC_MAX_BUFFER_BYTES;

			// Truncate for storage (same OUTPUT_TRUNCATION_CHARS guard as
			// runBackground — 50K, prevents registry memory blowup on tasks
			// that legitimately produced just-under-MAX output).
			const trunc = (s: string) => s.length > OUTPUT_TRUNCATION_CHARS
				? s.slice(0, OUTPUT_TRUNCATION_CHARS) + "\n... (output truncated)"
				: s;

			// m2: skip-if-killed guard. If TaskKill fired before finalize,
			// status is already "killed" — don't override (registry.complete/
			// fail have no terminal-state check; they'd clobber). DECODE THE
			// CHUNKS ANYWAY and write to info.result so TaskGet shows the
			// partial output (commands often succeed then get killed by the
			// agent — losing the output discards useful work). registry.get
			// returns the actual info object reference; mutation propagates.
			//
			// Event/hook status: subagent_completed's status union is
			// "completed" | "failed" (no "killed"). Follow the stopTask
			// convention — map killed → "failed" for the event stream.
			const cur = registry.get(taskId)?.status;
			if (cur === "killed") {
				const preserved = `(killed) ${trunc(partial)}`;
				const info = registry.get(taskId);
				if (info) info.result = preserved;
				parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "failed", result: preserved });
				triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: preserved }).catch(() => {});
				return;
			}

			// M1 maxbuffer path: prefix message + always fail.
			if (maxBufferHit) {
				const result = trunc(`Output exceeded ${EXEC_MAX_BUFFER_BYTES} bytes (process killed). ${partial}`);
				registry.fail(taskId, result);
				parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "failed", result });
				triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result }).catch(() => {});
				return;
			}

			// m4: error path — prepend err.message so the partial output
			// collected before the error is preserved alongside the cause.
			if (reason === "error" && err) {
				const result = trunc(`${err.message}\n${partial}`);
				registry.fail(taskId, result);
				parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "failed", result });
				triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result }).catch(() => {});
				return;
			}

			// Normal close path.
			const numericCode = typeof code === "number" ? code : -1;
			if (numericCode === 0) {
				const result = trunc(partial) || "(no output)";
				registry.complete(taskId, result);
				parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "completed", result });
				triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result }).catch(() => {});
			} else {
				const result = trunc(`Exit code ${numericCode}: ${partial}`);
				registry.fail(taskId, result);
				parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "failed", result });
				triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result }).catch(() => {});
			}
		};

		child.on("close", (code) => finalize("close", code));
		child.on("error", (err: Error) => finalize("error", -1, err));

		return taskId;
	}

	/**
	 * Step 1B: register the delegated hook set on a freshly-built sub-loop's
	 * own registry. No-op when hookDeps weren't provided (test stubs) or when
	 * the loop doesn't expose `.registry` (non-AgentLoop runtime). The loop
	 * config already carries loopKind="delegated" so handlers can self-inspect.
	 */
	private registerSubLoopHooks(subLoop: AgentRuntime): void {
		if (!this.hookDeps) return;
		const registry = (subLoop as unknown as { registry?: import("../core/hook-registry.js").HookRegistry }).registry;
		if (!registry) return;
		registerHooksForLoop(registry, "delegated", this.hookDeps);
	}

	cleanup(): void {
		const removed = this.taskRegistry.cleanup();
		// tool-quality-pass follow-up (#1): also hard-delete the DB rows for
		// tasks whose in-memory entry aged out (terminal > maxAgeMs). Without
		// this the row lingers and restoreDelegatedTasks re-seeds it on the next
		// loop rebuild. Idempotent — acknowledgeTask already deleted the row for
		// consumed tasks, so this only catches the never-acknowledged terminal
		// tasks (the accumulation case). Best-effort: ?. no-ops in test stubs.
		//
		// archive-no-residual sub-4 (D4): SAFETY NET + memory hygiene. The
		// PRIMARY delete now happens in `fireOnTaskTerminal` (sub-1 D1) — the
		// row vanishes the instant a task hits completed/failed, not on the
		// slow TTL ager below. So `deleteDelegatedTask` here is almost always
		// an idempotent no-op (row already gone). Kept for:
		//   ① the in-memory `TaskInfo` aging on `taskRegistry.cleanup()` (the
		//     real point of this call — prevents the registry Map from growing
		//     unbounded for long-lived parent loops);
		//   ② the rare edge case where terminal didn't fire but the in-memory
		//     entry aged out (a missed terminal hook) — the DB catch-up below
		//     keeps the row from lingering in that path too.
		// No logic change — the call was already idempotent (deleteDelegatedTask
		// is a no-op on missing ids); sub-1 just makes the no-op the common case.
		for (const id of removed) this.config.db?.deleteDelegatedTask?.(id);
	}
}
