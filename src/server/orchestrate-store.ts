// Orchestrate 计划/清单存储 + confirm 门挂起注册表 (v0.8 M3)
//
// # 文件说明书
//
// ## 核心功能
// 1. OrchestratePlanStore — 持久化 lead 提交的 Orchestrate DSL flow + confirm
//    门状态(pending/confirmed/rejected/...)(决策 11)。
// 2. OrchestrateManifestStore — 持久化每次 run 产出的 manifest(改了哪些文件、
//    跑了哪些测试、审查结果)(决策 34)。
// 3. ConfirmRegistry — 内存挂起表:`Orchestrate.confirm` 工具执行时返回一个未
//    resolve 的 Promise,resolve/reject 句柄存在这里;外部 IPC confirm/reject
//    路径按 planId 触发 resolve(决策 11 关键约束:「停住不占资源」)。
//
// ## 挂起语义(验收硬指标)
// 工具 execute 内 `await new Promise(...)`:这是个 await 点,await 时既不发
// 下一次 LLM call,也不轮询,也不占 CPU —— loop 已在 await 这个工具结果,
// 自然停在这里直到外部 IPC 唤醒。真正的挂起,不是忙等。
//
// ## 输入
// - CoreDatabase
// - OrchestrateFlow / OrchestratePlanRecord / OrchestrateManifestRecord
//
// ## 输出
// - OrchestratePlanStore 类
// - OrchestrateManifestStore 类
// - ConfirmRegistry 单例
//
// ## 定位
// 服务层存储,被 orchestrate-tool / IPC confirm handler 使用。
//
// ## 依赖
// - ./sqlite-store, ./session-db
// - ../shared/types
//
// ## 维护规则
// - 列定义同步 db-migration.ts 的 *_COLUMNS
// - ConfirmRegistry 仅内存,重启后 pending plan 由 cron 兜底重新拉起
//

import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { CoreDatabase } from "./core-database.js";
import type {
	OrchestrateFlow,
	OrchestratePlanRecord,
	OrchestrateConfirmState,
	OrchestrateManifestRecord,
} from "../shared/types.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const ORCHESTRATE_PLAN_COLUMNS: ColumnDef[] = [
	{ key: "requirementId", column: "requirement_id" },
	{ key: "projectId", column: "project_id" },
	{ key: "leadAgentId", column: "lead_agent_id" },
	{ key: "leadSessionId", column: "lead_session_id" },
	{ key: "flow", json: true },
	{ key: "state" },
	{ key: "rejectionReason", column: "rejection_reason" },
	{ key: "manifestId", column: "manifest_id" },
];

const ORCHESTRATE_MANIFEST_COLUMNS: ColumnDef[] = [
	{ key: "requirementId", column: "requirement_id" },
	{ key: "planId", column: "plan_id" },
	{ key: "projectId", column: "project_id" },
	{ key: "touchedFiles", column: "touched_files", json: true },
	{ key: "tests", json: true },
	{ key: "review", json: true },
	{ key: "summary" },
];

// ---------------------------------------------------------------------------
// OrchestratePlanStore
// ---------------------------------------------------------------------------

export class OrchestratePlanStore {
	private store: SqliteStore<OrchestratePlanRecord>;

	constructor(sessionDB: CoreDatabase) {
		this.store = new SqliteStore<OrchestratePlanRecord>(
			sessionDB.getDb(),
			"orchestrate_plans",
			ORCHESTRATE_PLAN_COLUMNS,
		);
	}

	list(filter?: { requirementId?: string; projectId?: string; state?: OrchestrateConfirmState }): OrchestratePlanRecord[] {
		let result = this.store.list();
		if (filter?.requirementId) result = result.filter((r) => r.requirementId === filter.requirementId);
		if (filter?.projectId) result = result.filter((r) => r.projectId === filter.projectId);
		if (filter?.state) result = result.filter((r) => r.state === filter.state);
		return result;
	}

	get(id: string): OrchestratePlanRecord | undefined {
		return this.store.get(id);
	}

	/** Find the most recent plan submitted by a lead session (for confirm/reject routing). */
	findLatestPendingForSession(sessionId: string): OrchestratePlanRecord | undefined {
		const plans = this.store.list()
			.filter((p) => p.leadSessionId === sessionId && p.state === "pending")
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		return plans[0];
	}

	create(input: Omit<OrchestratePlanRecord, "id" | "createdAt" | "updatedAt">): OrchestratePlanRecord {
		return this.store.create(input as any);
	}

	update(id: string, input: Partial<Omit<OrchestratePlanRecord, "id" | "createdAt">>): OrchestratePlanRecord {
		return this.store.update(id, input as any);
	}

	setState(id: string, state: OrchestrateConfirmState, extra?: { rejectionReason?: string; manifestId?: string }): OrchestratePlanRecord {
		return this.store.update(id, { state, ...extra } as any);
	}

	delete(id: string): void {
		this.store.delete(id);
	}
}

// ---------------------------------------------------------------------------
// OrchestrateManifestStore
// ---------------------------------------------------------------------------

export class OrchestrateManifestStore {
	private store: SqliteStore<OrchestrateManifestRecord>;

	constructor(sessionDB: CoreDatabase) {
		this.store = new SqliteStore<OrchestrateManifestRecord>(
			sessionDB.getDb(),
			"orchestrate_manifests",
			ORCHESTRATE_MANIFEST_COLUMNS,
		);
	}

	list(filter?: { requirementId?: string; planId?: string; projectId?: string }): OrchestrateManifestRecord[] {
		let result = this.store.list();
		if (filter?.requirementId) result = result.filter((r) => r.requirementId === filter.requirementId);
		if (filter?.planId) result = result.filter((r) => r.planId === filter.planId);
		if (filter?.projectId) result = result.filter((r) => r.projectId === filter.projectId);
		return result;
	}

	get(id: string): OrchestrateManifestRecord | undefined {
		return this.store.get(id);
	}

	create(input: Omit<OrchestrateManifestRecord, "id" | "createdAt" | "updatedAt">): OrchestrateManifestRecord {
		return this.store.create(input as any);
	}

	/** Latest manifest for a requirement (PM reads for coverage judgement). */
	findLatestForRequirement(requirementId: string): OrchestrateManifestRecord | undefined {
		const ms = this.store.list()
			.filter((m) => m.requirementId === requirementId)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		return ms[0];
	}
}

// ---------------------------------------------------------------------------
// ConfirmRegistry — the in-memory pending Promise table (decision 11 关键)
// ---------------------------------------------------------------------------

/**
 * Tracks pending confirmations for Orchestrate flows. When the Orchestrate tool
 * is submitted with confirm semantics, it stores a never-resolved Promise here
 * (plus its resolve/reject handles) keyed by planId; the IPC confirm/reject
 * path then resolves it from the outside.
 *
 * Stays in memory only — pending plans survive a restart by being re-read on
 * startup (state="pending" in store → cron fallback re-surfaces them). No
 * Promise survives across restart by definition (it's an in-process handle).
 */
export class ConfirmRegistry {
	private pending: Map<string, {
		promise: Promise<boolean>;
		resolve: (v: boolean) => void;
		reject: (err: Error) => void;
		createdAt: number;
	}> = new Map();

	private static instance: ConfirmRegistry | null = null;

	// N1 (runtime-push-ui-sync): ping subscribers when the set of pending
	// confirmations changes (register / confirm / reject / drop). The kanban
	// pulls the pending list on display; server/index.ts translates the ping
	// into a runtime:orchestrate:changed broadcast.
	private listeners = new Set<() => void>();

	static getInstance(): ConfirmRegistry {
		if (!this.instance) this.instance = new ConfirmRegistry();
		return this.instance;
	}

	/** Subscribe to pending-set change pings. Returns an unsubscribe fn. */
	subscribe(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => { this.listeners.delete(cb); };
	}

	private emitChange(): void {
		for (const cb of this.listeners) {
			try { cb(); } catch { /* listener errors are non-fatal */ }
		}
	}

	/** Register a pending confirmation. Returns a Promise that resolves when confirm/reject is called. */
	register(planId: string): Promise<boolean> {
		// If already registered (e.g. duplicate submit), reuse the existing promise
		// so the original resolve/reject handles still drive resolution.
		const existing = this.pending.get(planId);
		if (existing) return existing.promise;

		let resolve!: (v: boolean) => void;
		let reject!: (err: Error) => void;
		const promise = new Promise<boolean>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		this.pending.set(planId, { promise, resolve, reject, createdAt: Date.now() });
		log.debug("orchestrate-confirm", `Registered pending plan: ${planId}`);
		this.emitChange();
		return promise;
	}

	/** Confirm a pending plan → resolves its awaiting tool promise to true. */
	confirm(planId: string): boolean {
		const entry = this.pending.get(planId);
		if (!entry) return false;
		this.pending.delete(planId);
		entry.resolve(true);
		log.debug("orchestrate-confirm", `Confirmed plan: ${planId}`);
		this.emitChange();
		return true;
	}

	/** Reject a pending plan → resolves its awaiting tool promise to false. */
	reject(planId: string): boolean {
		const entry = this.pending.get(planId);
		if (!entry) return false;
		this.pending.delete(planId);
		entry.resolve(false);
		log.debug("orchestrate-confirm", `Rejected plan: ${planId}`);
		this.emitChange();
		return true;
	}

	/** Drop a pending entry without resolving (e.g. session died). Returns false if not present. */
	drop(planId: string): boolean {
		const entry = this.pending.get(planId);
		if (!entry) return false;
		this.pending.delete(planId);
		// Reject to unblock any awaiter so the tool returns cleanly.
		entry.reject(new Error(`Confirmation dropped: ${planId}`));
		this.emitChange();
		return true;
	}

	/** Test helper: check if a plan is currently pending. */
	isPending(planId: string): boolean {
		return this.pending.has(planId);
	}

	/** List all currently-pending plan IDs (for kanban "plan pending" surfacing). */
	listPendingPlanIds(): string[] {
		return Array.from(this.pending.keys());
	}
}
