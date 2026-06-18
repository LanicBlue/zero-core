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
// ## 删除的能力 (v0.8 P3 / §7.7)
//   - `InstantiatePreset`            —— 由 Agent create + template 替代
//   - `SetToolPolicy`/`SetToolEnabled`—— 并入 Agent update
//   - `ExposeAgentAsTool`/`UnexposeAgentAsTool`(P2 已废)
//   - 本服务对应的 exposeAgentAsTool / unexposeAgentAsTool / setToolPolicy /
//     setToolEnabled / instantiatePreset 方法保留为 internal,只给 preset
//     REST 路由(并行入口)和 template create 用;runtime 工具不再消费。
//
// ## 输入
// - AgentStore / ProjectStore / AgentToolStore / CronStore
//
// ## 输出
// - ManagementService 实例,被 management tools (runtime/tools) 使用
//
// ## 定位
// 服务层,被 server/index.ts 实例化并注入到 zero session 的 SessionConfig.management。
//
// ## 维护规则
// - 不持久化任何状态(纯封装 stores)
// - template create 时同步接好 toolPolicy 的 agent-tool 引用(按 entry.id keyed)
// - delete zero agent / delete referenced agent 拒绝
//

import type { AgentStore } from "./agent-store.js";
import type { ProjectStore } from "./project-store.js";
import type { AgentToolStore } from "./agent-tool-store.js";
import type { CronStore } from "./cron-store.js";
import type { AgentRecord, ProjectRecord, CronRecord } from "../shared/types.js";
import {
	buildAgentFromPreset,
	getPreset,
	listPresets,
	type RolePreset,
} from "../runtime/role-presets.js";
import { log } from "../core/logger.js";

export interface ManagementDeps {
	agentStore: AgentStore;
	projectStore: ProjectStore;
	agentToolStore: AgentToolStore;
	/** v0.8 M1: cron store — optional so M0 callers (and tests) still work. */
	cronStore?: CronStore;
}

/**
 * v0.8 P3: ManagementService (renamed from ZeroAdminService).
 *
 * Capability backend for the domain tools (Project / Agent / Cron / Wiki).
 * The capability lives in the tools; agents are just tool-config bundles.
 */
export class ManagementService {
	private agentStore: AgentStore;
	private projectStore: ProjectStore;
	private agentToolStore: AgentToolStore;
	private cronStore: CronStore | null;

	constructor(deps: ManagementDeps) {
		this.agentStore = deps.agentStore;
		this.projectStore = deps.projectStore;
		this.agentToolStore = deps.agentToolStore;
		this.cronStore = deps.cronStore ?? null;
	}

	/** v0.8 M1: late-bind the cron store. */
	setCronStore(cronStore: CronStore): void {
		this.cronStore = cronStore;
	}

	private requireCronStore(): CronStore {
		if (!this.cronStore) throw new Error("CronStore not wired into ManagementService");
		return this.cronStore;
	}

	// ─── Projects (§8.2) ──────────────────────────────────────────

	createProject(input: { name: string; workspaceDir: string }): ProjectRecord {
		return this.projectStore.create(input);
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

	// ─── Agents (§7.3) ────────────────────────────────────────────

	createAgent(input: Omit<AgentRecord, "id" | "createdAt" | "updatedAt">): AgentRecord {
		return this.agentStore.create(input);
	}

	updateAgent(id: string, input: Partial<Omit<AgentRecord, "id" | "createdAt">>): AgentRecord {
		return this.agentStore.update(id, input);
	}

	/**
	 * Delete an Agent. Refuses to delete the protected "zero" role agent
	 * (the platform-management agent — deleting it would orphan the only
	 * session that can manage the platform).
	 *
	 * Cascade-cleans agent-tool entries that referenced this agent and any
	 * cron entries bound to it.
	 */
	deleteAgent(id: string): void {
		const agent = this.agentStore.get(id);
		if (!agent) throw new Error(`Agent not found: ${id}`);
		// v0.8 P3 §7.3: zero agent is protected. Identity in v0.8 is name +
		// systemPrompt; the legacy role_tag column still carries "zero" — we
		// read it via @ts-expect-error pending the P7 roleTag purge.
		// @ts-expect-error — P0 §1.4: legacy roleTag field; P7 cleanup.
		if (agent.roleTag === "zero" || agent.name === "zero") {
			throw new Error("Cannot delete the protected 'zero' management agent");
		}
		this.agentToolStore.deleteByAgentId(id);
		this.cronStore?.deleteByAgent(id);
		this.agentStore.delete(id);
	}

	listAgents(roleTag?: string): AgentRecord[] {
		return roleTag ? this.agentStore.listByRoleTag(roleTag) : this.agentStore.list();
	}

	getAgent(id: string): AgentRecord | undefined {
		return this.agentStore.get(id);
	}

	// ─── Templates (§7.3) ────────────────────────────────────────
	//
	// Templates = role presets (role-presets.ts). Agent create with
	// `template=<presetId>` copies the preset's identity (systemPrompt /
	// model / toolPolicy) into the new agent. listTemplates / getTemplate
	// are read-only views so the LLM (and UI) can enumerate them.

	listTemplates(roleTag?: string): RolePreset[] {
		return listPresets(roleTag);
	}

	getTemplate(templateId: string): RolePreset | undefined {
		return getPreset(templateId);
	}

	/**
	 * Instantiate a role template as a global Agent. Resolves the preset's
	 * `whitelistedRoleTags` against currently-exposed agent-tools and merges
	 * them into `toolPolicy.tools` keyed by entry.id (stable policy key).
	 *
	 * This is the Agent.create + template path. Also used by the REST
	 * /api/presets/:id/instantiate entry (parallel to the Agent tool).
	 */
	instantiateTemplate(
		templateId: string,
		overrides?: Parameters<typeof buildAgentFromPreset>[1],
		options: { bindToolPolicy?: boolean } = {},
	): AgentRecord {
		const preset = getPreset(templateId);
		if (!preset) throw new Error(`Unknown role template: ${templateId}`);

		const baseInput = buildAgentFromPreset(templateId, overrides);
		const bindToolPolicy = options.bindToolPolicy ?? true;

		if (bindToolPolicy && preset.whitelistedRoleTags && preset.whitelistedRoleTags.length > 0) {
			const tools = { ...(baseInput.toolPolicy?.tools ?? {}) };
			for (const roleTag of preset.whitelistedRoleTags) {
				const targetAgent = this.ensureRoleAgentExposed(roleTag);
				if (targetAgent) {
					tools[targetAgent.entry.id] = { enabled: true };
				} else {
					log.warn(
						"management",
						`No agent found for whitelisted roleTag "${roleTag}" during template "${templateId}" instantiation; skipping.`,
					);
				}
			}
			baseInput.toolPolicy = { ...(baseInput.toolPolicy as any), tools };
		}

		return this.agentStore.create(baseInput);
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

	listCrons(filter?: { agentId?: string }): CronRecord[] {
		const store = this.requireCronStore();
		if (filter?.agentId) return store.listByAgent(filter.agentId);
		return store.list();
	}

	getCron(id: string): CronRecord | undefined {
		return this.requireCronStore().get(id);
	}

	/**
	 * Trigger a cron immediately (manual fire). P3 only wires the entry-point;
	 * the actual scheduling run + cron_runs write lands in P4. Returns the
	 * cron row + a marker so the caller knows the trigger was accepted.
	 */
	triggerCron(id: string): { accepted: boolean; cron: CronRecord; scheduledBy: "P4" } {
		const store = this.requireCronStore();
		const cron = store.get(id);
		if (!cron) throw new Error(`Cron not found: ${id}`);
		// P3 stub: actual scheduler dispatch is P4. We surface the intent so
		// the tool layer is wired; the cron-analysis manager (P4) will be
		// extended to accept this manual-trigger signal.
		log.warn("management", `Cron trigger requested for ${id} (P3 stub — P4 scheduler will run it)`);
		return { accepted: true, cron, scheduledBy: "P4" };
	}

	// ─── Internal: policy binding helpers ────────────────────────
	//
	// These are retained for template instantiation + the legacy REST preset
	// router (parallel entry). Runtime tools no longer call them directly
	// (Agent update consolidates toolPolicy mutations).

	/**
	 * Merge toolPolicy fields onto an agent. Retained for preset-router and
	 * tests; the runtime path is Agent.update with a `toolPolicy` patch.
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

	/**
	 * Ensure some agent with the given roleTag is exposed as an internal
	 * agent-tool, returning its { agentId, entry } so callers can wire policy
	 * by entry.id. Used by template instantiation (legacy compat).
	 */
	private ensureRoleAgentExposed(
		roleTag: string,
	): { agentId: string; entry: import("../shared/types.js").AgentToolEntry } | undefined {
		const agents = this.agentStore.listByRoleTag(roleTag);
		if (agents.length === 0) return undefined;

		for (const a of agents) {
			const entry = this.agentToolStore.list().find(
				(e) => e.type === "internal" && e.agentId === a.id && e.enabled,
			);
			if (entry) return { agentId: a.id, entry };
		}

		const first = agents[0];
		const entry = this.exposeAgentAsTool(first.id, { enabled: true });
		return { agentId: first.id, entry };
	}

	/**
	 * Expose an agent as an internal agent-tool. Retained for template/preset
	 * instantiation and the REST preset router; runtime tools do not call this
	 * (agent-as-tool retired in P2 — delegation flows through AgentRecord.subagents).
	 */
	exposeAgentAsTool(
		agentId: string,
		opts: { name?: string; description?: string; enabled?: boolean; blocking?: boolean } = {},
	): import("../shared/types.js").AgentToolEntry {
		const agent = this.agentStore.get(agentId);
		if (!agent) throw new Error(`Agent not found: ${agentId}`);

		const existing = this.agentToolStore.list().find(
			(e) => e.type === "internal" && e.agentId === agentId,
		);
		const name = opts.name ?? kebab(agent.name);

		if (existing) {
			return this.agentToolStore.update(existing.id, {
				name,
				description: opts.description,
				enabled: opts.enabled ?? true,
				blocking: opts.blocking,
			});
		}

		return this.agentToolStore.create({
			name,
			description: opts.description,
			type: "internal",
			enabled: opts.enabled ?? true,
			agentId,
			blocking: opts.blocking ?? true,
		});
	}
}

function kebab(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
