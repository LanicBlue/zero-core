// Zero 全局管理服务 (v0.8 M0)
//
// # 文件说明书
//
// ## 核心功能
// 封装 ProjectStore / AgentStore / AgentToolStore,给 zero 全局管理角色提供
// 对话式搭建 workflow 的能力 (RFC §2.14 / 决策 24):
//   - create / update / delete project
//   - create / update / delete agent (含实例化预设)
//   - set toolPolicy
//   - expose-as-tool
//   - 把 caller 角色预设声明的 whitelistedRoleTags 解析为 agent-tool entry id,
//     合入 toolPolicy.tools (按 entry.id keyed, 决策 2)
//
// cron 管理工具留 M1,本服务不暴露 cron 接口。
//
// ## 输入
// - AgentStore / ProjectStore / AgentToolStore
//
// ## 输出
// - ZeroAdminService 实例,被 zero-admin-tools (runtime/tools) 使用
//
// ## 定位
// 服务层,被 server/index.ts 实例化并注入到 zero session 的 SessionConfig.zeroAdmin。
//
// ## 依赖
// - ./agent-store、./project-store、./agent-tool-store
// - ../runtime/role-presets
// - ../shared/types
//
// ## 维护规则
// - 不持久化任何状态(纯封装 stores)
// - 实例化预设时同步接好 toolPolicy 的 agent-tool 引用 (按 entry.id keyed)
//

import type { AgentStore } from "./agent-store.js";
import type { ProjectStore } from "./project-store.js";
import type { AgentToolStore } from "./agent-tool-store.js";
import type { AgentRecord, ProjectRecord } from "../shared/types.js";
import { buildAgentFromPreset, getPreset, type RolePreset } from "../runtime/role-presets.js";
import { log } from "../core/logger.js";

export interface ZeroAdminDeps {
	agentStore: AgentStore;
	projectStore: ProjectStore;
	agentToolStore: AgentToolStore;
}

export class ZeroAdminService {
	private agentStore: AgentStore;
	private projectStore: ProjectStore;
	private agentToolStore: AgentToolStore;

	constructor(deps: ZeroAdminDeps) {
		this.agentStore = deps.agentStore;
		this.projectStore = deps.projectStore;
		this.agentToolStore = deps.agentToolStore;
	}

	// ─── Projects ───────────────────────────────────────────────

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

	// ─── Agents ─────────────────────────────────────────────────

	createAgent(input: Omit<AgentRecord, "id" | "createdAt" | "updatedAt">): AgentRecord {
		return this.agentStore.create(input);
	}

	updateAgent(id: string, input: Partial<Omit<AgentRecord, "id" | "createdAt">>): AgentRecord {
		return this.agentStore.update(id, input);
	}

	deleteAgent(id: string): void {
		// Cascade-clean agent-tool entries that referenced this agent.
		this.agentToolStore.deleteByAgentId(id);
		this.agentStore.delete(id);
	}

	listAgents(roleTag?: string): AgentRecord[] {
		return roleTag ? this.agentStore.listByRoleTag(roleTag) : this.agentStore.list();
	}

	getAgent(id: string): AgentRecord | undefined {
		return this.agentStore.get(id);
	}

	/**
	 * Instantiate a role preset as a global AgentRecord. Resolves the preset's
	 * `whitelistedRoleTags` against currently-exposed agent-tools of those
	 * roles and merges them into `toolPolicy.tools` keyed by entry.id (stable
	 * policy key — decision 2).
	 *
	 * @param presetId role preset id (see role-presets.ts)
	 * @param overrides optional name / model / workspaceDir / etc.
	 * @param options.bindToolPolicy when true (default), resolve
	 *        whitelistedRoleTags → entry ids and add them as enabled agent-tools.
	 */
	instantiatePreset(
		presetId: string,
		overrides?: Parameters<typeof buildAgentFromPreset>[1],
		options: { bindToolPolicy?: boolean } = {},
	): AgentRecord {
		const preset = getPreset(presetId);
		if (!preset) throw new Error(`Unknown role preset: ${presetId}`);

		const baseInput = buildAgentFromPreset(presetId, overrides);
		const bindToolPolicy = options.bindToolPolicy ?? true;

		if (bindToolPolicy && preset.whitelistedRoleTags && preset.whitelistedRoleTags.length > 0) {
			// Find or create agent-tool entries for one agent per whitelisted
			// roleTag, then merge their entry.id into toolPolicy.tools.
			const tools = { ...(baseInput.toolPolicy?.tools ?? {}) };
			for (const roleTag of preset.whitelistedRoleTags) {
				const targetAgent = this.ensureRoleAgentExposed(roleTag);
				if (targetAgent) {
					// Keyed by entry.id (decision 2): rename-safe.
					tools[targetAgent.entry.id] = { enabled: true };
				} else {
					log.warn("zero-admin", `No agent found for whitelisted roleTag "${roleTag}" during preset "${presetId}" instantiation; skipping.`);
				}
			}
			baseInput.toolPolicy = { ...(baseInput.toolPolicy as any), tools };
		}

		return this.agentStore.create(baseInput);
	}

	// ─── toolPolicy ─────────────────────────────────────────────

	/**
	 * Set (merge) toolPolicy fields on an agent. Existing fields not in `patch`
	 * are preserved.
	 */
	setToolPolicy(agentId: string, patch: NonNullable<AgentRecord["toolPolicy"]>): AgentRecord {
		const agent = this.agentStore.get(agentId);
		if (!agent) throw new Error(`Agent not found: ${agentId}`);
		const merged = {
			...(agent.toolPolicy ?? {}),
			...patch,
			// tools merge is per-key (caller can enable/disable individual tools)
			tools: { ...(agent.toolPolicy?.tools ?? {}), ...(patch.tools ?? {}) },
		};
		return this.agentStore.update(agentId, { toolPolicy: merged });
	}

	/** Enable/disable a single tool on an agent by policy key. */
	setToolEnabled(agentId: string, key: string, enabled: boolean): AgentRecord {
		const agent = this.agentStore.get(agentId);
		if (!agent) throw new Error(`Agent not found: ${agentId}`);
		const tools = { ...((agent.toolPolicy?.tools) ?? {}) };
		tools[key] = { enabled };
		return this.agentStore.update(agentId, {
			toolPolicy: { ...(agent.toolPolicy ?? {}), tools },
		});
	}

	// ─── expose-as-tool ─────────────────────────────────────────

	/**
	 * Expose an agent as an internal agent-tool (creates an AgentToolEntry).
	 * Returns the entry. Idempotent: if one already exists, updates enabled.
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

	/** Un-expose an agent (deletes its internal AgentToolEntry). */
	unexposeAgentAsTool(agentId: string): void {
		this.agentToolStore.deleteByAgentId(agentId);
	}

	// ─── Presets (read-only listing) ────────────────────────────

	listPresets(roleTag?: string): RolePreset[] {
		// Re-import to avoid circular deps at module load
		const { listPresets } = require("../runtime/role-presets.js");
		return listPresets(roleTag);
	}

	// ─── Private ────────────────────────────────────────────────

	/**
	 * Ensure that some agent with the given roleTag is exposed as a tool,
	 * returning its { agentId, entry } so callers can wire policy by entry.id.
	 * Returns the FIRST exposed agent of that roleTag; if none exposed yet,
	 * picks the first agent of that roleTag and exposes it. If no agent of
	 * that roleTag exists, returns undefined (caller decides how to handle).
	 */
	private ensureRoleAgentExposed(
		roleTag: string,
	): { agentId: string; entry: import("../shared/types.js").AgentToolEntry } | undefined {
		const agents = this.agentStore.listByRoleTag(roleTag);
		if (agents.length === 0) return undefined;

		// Prefer one already exposed
		for (const a of agents) {
			const entry = this.agentToolStore.list().find(
				(e) => e.type === "internal" && e.agentId === a.id && e.enabled,
			);
			if (entry) return { agentId: a.id, entry };
		}

		// Otherwise expose the first one
		const first = agents[0];
		const entry = this.exposeAgentAsTool(first.id, { enabled: true });
		return { agentId: first.id, entry };
	}
}

function kebab(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
