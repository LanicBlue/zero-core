// 平台管理服务 (v0.8 P3 — 工具按功能命名,RFC §7.3)
//
// # 文件说明书
//
// ## 核心功能
// 给"zero"全局管理角色提供对话式 workflow 搭建能力 (RFC §2.14 / §7.3 /
// 决策 24)。本服务是工具的能力后端,**能力在工具,agent 只是工具的组合**。
//
//   - create / update / delete / get / list  → Project (§8.2)
//   - create / update / delete / get / list / listTemplates / getTemplate
//                                                → Agent     (§7.3)
//   - create / update / delete / get / list / trigger → Cron  (§9.4)
//   - 各域扩展点 (e.g. ensureProjectSubtree) → P5 容器视图
//
// ## 命名沿革 (zero-admin → management)
// 本服务原名 `ZeroAdminService`,文件名 `zero-admin-service.ts`。v0.8 P3 按
// RFC §7.3 硬原则(工具按功能命名,不按 agent 命名)整体改名:
//   - `ZeroAdminService`  → `ManagementService`
//   - `zero-admin-service.ts` → `management-service.ts`
//   - 类别 `zero-admin` → `management`
//   - 上下文句柄 `ctx.zeroAdmin` → `ctx.management`
//
// ## 删除的能力 (v0.8 P3 / §7.7 + §11.5 收尾)
//   - `InstantiatePreset`            —— 由 Agent create + template 替代
//   - `SetToolPolicy`/`SetToolEnabled`—— 并入 Agent update
//   - `ExposeAgentAsTool`/`UnexposeAgentAsTool`(P2 已废 expose;§11.5 彻底删
//     AgentToolStore + exposeAgentAsTool / ensureRoleAgentExposed)
//   - 残留的 internal 方法已全部删除。template create 走 subagents(AgentRecord)。
//
// ## 输入
// - AgentStore / ProjectStore / CronStore
//
// ## 输出
// - ManagementService 实例,被 management tools (runtime/tools) 使用
//
// ## 定位
// 服务层,被 server/index.ts 实例化并注入到 zero session 的 SessionConfig.management。
//
// ## 维护规则
// - 不持久化任何状态(纯封装 stores)
// - template create 时同步把 whitelistedRoleTags 解析为 subagents(按 agentId keyed)
// - delete zero agent / delete referenced agent 拒绝
//

import type { AgentStore } from "./agent-store.js";
import type { AgentService } from "./agent-service.js";
import type { ProjectStore } from "./project-store.js";
import type { CronStore } from "./cron-store.js";
import type { RequirementStore } from "./requirement-store.js";
import type { SessionDB } from "./session-db.js";
import type { WikiStore } from "./wiki-node-store.js";
import type { WikiSkeletonService } from "./wiki-skeleton-service.js";
import type { ProjectJobStore } from "./project-job-store.js";
import { resolveSessionByRoleProject } from "./session-context-router.js";
import type {
	AgentRecord,
	ProjectRecord,
	CronRecord,
	CronSchedule,
	ProjectContainerView,
	ProjectResourceUsage,
	ProjectArchivistBinding,
	RequirementRecord,
	RequirementStatus,
	PromptTemplate,
	AgentVia,
	ProjectWorkRecord,
	ProjectWorkView,
	CreateProjectWorkBody,
	FireProjectWorkResult,
} from "../shared/types.js";
import type { TemplateStore } from "./template-store.js";
import type { TaskStepStore } from "./task-step-store.js";
import type { ProjectWorkStore } from "./project-work-store.js";
import type { ProjectWorkRunner } from "./project-work-runner.js";
import { BUILTIN_WORKFLOW_ROLES } from "./builtin-role-templates.js";
import { resolveOperationPrompt, agentHasWikiTool, agentHasTool, WIKI_OPERATIONS, type WikiOperationId, wrapGitAwarePrompt, isGitAwarePrompt } from "./wiki-operations.js";
import { DEFAULT_PROJECT_WORKS } from "./builtin-work-templates.js";
import { log } from "../core/logger.js";

export interface ManagementDeps {
	agentStore: AgentStore;
	projectStore: ProjectStore;
	/**
	 * v0.8 (模板统一): the single template store. Role-identity templates
	 * (lead/pm/zero/...) now live here as built-in PromptTemplate seeds, so
	 * `AgentRegistry.listTemplates` and the UI Templates page read the same
	 * table. Optional so legacy callers/tests that only need project/agent CRUD
	 * still construct without it; the template actions require it, though.
	 */
	templateStore?: TemplateStore;
	/** v0.8 M1: cron store — optional so M0 callers (and tests) still work. */
	cronStore?: CronStore;
	/**
	 * v0.8 P5 (§8.4 / §8.5): container-view + resource-usage dependencies.
	 * All optional so P3-era callers (and tests) that only need project CRUD
	 * still construct the service without these. P5 wires them in production.
	 */
	requirementStore?: RequirementStore;
	sessionDB?: SessionDB;
	wikiStore?: WikiStore;
	archivistService?: WikiSkeletonService;
	/** v0.8 §8.6: task-step store for the project-delete cascade. */
	taskStepStore?: TaskStepStore;
}

/**
 * Requirement statuses shown in the container view's `requirementsByStatus`
 * grouping (§8.4). Includes every status the state machine emits — even
 * terminal ones — so the UI can render a complete column / count summary.
 */
const CONTAINER_REQUIREMENT_STATUSES: RequirementStatus[] = [
	"found", "discuss", "ready", "plan",
	"build", "verify", "closed", "cancelled",
];

/**
 * v0.8 P3: ManagementService (renamed from ZeroAdminService).
 *
 * Capability backend for the domain tools (Project / Agent / Cron / Wiki).
 * The capability lives in the tools; agents are just tool-config bundles.
 */
// tool-decoupling(决策 1):process-wide 单例 getter/setter。启动时注册;
// 工具(Project / Work / AgentRegistry / Cron action 工具)import
// { getManagementService } 直读 capability 后端。headless 无则 undefined。
let _managementService: ManagementService | undefined;
export function getManagementService(): ManagementService | undefined {
	return _managementService;
}
export function setManagementService(s: ManagementService | undefined): void {
	_managementService = s;
}

export class ManagementService {
	private agentStore: AgentStore;
	private projectStore: ProjectStore;
	private templateStore: TemplateStore | null;
	private cronStore: CronStore | null;
	// v0.8 P5 (§8.4 / §8.5): container view + resource usage deps. Late-bound
	// via setters so production wiring order (server/index.ts constructs the
	// management service before its service-layer dependencies) is preserved.
	private requirementStore: RequirementStore | null;
	private sessionDB: SessionDB | null;
	private wikiStore: WikiStore | null;
	private archivistService: WikiSkeletonService | null;
	// v0.8: task-step store for the project-delete cascade (§8.6). Late-bound.
	private taskStepStore: TaskStepStore | null;
	/** project_jobs store (wiki 充实等后台任务的 run 记录). Late-bound. */
	private projectJobStore: ProjectJobStore | null;
	/** EnrichmentRunner (M2 注入) — 拉 archivist agent 后台充实 wiki. Late-bound. */
	private enrichmentRunner: ((projectId: string, opts: { via: AgentVia; prompt?: string; operationId?: WikiOperationId }) => Promise<{ jobId: string; sessionId: string }>) | null;
	/** project_work store(取代工作流角色的"工位/工作"系统). Late-bound. */
	private projectWorkStore: ProjectWorkStore | null;
	/** ProjectWorkRunner(手动/hook 触发执行). Late-bound. */
	private projectWorkRunner: ProjectWorkRunner | null;

	constructor(deps: ManagementDeps) {
		this.agentStore = deps.agentStore;
		this.projectStore = deps.projectStore;
		this.templateStore = deps.templateStore ?? null;
		this.cronStore = deps.cronStore ?? null;
		this.requirementStore = deps.requirementStore ?? null;
		this.sessionDB = deps.sessionDB ?? null;
		this.wikiStore = deps.wikiStore ?? null;
		this.archivistService = deps.archivistService ?? null;
		this.taskStepStore = deps.taskStepStore ?? null;
		this.projectJobStore = null;
		this.enrichmentRunner = null;
		this.projectWorkStore = null;
		this.projectWorkRunner = null;
	}

	/** v0.8 (模板统一): late-bind the template store (server/index.ts wiring order). */
	setTemplateStore(store: TemplateStore): void { this.templateStore = store; }

	private requireTemplateStore(): TemplateStore {
		if (!this.templateStore) throw new Error("TemplateStore not wired into ManagementService");
		return this.templateStore;
	}

	/** v0.8 M1: late-bind the cron store. */
	setCronStore(cronStore: CronStore): void {
		this.cronStore = cronStore;
	}

	/** v0.8 P5: late-bind container-view dependencies (server/index.ts order). */
	setRequirementStore(store: RequirementStore): void { this.requirementStore = store; }
	setSessionDB(db: SessionDB): void { this.sessionDB = db; }
	private agentService: AgentService | null = null;
	setAgentService(a: AgentService): void { this.agentService = a; }
	setWikiStore(wiki: WikiStore): void {
		this.wikiStore = wiki;
		// backfill:把存量 agent 的 memory 根 title 同步成 agent 名字(旧 DB 里
		// 可能还是 "Memory: <agentId>")。幂等,新建的由 createAgent 处理。
		for (const a of this.agentStore.list()) {
			this.wikiStore?.ensureMemoryAgentRoot(a.id, a.name);
		}
	}
	setArchivistService(svc: WikiSkeletonService): void { this.archivistService = svc; }
	/** v0.8 §8.6: late-bind the task-step store (server/index.ts wiring order). */
	setTaskStepStore(store: TaskStepStore): void { this.taskStepStore = store; }
	/** Late-bind the project_jobs store. */
	setProjectJobStore(store: ProjectJobStore): void { this.projectJobStore = store; }
	/** M2 注入 enrichment runner(把 archivist agent 拉起来充实 wiki)。 */
	setEnrichmentRunner(fn: (projectId: string, opts: { via: AgentVia; prompt?: string; operationId?: WikiOperationId }) => Promise<{ jobId: string; sessionId: string }>): void {
		this.enrichmentRunner = fn;
	}
	/** v0.8 project-work: late-bind the project_work store. */
	setProjectWorkStore(store: ProjectWorkStore): void { this.projectWorkStore = store; }
	/** v0.8 project-work: late-bind the runner(手动/hook 触发). */
	setProjectWorkRunner(runner: ProjectWorkRunner): void { this.projectWorkRunner = runner; }

	private requireProjectWorkStore(): ProjectWorkStore {
		if (!this.projectWorkStore) throw new Error("ProjectWorkStore not wired into ManagementService");
		return this.projectWorkStore;
	}
	private requireProjectWorkRunner(): ProjectWorkRunner {
		if (!this.projectWorkRunner) throw new Error("ProjectWorkRunner not wired into ManagementService");
		return this.projectWorkRunner;
	}

	getProjectJobStore(): ProjectJobStore | null { return this.projectJobStore; }

	private requireCronStore(): CronStore {
		if (!this.cronStore) throw new Error("CronStore not wired into ManagementService");
		return this.cronStore;
	}

	// ─── Projects (§8.2) ──────────────────────────────────────────

	/**
	 * v0.8 (P5 §8.3): create a Project + the synchronous wiki subtree root
	 * (so the project is immediately usable) + fire an asynchronous
	 * archivist background scan (kick, non-blocking). Returns the freshly-
	 * created ProjectRecord; the scan runs in the background and the
	 * project dashboard reports its progress.
	 *
	 * `ensureProjectSubtree` is idempotent and creates the empty
	 * `wiki-root:<projectId>` root. The async kick is best-effort — a
	 * missing archivist service (e.g. in tests) is silently skipped.
	 */
	createProject(input: { name: string; workspaceDir: string; enrich?: boolean; via?: AgentVia }): ProjectRecord {
		const project = this.projectStore.create(input);
		// §8.3 synchronous: ensure the empty wiki subtree root exists so the
		// project is immediately usable (archivist fills it in the background).
		try {
			this.wikiStore?.ensureProjectSubtree(project.id, project.name);
		} catch (err) {
			log.warn("management", `ensureProjectSubtree failed for ${project.id}:`, (err as Error).message);
		}
		// §8.3 asynchronous: kick the archivist background scan. Best-effort —
		// archivist might not be wired (tests). Failures log but never block
		// project creation.
		if (this.archivistService) {
			this.archivistService
				.buildSkeleton(project.id)
				.then((r) => {
					if (r.notes && r.notes.length > 0) {
						log.debug("management", `archivist scan ${project.id}: ${r.notes.join("; ")}`);
					}
				})
				.catch((err) => {
					log.warn("management", `archivist background scan failed for ${project.id}:`, (err as Error).message);
				});
		}
		// 可选:起 agent 深度充实 wiki(骨架扫描无 LLM,充实才调 LLM)。
		// v0.8 去 fallback:必须 via.agentId(已存在、配了 Wiki 工具的 agent)。
		// 无 via.agentId 时跳过 + warn(创建 project 时若未指定 agent,不自动充实)。
		if (input.enrich && this.enrichmentRunner) {
			if (!input.via?.agentId) {
				log.warn("management", `enrich skipped for ${project.id}: via.agentId required (no fallback) — Run archivist with an agent that has the Wiki tool.`);
			} else {
				void this.enrichProject(project.id, { via: input.via }).catch((err) => {
					log.warn("management", `enrich kick failed for ${project.id}:`, (err as Error).message);
				});
			}
		}
		// v0.8 project-work:seed 默认工位(全空岗)。projectWorkStore 未注入(测试)
		// 时跳过。幂等:已有 work 不重 seed。
		if (this.projectWorkStore) {
			try { this.seedDefaultProjectWorks(project.id); }
			catch (err) { log.warn("management", `seedDefaultProjectWorks failed for ${project.id}:`, (err as Error).message); }
		}
		return project;
	}

	/**
	 * 起一个 wiki 充实 agent run(archivist agent 读代码,给每个文件/目录节点写
	 * 详 doc + 准确 summary)。非阻塞 —— 内部 fire-and-forget,立即返回 jobId/
	 * sessionId,run 在后台跑,完成/失败写回 project_jobs。via 决定"谁来充实"
	 * (默认 { role: "archivist" }),代码不硬绑具体角色。
	 *
	 * 需先注入 enrichment runner(M2 setEnrichmentRunner),否则抛错。
	 */
	async enrichProject(projectId: string, opts: { via?: AgentVia; prompt?: string; operationId?: WikiOperationId } = {}): Promise<{ jobId: string; sessionId: string }> {
		if (!this.enrichmentRunner) {
			throw new Error("EnrichmentRunner not wired into ManagementService");
		}
		// 无 fallback:via.agentId 必填(必须选已存在的、配了 Wiki 工具的 agent)。
		// 默认 { role: "archivist" } 自动建 agent 的路径已删(推动弃用工作流角色)。
		if (!opts.via?.agentId) {
			throw new Error("enrichProject requires via.agentId — select an existing agent with the Wiki tool (no fallback).");
		}
		return this.enrichmentRunner(projectId, { via: opts.via, prompt: opts.prompt, operationId: opts.operationId });
	}

	/**
	 * M4: find-or-create 一个 agent 在指定 project 上的 session。session 模型从
	 * main-session 改为 `(agentId, projectId?)` 路由后,这是渲染端"跳转到某 project
	 * 的 chat"所需的后端原语 —— 复用 resolveSessionByRoleProject (find-or-create,
	 * 续接语义)。无 projectId 的 General 单例由渲染端自行用 sessionsNew 保证。
	 *
	 * 需 sessionDB 已注入。
	 */
	ensureProjectSession(agentId: string, projectId: string): { sessionId: string; created: boolean } {
		if (!this.sessionDB) throw new Error("SessionDB not wired into ManagementService");
		const { session, created } = resolveSessionByRoleProject(
			{ sessionDB: this.sessionDB, projectStore: this.projectStore },
			agentId,
			projectId,
		);
		return { sessionId: session.id, created };
	}

	updateProject(id: string, input: Partial<Omit<ProjectRecord, "id" | "createdAt">>): ProjectRecord {
		return this.projectStore.update(id, input);
	}

	/**
	 * v0.8 §8.6 (bugfix): purge orphan wiki project subtrees — subtree roots
	 * (`wiki-root:<projectId>`) whose projectId no longer exists in the
	 * `projects` table. These accumulate when a project was deleted through a
	 * path that didn't cascade (pre-fix tool delete). Idempotent — call at
	 * startup; a no-op once no orphans remain. Returns the count removed.
	 */
	purgeOrphanProjectSubtrees(): number {
		if (!this.wikiStore) return 0;
		const liveProjectIds = new Set(this.projectStore.list().map((p) => p.id));
		let removed = 0;
		for (const node of this.wikiStore.list()) {
			if (
				node.id.startsWith("wiki-root:") &&
				node.id !== "wiki-root:global" &&
				node.id !== "wiki-root:projects" &&
				!node.id.startsWith("wiki-root:memory") &&
				node.projectId &&
				!liveProjectIds.has(node.projectId)
			) {
				this.wikiStore.deleteByProject(node.projectId);
				removed++;
			}
		}
		return removed;
	}

	/**
	 * Delete a Project with the FULL cascade (§8.6). This is the single source
	 * of truth for project deletion — both the REST router and the Project tool
	 * go through here, so the cascade can never drift between entry points
	 * (which previously left orphan wiki subtrees / requirements / crons when a
	 * project was deleted via the tool path).
	 *
	 * Cascade: requirements (→ task_steps + status_history + messages inside
	 * RequirementStore.delete) + task_steps + wiki subtree + project-scoped
	 * crons + the project row. Optional deps that aren't wired (tests) simply
	 * contribute nothing; the project row is always deleted.
	 *
	 * Runs as one transaction when a SessionDB is available so a partial
	 * failure can't leave the project half-deleted.
	 */
	deleteProject(id: string): void {		const doDelete = () => {
			// task_steps for this project's requirements (RequirementStore.delete
			// does NOT cascade task_steps; clean them explicitly first).
			if (this.requirementStore && this.taskStepStore) {
				for (const r of this.requirementStore.listByProject(id)) {
					this.taskStepStore.deleteByRequirement(r.id);
				}
			}
			// requirements (cascades status_history + messages inside .delete)
			if (this.requirementStore) {
				for (const r of this.requirementStore.listByProject(id)) {
					this.requirementStore.delete(r.id);
				}
			}
			// wiki subtree (root + all descendants + body files)
			this.wikiStore?.deleteByProject(id);
			// project-scoped crons
			if (this.cronStore) {
				for (const c of this.cronStore.list()) {
					if (c.workingScope?.projectId === id) this.cronStore.delete(c.id);
				}
			}
			// the project row itself
			this.projectStore.delete(id);
		};
		if (this.sessionDB) {
			this.sessionDB.getDb().transaction(doDelete)();
			return;
		}
		doDelete();
	}

	listProjects(): ProjectRecord[] {
		return this.projectStore.list();
	}

	getProject(id: string): ProjectRecord | undefined {
		return this.projectStore.get(id);
	}

	/**
	 * v0.8 (P5 §8.4): the container view. Aggregates the project's requirements
	 * (grouped by status), project-scoped crons, wiki subtree summary, and
	 * currently-active sessions. **Does not include an agent list** — agents
	 * are global roles, not project members.
	 *
	 * Throws if the project does not exist. Container-view dependencies that
	 * weren't wired (e.g. in tests) contribute empty results rather than
	 * throwing — the project record itself is still returned.
	 */
	getProjectContainerView(projectId: string): ProjectContainerView {
		const project = this.projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);

		// requirementsByStatus — group RequirementStore.listByProject by status.
		const requirementsByStatus = {} as Record<RequirementStatus, RequirementRecord[]>;
		for (const s of CONTAINER_REQUIREMENT_STATUSES) requirementsByStatus[s] = [];
		if (this.requirementStore) {
			const reqs = this.requirementStore.listByProject(projectId);
			for (const r of reqs) {
				const bucket = requirementsByStatus[r.status];
				if (bucket) bucket.push(r);
			}
		}

		// crons — filter CronStore by workingScope.projectId.
		const crons: CronRecord[] = this.cronStore
			? this.cronStore.list().filter((c) => c.workingScope?.projectId === projectId)
			: [];

		// wikiSummary — nodeCount + lastUpdated + scan progress signals.
		let nodeCount = 0;
		let lastUpdated: string | null = null;
		let scanPhase: string | null = null;
		let scanProgress: number | null = null;
		if (this.wikiStore) {
			const nodes = this.wikiStore.listByProject(projectId);
			nodeCount = nodes.length;
			for (const n of nodes) {
				if (n.updatedAt && (lastUpdated === null || n.updatedAt > lastUpdated)) {
					lastUpdated = n.updatedAt;
				}
			}
			// Progress: surface structure-node presence as a coarse 0/0.5/1
			// signal. Empty subtree (just the root) → 0; root + structure
			// nodes → 0.5; root + structure + detail/header nodes → 1. The
			// fine-grained cursor-driven phase lives in P1/P7 (archivist
			// reports it); here we only project what the wiki tree already
			// knows so the dashboard has something to show.
			const structureCount = nodes.filter((n) => n.type === "structure" || n.type === "project").length;
			const detailCount = nodes.filter((n) => n.type === "header" || n.type === "intent").length;
			if (structureCount > 0 && detailCount > 0) {
				scanProgress = 1;
				scanPhase = "detail";
			} else if (structureCount > 0) {
				scanProgress = 0.5;
				scanPhase = "structure";
			} else if (nodeCount > 0) {
				// Only the empty root exists — scan hasn't filled anything yet.
				scanProgress = 0;
				scanPhase = null;
			} else {
				scanProgress = 0;
				scanPhase = null;
			}
		}

		// activeSessions — sessions whose context.projectId matches. We list
		// all sessions (the table is small in practice) and project to a thin
		// shape {agentId, name, sessionId}. Agent name is resolved through
		// agentStore (best-effort; falls back to the agentId).
		const activeSessions: ProjectContainerView["activeSessions"] = [];
		if (this.sessionDB) {
			const sessions = this.sessionDB.listAllSessions();
			for (const s of sessions) {
				if (s.context?.projectId !== projectId) continue;
				const agent = s.agentId ? this.agentStore.get(s.agentId) : undefined;
				activeSessions.push({
					agentId: s.agentId,
					name: agent?.name ?? s.agentId,
					sessionId: s.id,
					running: !!this.agentService?.isSessionRunning(s.id),
				});
			}
		}

		return {
			project,
			requirementsByStatus,
			crons,
			wikiSummary: { nodeCount, lastUpdated, scanPhase, scanProgress },
			activeSessions,
			archivistBinding: this.getProjectArchivistBinding(project.id),
			projectWorks: this.projectWorkStore ? this.getProjectWorks(project.id) : undefined,
		};
	}

	/**
	 * v0.8 (P5 §8.5): SUM of token / cost columns over every session whose
	 * context.projectId matches. Sessions without a projectId (global/zero)
	 * never contribute to any project.
	 *
	 * Implemented as a single SQL aggregate over the indexed
	 * `context_project_id` column (added in M0 §3.5). The WHERE clause is
	 * exact — sessions with NULL projectId are excluded by SQLite's
	 * standard NULL inequality, satisfying the "global sessions don't
	 * count" rule.
	 */
	getProjectResourceUsage(projectId: string): ProjectResourceUsage {
		if (!this.sessionDB) {
			return {
				projectId,
				inputTokens: 0, outputTokens: 0, totalTokens: 0,
				cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
				estimatedCostUsd: 0, sessionCount: 0,
			};
		}
		const db = this.sessionDB.getDb();
		const row = db.prepare(
			`SELECT
				COALESCE(SUM(input_tokens), 0)        AS inputTokens,
				COALESCE(SUM(output_tokens), 0)       AS outputTokens,
				COALESCE(SUM(total_tokens), 0)        AS totalTokens,
				COALESCE(SUM(cache_read_tokens), 0)   AS cacheReadTokens,
				COALESCE(SUM(cache_write_tokens), 0)  AS cacheWriteTokens,
				COALESCE(SUM(reasoning_tokens), 0)    AS reasoningTokens,
				COALESCE(SUM(estimated_cost_usd), 0)  AS estimatedCostUsd,
				COUNT(*)                              AS sessionCount
			 FROM sessions
			 WHERE context_project_id = ? AND archived = 0`,
		).get(projectId) as any;
		return {
			projectId,
			inputTokens: row.inputTokens ?? 0,
			outputTokens: row.outputTokens ?? 0,
			totalTokens: row.totalTokens ?? 0,
			cacheReadTokens: row.cacheReadTokens ?? 0,
			cacheWriteTokens: row.cacheWriteTokens ?? 0,
			reasoningTokens: row.reasoningTokens ?? 0,
			estimatedCostUsd: row.estimatedCostUsd ?? 0,
			sessionCount: row.sessionCount ?? 0,
		};
	}

	// ─── Agents (§7.3) ────────────────────────────────────────────

	createAgent(input: Omit<AgentRecord, "id" | "createdAt" | "updatedAt">): AgentRecord {
		const rec = this.agentStore.create(input);
		// 立刻建 memory 根并按 agent 名字命名(不等 extractor 懒建)。
		this.wikiStore?.ensureMemoryAgentRoot(rec.id, rec.name);
		return rec;
	}

	updateAgent(id: string, input: Partial<Omit<AgentRecord, "id" | "createdAt">>): AgentRecord {
		// toolPolicy is a nested config you toggle per-tool, so a partial update
		// (e.g. disable one tool) must MERGE — otherwise passing {tools:{WebSearch:
		// {enabled:false}}} wipes every other tool. Other fields are scalar/arrays
		// and stay replace. See mergeToolPolicy for the same merge logic.
		// memory-archive-fixes sub-2: capture the old name BEFORE the store
		// update so the memory-root disk dir can be migrated to the new name
		// (subtreeSeg derives the folder from the title, which is set from the
		// agent name).
		const oldAgent = this.agentStore.get(id);
		const oldName = oldAgent?.name;
		let updated: AgentRecord;
		if (input.toolPolicy !== undefined) {
			const agent = this.agentStore.get(id);
			if (agent) {
				const merged = {
					...(agent.toolPolicy ?? {}),
					...input.toolPolicy,
					tools: { ...(agent.toolPolicy?.tools ?? {}), ...(input.toolPolicy.tools ?? {}) },
				};
				const { toolPolicy: _drop, ...rest } = input;
				void _drop;
				updated = this.agentStore.update(id, { ...rest, toolPolicy: merged });
			} else {
				updated = this.agentStore.update(id, input);
			}
		} else {
			updated = this.agentStore.update(id, input);
		}
		// rename 同步:agent 改名 → memory 根 title 跟着改 + 磁盘目录迁移。
		// ensureMemoryAgentRoot updates the title (update() moves the root's own
		// body file); renameMemoryAgentDiskDir moves the children's body files
		// so the whole per-agent folder follows the new name.
		if (input.name !== undefined && oldName !== undefined && oldName !== input.name) {
			this.wikiStore?.ensureMemoryAgentRoot(id, input.name);
			this.wikiStore?.renameMemoryAgentDiskDir(id, oldName);
		}
		return updated;
	}

	/**
	 * Delete an Agent. Refuses to delete the protected "zero" management
	 * agent — the protection lives at the STORE layer (AgentStore.delete),
	 * so EVERY deletion path (REST router, this tool, any future caller)
	 * is uniformly blocked. No roleTag/name check here on purpose.
	 *
	 * Cascade-cleans any cron entries bound to it.
	 */
	deleteAgent(id: string): void {
		const agent = this.agentStore.get(id);
		if (!agent) throw new Error(`Agent not found: ${id}`);
		// v0.8 §11.5: agent-as-tool retired — no AgentToolStore rows to cascade.
		// subagents are soft refs (no cascade on agent delete by design).
		this.cronStore?.deleteByAgent(id);
		// project-work:解绑指向该 agent 的工位(agentId → null = 空岗),否则
		// 工位会指向已删 agent,ProjectPage 显示原始 id、触发也会失败。
		if (this.projectWorkStore) {
			for (const w of this.projectWorkStore.list()) {
				if (w.agentId === id) this.projectWorkStore.update(w.id, { agentId: null });
			}
		}
		// sessions:归档该 agent 的全部 session(不硬删,保留历史;archived=1 后
		// 从 activeSessions / 列表 / 路由排除,不再以原始 agent id 露出)。
		if (this.sessionDB) {
			for (const s of this.sessionDB.listSessions(id)) {
				this.sessionDB.archiveSession(s.id);
			}
		}
		// AgentStore.delete throws if the agent is the protected "zero".
		this.agentStore.delete(id);
	}

	listAgents(roleTag?: string): AgentRecord[] {
		return roleTag ? this.agentStore.listByRoleTag(roleTag) : this.agentStore.list();
	}

	getAgent(id: string): AgentRecord | undefined {
		return this.agentStore.get(id);
	}

	// ─── Templates (能力模板) + Roles (工作流角色) ───────────────
	//
	// v0.8 模板/角色分离(ADR-019):两个独立概念。
	//   - **能力模板**(PromptTemplate,TemplateStore 画廊):按能力/领域专长取
	//     向,用户面向。UI 画廊 + AgentRegistry.listTemplates 共看 → 对齐。
	//     Agent create with `template=<id>` 把模板身份拷进新 agent。
	//   - **工作流角色**(zero/lead/archivist,角色注册表):交付工作流的位置,
	//     与模板无关,不进画廊。fresh-db seed 的 zero、按需的 lead/archivist
	//     走 instantiateRole。

	listTemplates(): PromptTemplate[] {
		return this.requireTemplateStore().list();
	}

	getTemplate(templateId: string): PromptTemplate | undefined {
		return this.requireTemplateStore().resolve(templateId);
	}

	/**
	 * Instantiate a **capability template** as a global Agent: copies identity
	 * (systemPrompt / model / provider / thinkingLevel / toolPolicy) from the
	 * PromptTemplate gallery. This is the Agent.create + template path.
	 *
	 * `templateId` accepts either the template's uuid OR its (case-insensitive)
	 * name — see TemplateStore.resolve. systemPrompt + toolPolicy ALWAYS come
	 * from the template; `overrides` only retunes name/model/provider/...
	 *
	 * v0.8:旧的 `whitelistedRoleTags` 委派自动装配已移除(依赖失效的 role_tag
	 * 物理列,fresh DB 上是 no-op)。subagents 由用户手动配(UI / AgentRegistry
	 * update)。
	 */
	instantiateTemplate(
		templateId: string,
		overrides?: Partial<Pick<AgentRecord, "name" | "model" | "provider" | "workspaceDir" | "thinkingLevel">>,
	): AgentRecord {
		const template = this.requireTemplateStore().resolve(templateId);
		if (!template) throw new Error(`Unknown template: ${templateId}`);

		return this.agentStore.create({
			name: overrides?.name ?? template.name,
			model: overrides?.model ?? template.model,
			provider: overrides?.provider ?? template.provider,
			workspaceDir: overrides?.workspaceDir,
			thinkingLevel: overrides?.thinkingLevel ?? template.thinkingLevel,
			systemPrompt: template.systemPrompt,
			toolPolicy: template.toolPolicy as AgentRecord["toolPolicy"],
		});
	}

	/**
	 * Instantiate a **workflow role** (zero / lead / archivist) as a global
	 * Agent. Roles are NOT capability templates — they're delivery-workflow
	 * positions with no gallery equivalent, defined in the role registry
	 * (builtin-role-templates.ts). Used by fresh-db seed (zero) and on-demand
	 * workflow setup (lead / archivist).
	 */
	instantiateRole(
		roleId: string,
		overrides?: Partial<Pick<AgentRecord, "name" | "model" | "provider" | "workspaceDir" | "thinkingLevel">>,
	): AgentRecord {
		const role = BUILTIN_WORKFLOW_ROLES.find((r) => r.id === roleId);
		if (!role) throw new Error(`Unknown workflow role: ${roleId}`);

		return this.agentStore.create({
			name: overrides?.name ?? role.name,
			model: overrides?.model,
			provider: overrides?.provider,
			workspaceDir: overrides?.workspaceDir,
			thinkingLevel: overrides?.thinkingLevel,
			systemPrompt: role.systemPrompt,
			toolPolicy: role.toolPolicy,
		});
	}

	// ─── Cron (§9.4) ─────────────────────────────────────────────
	//
	// CRUD only — P4 lands the scheduler (triggerMode runs / cron_runs writes).

	createCron(input: {
		agentId: string;
		workingScope: CronRecord["workingScope"];
		schedule: CronRecord["schedule"];
		prompt?: string;
		source?: string;
		/** project-work 引用;带 workId 时 agent 在 fire 时从 work 解析,跳过 agent 校验。 */
		workId?: string;
		enabled?: boolean;
	}): CronRecord {
		const store = this.requireCronStore();
		if (!input.workId && !this.agentStore.get(input.agentId)) {
			throw new Error(`Agent not found: ${input.agentId}`);
		}
		const scope = input.workingScope;
		if (!scope || !scope.workspaceDir || !scope.wikiRootNodeId) {
			throw new Error("workingScope requires workspaceDir and wikiRootNodeId");
		}
		if (scope.projectId && !this.projectStore.get(scope.projectId)) {
			throw new Error(`Project not found: ${scope.projectId}`);
		}
		return store.create({
			agentId: input.agentId,
			workingScope: scope,
			schedule: input.schedule,
			prompt: input.prompt,
			source: input.source,
			workId: input.workId,
			enabled: input.enabled ?? true,
		});
	}

	updateCron(id: string, input: Partial<Omit<CronRecord, "id" | "createdAt" | "updatedAt" | "agentId">>): CronRecord {
		const store = this.requireCronStore();
		const existing = store.get(id);
		if (!existing) throw new Error(`Cron not found: ${id}`);
		if (input.workingScope?.projectId && !this.projectStore.get(input.workingScope.projectId)) {
			throw new Error(`Project not found: ${input.workingScope.projectId}`);
		}
		return store.update(id, input);
	}

	/** Unbind — the agent it referenced stays intact (acceptance-M1). */
	deleteCron(id: string): void {
		this.requireCronStore().delete(id);
	}

	/**
	 * List crons with optional filters. §9.4: projectId filters on
	 * workingScope.projectId; enabled filters on the enabled flag.
	 */
	listCrons(filter?: { agentId?: string; projectId?: string; enabled?: boolean }): CronRecord[] {
		const store = this.requireCronStore();
		const all = store.list();
		return all.filter((c) => {
			if (filter?.agentId && c.agentId !== filter.agentId) return false;
			if (filter?.projectId && c.workingScope.projectId !== filter.projectId) return false;
			if (filter?.enabled !== undefined && c.enabled !== filter.enabled) return false;
			return true;
		});
	}

	getCron(id: string): CronRecord | undefined {
		return this.requireCronStore().get(id);
	}

	// ── v0.8 archivist 长期绑定(阶段2) ──────────────────────────────
	// 绑定 = 该 project 的 archivist cron 集合(每操作一条,共用 agentId)。
	// 识别:prompt 匹配 WIKI_OPERATIONS 的 cron = 绑定操作 cron;custom prompt
	// 的 cron 不归入绑定(用户手动建的,无法可靠反查操作)。

	/**
	 * 绑定一个 archivist agent 到 project:对每个 operation 建一条 project-scoped
	 * cron(prompt = 操作默认 prompt)。校验 agent 配了 Wiki 工具(无 fallback)。
	 * 注:不清理旧绑定 cron —— 调用方需先 unbindProjectArchivist。
	 */
	bindProjectArchivist(projectId: string, opts: { agentId: string; operations: WikiOperationId[]; schedule: CronSchedule; gitAware?: boolean; gitEveryMs?: number }): CronRecord[] {
		const project = this.projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const agent = this.agentStore.get(opts.agentId);
		if (!agent) throw new Error(`Agent not found: ${opts.agentId}`);
		if (!agentHasWikiTool(agent)) {
			throw new Error(`Agent "${agent.name}" has the Wiki tool blocked — cannot bind. Use an agent with the Wiki tool (e.g. create one from the Archivist template).`);
		}
		const workingScope = { projectId, workspaceDir: project.workspaceDir, wikiRootNodeId: `wiki-root:${projectId}` };
		// 阶段3:gitAware 时对 doc-rebuild/git-update 额外建一条 interval cron
		// (prompt 带 sentinel,cron-analysis 触发前检查 git ref 变化才跑)。
		const crons: CronRecord[] = [];
		for (const opId of opts.operations) {
			const opPrompt = resolveOperationPrompt(opId, undefined, project.name);
			crons.push(this.createCron({ agentId: opts.agentId, workingScope, schedule: opts.schedule, prompt: opPrompt, source: `archivist-bind:${opId}`, enabled: true }));
			if (opts.gitAware && (opId === "doc-rebuild" || opId === "git-update")) {
				crons.push(this.createCron({
					agentId: opts.agentId,
					workingScope,
					schedule: { mode: "interval", everyMs: opts.gitEveryMs ?? 600000 } as CronSchedule,
					prompt: wrapGitAwarePrompt(opPrompt),
					source: `archivist-bind:${opId}`,
					enabled: true,
				}));
			}
		}
		return crons;
	}

	/** 解绑:删该 project 所有 archivist 绑定 cron(prompt 匹配 WIKI_OPERATIONS 的)。 */
	unbindProjectArchivist(projectId: string): void {
		const store = this.requireCronStore();
		for (const c of this.listCrons({ projectId })) {
			if (this.cronOperationId(c) !== null) store.delete(c.id);
		}
	}

	/** 切换管理者 agent:批量更新该 project 所有绑定 cron 的 agentId。 */
	switchProjectArchivistAgent(projectId: string, newAgentId: string): void {
		const agent = this.agentStore.get(newAgentId);
		if (!agent) throw new Error(`Agent not found: ${newAgentId}`);
		if (!agentHasWikiTool(agent)) throw new Error(`Agent "${agent.name}" has the Wiki tool blocked — cannot bind.`);
		const store = this.requireCronStore();
		for (const c of this.listCrons({ projectId })) {
			if (this.cronOperationId(c) !== null) store.update(c.id, { agentId: newAgentId } as any);
		}
	}

	/** 暂停/恢复:批量更新该 project 所有绑定 cron 的 enabled。 */
	setProjectArchivistEnabled(projectId: string, enabled: boolean): void {
		const store = this.requireCronStore();
		for (const c of this.listCrons({ projectId })) {
			if (this.cronOperationId(c) !== null) store.update(c.id, { enabled } as any);
		}
	}

	/** 聚合该 project 的 archivist 绑定视图(供 container view / 单独查询)。 */
	getProjectArchivistBinding(projectId: string): ProjectArchivistBinding {
		const crons = this.listCrons({ projectId });
		const ops: Array<{ operationId: WikiOperationId; cronId: string; schedule: CronSchedule; enabled: boolean; lastRunAt?: string; nextRunAt?: string; lastStatus?: string; agentId: string }> = [];
		for (const c of crons) {
			const opId = this.cronOperationId(c);
			if (opId === null) continue;
			ops.push({
				operationId: opId,
				cronId: c.id,
				schedule: c.schedule,
				enabled: c.enabled,
				lastRunAt: c.lastRunAt,
				nextRunAt: c.nextRunAt,
				lastStatus: c.lastStatus,
				agentId: c.agentId,
			});
		}
		const agentId = ops[0]?.agentId ?? null;
		const agentName = agentId ? (this.agentStore.get(agentId)?.name ?? null) : null;
		const gitAware = crons.some((c) => isGitAwarePrompt(c.prompt));
		return {
			projectId,
			agentId,
			agentName,
			operations: ops.map(({ agentId: _agentId, ...rest }) => rest),
			gitAware,
		};
	}

	/**
	 * 判定 cron 是否为 archivist 绑定操作,返回其 operationId。靠 cron.source
	 * (`archivist-bind:<operationId>`) —— 不再 prompt 反查(稳定,prompt 改/自定义
	 * prompt 都不影响识别)。非绑定 cron(无 source 或后缀非合法 operationId)返回 null。
	 */
	private cronOperationId(cron: CronRecord): WikiOperationId | null {
		const prefix = "archivist-bind:";
		if (!cron.source || !cron.source.startsWith(prefix)) return null;
		const opId = cron.source.slice(prefix.length) as WikiOperationId;
		return WIKI_OPERATIONS.some((o) => o.id === opId) ? opId : null;
	}

	// ── v0.8 project-work(取代工作流角色的"工位/工作"系统)──────────────
	//
	// 一个 project_work = 项目里定义的一项工作(name + actionPrompt + requiredTools
	// + agentId[可空] + contextPolicy + hooks)。触发源:cron(复用 crons 表,带
	// workId)/hook(inline)/手动。一个 work = 一个动作(扁平)。详见 ADR。

	/** 新 project 创建时 seed 默认工位(全空岗)。幂等:已有 work 不重 seed。 */
	seedDefaultProjectWorks(projectId: string): void {
		const store = this.requireProjectWorkStore();
		if (store.listByProject(projectId).length > 0) return;
		const project = this.projectStore.get(projectId);
		const projectName = project?.name ?? "";
		for (const seed of DEFAULT_PROJECT_WORKS(projectId, projectName)) {
			store.create(seed);
		}
	}

	/**
	 * One-time re-sync of default work actionPrompts to the latest template.
	 *
	 * The work prompt is stored at seed time (project creation) and used verbatim
	 * by fireProjectWork — so a template improvement (e.g. adding Agent-tool
	 * guidance to 文档充实/文档重建) does NOT reach existing projects. This
	 * refreshes default-named works whose stored prompt still looks like the OLD
	 * default: matches the old signature phrase AND lacks the new marker.
	 *
	 * Safety: prompts that don't carry the signature (user-customized) and
	 * prompts that already have the marker (already up-to-date) are NOT touched.
	 * Only actionPrompt is rewritten; agentId / hooks / requiredTools / etc. stay.
	 * Caller gates this with a one-time KV flag so it runs exactly once.
	 */
	resyncDefaultWorkPrompts(): void {
		const store = this.requireProjectWorkStore();
		// name → distinctive phrase that identifies the OLD default prompt.
		const SIGNATURES: Record<string, string> = {
			"文档充实": "骨架扫描已经建好了结构节点",
			"文档重建": "覆盖骨架扫描的启发式简摘",
		};
		// Marker the new template carries (Agent-tool guidance block). Its presence
		// means the prompt is already the latest → skip.
		const MARKER = "执行策略(递归型任务";
		for (const project of this.projectStore.list()) {
			const projectName = project.name ?? "";
			// Latest default prompts for this project (name → actionPrompt).
			const latest = new Map<string, string>();
			for (const seed of DEFAULT_PROJECT_WORKS(project.id, projectName)) {
				latest.set(seed.name, seed.actionPrompt);
			}
			for (const work of store.listByProject(project.id)) {
				const sig = SIGNATURES[work.name];
				if (!sig) continue;                         // not a default work we manage
				const prompt = work.actionPrompt ?? "";
				if (prompt.includes(MARKER)) continue;      // already up-to-date
				if (!prompt.includes(sig)) continue;        // looks customized — don't clobber
				const next = latest.get(work.name);
				if (next && next !== prompt) {
					store.update(work.id, { actionPrompt: next });
				}
			}
		}
	}

	/**
	 * project-flow F4 one-time migration: existing projects' delivery work
	 * (the seeded "需求管理" work) was hooked on `requirements.create` pre-F3
	 * — it fired the moment a requirement was created, bypassing the user
	 * confirmation step. F3/F4 move the delivery trigger to `requirements.ready`
	 * (user-confirmed). The seed template is already updated; this migrates
	 * EXISTING works still carrying the old hook event to the new one.
	 *
	 * Safety: only touches works whose hook event is EXACTLY
	 * `requirements.create` AND whose name matches the seeded delivery work
	 * ("需求管理"). User-customized works / works with non-standard hooks are
	 * left alone. Idempotent — a no-op once migrated. Caller gates this with a
	 * one-time KV flag so it runs exactly once.
	 */
	resyncDeliveryWorkHookToReady(): void {
		const store = this.requireProjectWorkStore();
		const DELIVERY_WORK_NAMES = new Set(["需求管理", "Requirement Delivery"]);
		const OLD_EVENT = "requirements.create";
		const NEW_EVENT = "requirements.ready";
		for (const project of this.projectStore.list()) {
			for (const work of store.listByProject(project.id)) {
				if (!DELIVERY_WORK_NAMES.has(work.name)) continue;
				if (!Array.isArray(work.hooks)) continue;
				// Skip if no hook uses the old event.
				if (!work.hooks.some((h) => h.event === OLD_EVENT)) continue;
				// Skip if already migrated (a hook with the new event exists).
				if (work.hooks.some((h) => h.event === NEW_EVENT)) continue;
				const nextHooks = work.hooks.map((h) =>
					h.event === OLD_EVENT ? { ...h, event: NEW_EVENT } : h,
				);
				store.update(work.id, { hooks: nextHooks } as any);
			}
		}
	}

	/**
	 * 创建一个 project-work(+ 可选 cron 触发器)。校验:agent 存在(若指定)+
	 * 满足 requiredTools(无 fallback)。runOnce=true 时创建后立刻手动触发一次。
	 */
	createProjectWork(projectId: string, body: CreateProjectWorkBody): ProjectWorkRecord {
		const project = this.projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const requiredTools = body.requiredTools ?? [];
		let agentId: string | null = body.agentId ?? null;
		if (agentId) {
			const agent = this.agentStore.get(agentId);
			if (!agent) throw new Error(`Agent not found: ${agentId}`);
			this.assertAgentMeetsTools(agent, requiredTools);
		}
		const store = this.requireProjectWorkStore();
		const work = store.create({
			projectId,
			name: body.name,
			actionPrompt: body.actionPrompt ?? "",
			requiredTools,
			agentId,
			contextPolicy: body.contextPolicy,
			hooks: body.hooks,
			enabled: body.enabled ?? true,
		});
		// cron 触发器:每条建一条带 workId 的 cron(prompt 留空,fire 时从 work 解析;
		// gitAware 变体用 sentinel 标记 cron.prompt)。
		const workingScope = { projectId, workspaceDir: project.workspaceDir, wikiRootNodeId: `wiki-root:${projectId}` };
		for (const t of body.cronTriggers ?? []) {
			this.createCron({
				agentId: agentId ?? "",
				workingScope,
				schedule: t.schedule,
				prompt: t.gitAware ? wrapGitAwarePrompt("") : undefined,
				workId: work.id,
				enabled: true,
			});
		}
		if (body.runOnce) {
			void this.requireProjectWorkRunner().fireProjectWork(work.id).catch((e) =>
				log.warn("project-work", `runOnce fire failed for ${work.id}: ${(e as Error).message}`),
			);
		}
		return work;
	}

	/** 更新 work(actionPrompt/requiredTools/hooks/enabled 等)。改 requiredTools 重校验 agent。 */
	updateProjectWork(workId: string, patch: Partial<CreateProjectWorkBody>): ProjectWorkRecord {
		const store = this.requireProjectWorkStore();
		const existing = store.get(workId);
		if (!existing) throw new Error(`project-work not found: ${workId}`);
		const nextRequired = patch.requiredTools ?? existing.requiredTools;
		const nextAgent = patch.agentId !== undefined ? patch.agentId : existing.agentId;
		if (nextAgent) {
			const agent = this.agentStore.get(nextAgent);
			if (!agent) throw new Error(`Agent not found: ${nextAgent}`);
			this.assertAgentMeetsTools(agent, nextRequired);
		}
		const updated = store.update(workId, {
			name: patch.name,
			actionPrompt: patch.actionPrompt,
			requiredTools: patch.requiredTools,
			agentId: nextAgent,
			contextPolicy: patch.contextPolicy,
			hooks: patch.hooks,
			enabled: patch.enabled,
		});
		// agent 变更 → 同步其 cron 触发器的 agentId(session 路由用)。
		if (patch.agentId !== undefined) this.syncWorkCrons(workId, { agentId: patch.agentId ?? "" });
		// cron 触发器变更 → diff 同步(保留未变 cron 的 run 历史)。
		if (patch.cronTriggers !== undefined) this.setWorkCronTriggers(workId, patch.cronTriggers);
		return updated;
	}

	/** 删除 work + 其全部 cron 触发器。 */
	deleteProjectWork(workId: string): void {
		const store = this.requireProjectWorkStore();
		const cronStore = this.cronStore;
		if (cronStore) {
			for (const c of cronStore.list()) {
				if (c.workId === workId) cronStore.delete(c.id);
			}
		}
		store.delete(workId);
	}

	/** 分配/切换 work 的 agent(校验 requiredTools)。同步 cron.agentId。 */
	assignProjectWorkAgent(workId: string, agentId: string): ProjectWorkRecord {
		const store = this.requireProjectWorkStore();
		const work = store.get(workId);
		if (!work) throw new Error(`project-work not found: ${workId}`);
		const agent = this.agentStore.get(agentId);
		if (!agent) throw new Error(`Agent not found: ${agentId}`);
		this.assertAgentMeetsTools(agent, work.requiredTools);
		const updated = store.update(workId, { agentId });
		this.syncWorkCrons(workId, { agentId });
		return updated;
	}

	/** 暂停/恢复 work + 其 cron 触发器。 */
	setProjectWorkEnabled(workId: string, enabled: boolean): ProjectWorkRecord {
		const store = this.requireProjectWorkStore();
		const updated = store.update(workId, { enabled });
		this.syncWorkCrons(workId, { enabled });
		return updated;
	}

	/** 手动触发 work 一次(走 ProjectWorkRunner)。 */
	async triggerProjectWork(workId: string): Promise<FireProjectWorkResult> {
		return this.requireProjectWorkRunner().fireProjectWork(workId);
	}

	/** 聚合 project 的全部 work 为 UI 视图(+ cron 触发器状态)。 */
	getProjectWorks(projectId: string): ProjectWorkView[] {
		const store = this.requireProjectWorkStore();
		const works = store.listByProject(projectId);
		const crons = this.listCrons({ projectId });
		return works.map((w) => {
			const workCrons = crons.filter((c) => c.workId === w.id);
			const cronTriggers = workCrons.map((c) => ({
				cronId: c.id,
				schedule: c.schedule,
				gitAware: isGitAwarePrompt(c.prompt),
				enabled: c.enabled,
				lastRunAt: c.lastRunAt,
				nextRunAt: c.nextRunAt,
				lastStatus: c.lastStatus,
			}));
			const lastRunAt = workCrons
				.map((c) => c.lastRunAt ?? "")
				.filter(Boolean)
				.sort()
				.pop();
			return {
				id: w.id,
				projectId: w.projectId,
				name: w.name,
				actionPrompt: w.actionPrompt,
				requiredTools: w.requiredTools,
				agentId: w.agentId,
				agentName: w.agentId ? (this.agentStore.get(w.agentId)?.name ?? null) : null,
				contextPolicy: w.contextPolicy,
				hooks: w.hooks,
				enabled: w.enabled,
				cronTriggers,
				hasHookTrigger: Array.isArray(w.hooks) && w.hooks.some((h) => h.enabled),
				lastRunAt,
			};
		});
	}

	/** 校验 agent 满足 tools 任一不满足 throw(供前端 catch 提醒)。 */
	private assertAgentMeetsTools(agent: AgentRecord, tools: string[]): void {
		for (const t of tools) {
			if (!agentHasTool(agent, t)) {
				throw new Error(`Agent "${agent.name}" 缺少必需工具 ${t}(被 blocked) — 无法分配到该工位。请改用配置了 ${t} 工具的 agent。`);
			}
		}
	}

	/** 把 work 的 cron 触发器的 agentId/enabled 同步成 work 当前值。 */
	private syncWorkCrons(workId: string, patch: { agentId?: string; enabled?: boolean }): void {
		if (!this.cronStore) return;
		for (const c of this.cronStore.list()) {
			if (c.workId !== workId) continue;
			this.cronStore.update(c.id, patch as any);
		}
	}

	/**
		 * 全量设定 work 的 cron 触发器列表。按 {schedule, gitAware} 签名 diff:
		 * 未变的 cron 保留(含 run 历史),多余的删除,新增的创建(带 workId)。
		 * 每次保存都送全量列表也安全 —— diff 让"只改 prompt"不丢 cron 历史。
		 */
	private setWorkCronTriggers(workId: string, triggers: Array<{ schedule: CronSchedule; gitAware?: boolean }>): void {
		if (!this.cronStore) return;
		const store = this.requireProjectWorkStore();
		const work = store.get(workId);
		if (!work) throw new Error(`project-work not found: ${workId}`);
		const project = this.projectStore.get(work.projectId);
		if (!project) throw new Error(`Project not found: ${work.projectId}`);
		const workingScope = { projectId: project.id, workspaceDir: project.workspaceDir, wikiRootNodeId: `wiki-root:${project.id}` };
		const sig = (t: { schedule: CronSchedule; gitAware?: boolean }) =>
			JSON.stringify({ schedule: t.schedule, gitAware: !!t.gitAware });
		const existing = this.cronStore.list().filter((c) => c.workId === workId);
		const existingSigs = new Set(existing.map((c) => sig({ schedule: c.schedule, gitAware: isGitAwarePrompt(c.prompt) })));
		const newSigs = new Set(triggers.map(sig));
		// 删除:旧有但新列表没有
		for (const c of existing) {
			if (!newSigs.has(sig({ schedule: c.schedule, gitAware: isGitAwarePrompt(c.prompt) }))) {
				this.cronStore.delete(c.id);
			}
		}
		// 新增:新列表有但旧没有
		for (const t of triggers) {
			if (!existingSigs.has(sig(t))) {
				this.createCron({
					agentId: work.agentId ?? "",
					workingScope,
					schedule: t.schedule,
					prompt: t.gitAware ? wrapGitAwarePrompt("") : undefined,
					workId,
					enabled: true,
				});
			}
		}
	}

	/**
	 * v0.8 (P4): the P3 manual-trigger stub is obsolete — the real run path is
	 * CronAnalysisManager.triggerCron (writes cron_runs, leaves next_run
	 * untouched per §9.4). ManagementService no longer owns a trigger entry;
	 * callers (REST router / action tool) go straight to the cron manager.
	 * Kept here only for the action-tool capability backend signature; it just
	 * resolves the cron and surfaces it so the tool layer can decide.
	 */
	triggerCron(id: string): { cron: CronRecord } {
		const store = this.requireCronStore();
		const cron = store.get(id);
		if (!cron) throw new Error(`Cron not found: ${id}`);
		return { cron };
	}

	// ─── Internal: policy binding helpers ────────────────────────
	//
	// These are retained for template instantiation + the legacy REST preset
	// router (parallel entry). Runtime tools no longer call them directly
	// (Agent update consolidates toolPolicy mutations).

	/**
	 * Merge toolPolicy fields onto an agent. Retained for role-template-router
	 * and tests; the runtime path is Agent.update with a `toolPolicy` patch.
	 */
	mergeToolPolicy(agentId: string, patch: NonNullable<AgentRecord["toolPolicy"]>): AgentRecord {
		const agent = this.agentStore.get(agentId);
		if (!agent) throw new Error(`Agent not found: ${agentId}`);
		const merged = {
			...(agent.toolPolicy ?? {}),
			...patch,
			tools: { ...(agent.toolPolicy?.tools ?? {}), ...(patch.tools ?? {}) },
		};
		return this.agentStore.update(agentId, { toolPolicy: merged });
	}
}
