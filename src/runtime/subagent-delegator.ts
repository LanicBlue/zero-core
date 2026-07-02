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
} from "./types.js";
import type { SessionContextBundle, DelegatedTaskRecord } from "../shared/types.js";
import { spawn } from "node:child_process";
import { TaskRegistry } from "./task-registry.js";
import { log } from "../core/logger.js";
import { triggerHooks } from "../core/hook-registry.js";
import { OUTPUT_TRUNCATION_CHARS } from "../core/constants.js";
import { decodeShellBuffer } from "../core/encoding.js";
import { registerHooksForLoop, type HookWiringDeps } from "./hooks/index.js";

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
	private runningSubloops = new Map<string, RunningSubloop>();

	constructor(deps: SubagentDelegatorDeps) {
		this.config = deps.config;
		this.providers = deps.providers;
		this.emit = deps.emit;
		this.createSubLoop = deps.createSubLoop;
		this.getToolConfig = deps.getToolConfig;
		this.hookDeps = deps.hookDeps;
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
	// delegateTask — blocking sub-agent execution (with auto-background)
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
			timeoutSec: toolConfig?.Agent?.timeout,
			// Step 1B: mark as a delegated loop so handlers registered on its
			// own registry know their kind (task-control fires; notification /
			// input-queue / metrics don't).
			loopKind: "delegated",
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

		const autoBgEnabled = toolConfig?.Agent?.auto_background === true;
		const autoBgSec = Number(toolConfig?.Agent?.auto_background_timeout) || 0;

		// Auto-background path: race the run against a timeout.
		if (autoBgEnabled && autoBgSec > 0) {
			const registry = this.taskRegistry;
			const parentEmit = (event: StreamEvent) => this.emit(event);

			let bgResult = "";
			let bgError = "";
			const done = new Promise<void>((resolve) => {
				subLoop.run(task).then(() => {
					bgResult = subLoop.getResult();
					resolve();
				}).catch((err: any) => {
					bgError = err.message || "Unknown error";
					resolve();
				});
			});

			const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), autoBgSec * 1000));
			const raceResult = await Promise.race([done.then(() => "done"), timeout]);

			if (raceResult === "done") {
				this.runningSubloops.delete(taskId);
				if (bgError) {
					this.updateDelegatedTask(taskId, { status: "failed", error: bgError });
					await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: bgError });
					throw new Error(bgError);
				}
				this.updateDelegatedTask(taskId, { status: "completed", result: bgResult });
				await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result: bgResult });
				return bgResult || "(sub-agent returned no output)";
			}

			// Timed out still running → register as a background task.
			registry.create(taskId, "subagent", task, subAbort, this.config.ownerTaskId);
			await triggerHooks("TaskCreated", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, task });
			done.then(async () => {
				this.runningSubloops.delete(taskId);
				if (bgError) {
					registry.fail(taskId, bgError);
					this.updateDelegatedTask(taskId, { status: "failed", error: bgError });
					parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "failed", result: bgError });
					await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: bgError });
					await triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: bgError });
				} else {
					registry.complete(taskId, bgResult);
					this.updateDelegatedTask(taskId, { status: "completed", result: bgResult });
					parentEmit({ type: "subagent_completed", agentId: this.config.agentId, taskId, status: "completed", result: bgResult });
					await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result: bgResult });
					await triggerHooks("TaskCompleted", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result: bgResult });
				}
			});

			return `Sub-agent auto-backgrounded after ${autoBgSec}s (still running).\ntask_id: ${taskId}\nUse TaskStatus to check progress.`;
		}

		// Plain blocking path.
		try {
			await subLoop.run(task);
			const result = subLoop.getResult();
			this.updateDelegatedTask(taskId, { status: "completed", result });
			await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result });
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
			timeoutSec: toolConfig?.Agent?.timeout,
			parentSessionId: this.config.sessionId,
			spawnDepth: (this.config.spawnDepth ?? 0) + 1,
			// The sub-loop runs UNDER this task → its dispatched tasks are
			// children of taskId in the in-memory task tree.
			ownerTaskId: taskId,
			// Step 1B: delegated loop → task-control fires, main-only hooks don't.
			loopKind: "delegated",
		};

		const registry = this.taskRegistry;
		const subAbort = new AbortController();
		registry.create(taskId, "subagent", task, subAbort, this.config.ownerTaskId);
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
	 * Parent-agent "confirm completion": drop a FINISHED task from the live
	 * registry so it leaves the UI TaskTree and the agent's TaskList. Refuses
	 * running tasks (stop them first). Returns false if not terminal / absent.
	 */
	acknowledgeTask(taskId: string): boolean {
		return this.taskRegistry.acknowledge(taskId);
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
	 * turn: TaskStatus / tree shows the interrupted task → the parent calls
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
			timeoutSec: toolConfig?.Agent?.timeout,
			loopKind: "delegated",
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
			// The sub-session's lastCompletedStepSeq lives in its own turn_state
			// row; AgentLoop.resume reads it. We pass undefined and let the loop
			// self-resolve.
			await (subLoop as any).resume?.();
			const result = subLoop.getResult();
			this.updateDelegatedTask(taskId, { status: "completed", result });
			await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "completed", result });
			return result;
		} catch (err: any) {
			const message = err.message || "Unknown error";
			this.updateDelegatedTask(taskId, { status: "failed", error: message });
			await triggerHooks("SubagentStop", { agentId: this.config.agentId, sessionId: this.config.sessionId, taskId, status: "failed", result: message });
			throw err;
		} finally {
			this.runningSubloops.delete(taskId);
		}
	}

	/** List delegated-task records (persisted) for this owner, optionally scoped. */
	listDelegatedTasks(filter?: { rootTaskId?: string; parentTaskId?: string }): DelegatedTaskRecord[] {
		return this.config.db?.listDelegatedTasks?.({
			ownerAgentId: filter?.rootTaskId ? undefined : this.config.agentId,
			rootTaskId: filter?.rootTaskId,
			parentTaskId: filter?.parentTaskId,
		}) ?? [];
	}

	suspendUntilWake(timeoutMs: number, taskId?: string): Promise<string> {
		return this.taskRegistry.suspendUntilWake(timeoutMs, taskId);
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
		this.taskRegistry.cleanup();
	}
}
