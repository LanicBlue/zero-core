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
import type { ProjectStore } from "./project-store.js";
import type { CronStore } from "./cron-store.js";
import type { RequirementStore } from "./requirement-store.js";
import type { SessionDB } from "./session-db.js";
import type { WikiStore } from "./wiki-node-store.js";
import type { ArchivistService } from "./archivist-service.js";
import type {
	AgentRecord,
	ProjectRecord,
	CronRecord,
	ProjectContainerView,
	ProjectResourceUsage,
	RequirementRecord,
	RequirementStatus,
	PromptTemplate,
} from "../shared/types.js";
import type { TemplateStore } from "./template-store.js";
import { BUILTIN_WORKFLOW_ROLES } from "./builtin-role-templates.js";
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
	archivistService?: ArchivistService;
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
	private archivistService: ArchivistService | null;

	constructor(deps: ManagementDeps) {
		this.agentStore = deps.agentStore;
		this.projectStore = deps.projectStore;
		this.templateStore = deps.templateStore ?? null;
		this.cronStore = deps.cronStore ?? null;
		this.requirementStore = deps.requirementStore ?? null;
		this.sessionDB = deps.sessionDB ?? null;
		this.wikiStore = deps.wikiStore ?? null;
		this.archivistService = deps.archivistService ?? null;
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
	setWikiStore(wiki: WikiStore): void { this.wikiStore = wiki; }
	setArchivistService(svc: ArchivistService): void { this.archivistService = svc; }

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
	createProject(input: { name: string; workspaceDir: string }): ProjectRecord {
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
				.scanProject(project.id)
				.then((r) => {
					if (r.notes && r.notes.length > 0) {
						log.debug("management", `archivist scan ${project.id}: ${r.notes.join("; ")}`);
					}
				})
				.catch((err) => {
					log.warn("management", `archivist background scan failed for ${project.id}:`, (err as Error).message);
				});
		}
		return project;
	}

	updateProject(id: string, input: Partial<Omit<ProjectRecord, "id" | "createdAt">>): ProjectRecord {
		return this.projectStore.update(id, input);
	}

	deleteProject(id: string): void {
		this.projectStore.delete(id);
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
				});
			}
		}

		return {
			project,
			requirementsByStatus,
			crons,
			wikiSummary: { nodeCount, lastUpdated, scanPhase, scanProgress },
			activeSessions,
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
			 WHERE context_project_id = ?`,
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
		return this.agentStore.create(input);
	}

	updateAgent(id: string, input: Partial<Omit<AgentRecord, "id" | "createdAt">>): AgentRecord {
		// toolPolicy is a nested config you toggle per-tool, so a partial update
		// (e.g. disable one tool) must MERGE — otherwise passing {tools:{WebSearch:
		// {enabled:false}}} wipes every other tool. Other fields are scalar/arrays
		// and stay replace. See mergeToolPolicy for the same merge logic.
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
				return this.agentStore.update(id, { ...rest, toolPolicy: merged });
			}
		}
		return this.agentStore.update(id, input);
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
		enabled?: boolean;
	}): CronRecord {
		const store = this.requireCronStore();
		if (!this.agentStore.get(input.agentId)) {
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
