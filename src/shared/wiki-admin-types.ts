// Wiki 管理面 REST 类型(wiki-system-redesign plan-07 §1–§7)
//
// # 文件说明书
//
// ## 核心功能
// 定义 `/api/wiki-admin/*` 路由的 request/result shapes。与数据面
// (wiki-types.ts) **类型独立** —— 管理面不接受 nodeId / 内部 ID,
// 所有寻址用 canonical path 或逻辑地址。
//
// ## 关键不变量(plan-07 §1 / acceptance-07 §A)
//   - **authority 不在 body**:CallerCtx / grants / agentId / admin 等
//     字段一律由 server host 注入(wiki-admin-router 的 FORBIDDEN_BODY_KEYS
//     拒伪造);body schema 不暴露这些字段。
//   - **validate/preview 无副作用**:同 body 多次调用结果一致,不写 DB /
//     audit / revision。
//   - **publish 用 expected policy revision**:客户端从上次 publish 读
//     revision,本次 publish 携带;server 端比较当前 Agent.wikiPolicyRevision,
//     不一致返 WRITE_CONFLICT。
//   - **mutation 后写管理审计 + revision +1**:见 §6。
//
// ## 不做
//   - 不把管理面类型与数据面合并:wiki-types 仅供 WikiService / Wiki tool
//     / wiki-browser 使用,本文件仅供 admin router + AdminSection UI。
//   - 不暴露内部 DB 整数 ID(target_id / project_node_id)。
//
// 参见:
//   - docs/plan/wiki-system-redesign/plan-07-management-ui.md §1
//   - src/server/wiki-admin-router.ts

import type { WikiGrant, WikiContextEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Authority —— 完全由 server 注入,不在任何 request body 出现
// ---------------------------------------------------------------------------

/**
 * 管理面 authority。**只在 server host 内构造**(wiki-admin-router 模块级
 * 常量 `WIKI_ADMIN_AUTHORITY`),renderer 永远拿不到、不能扩权。
 *
 * 管理员是「管理 Wiki 配置」的权限,不是「Wiki 数据全树写」。数据面操作
 * (create/update/delete wiki nodes)仍然走 wiki-router.ts 的 `WIKI_UI_ADMIN_
 * ACCESS`;admin authority 仅授权**管理面 action**(register address /
 * bind repo / publish grants/policy)。
 */
export interface WikiAdminAuthority {
	/** 管理 actor 标识(进 audit log 的 actor_agent_id 字段)。 */
	actor: string;
	/** 是否允许写管理面配置(register/update/delete/publish)。 */
	canManage: boolean;
}

// ---------------------------------------------------------------------------
// Common envelopes
// ---------------------------------------------------------------------------

export type WikiAdminResult<T> =
	| { ok: true; result: T }
	| {
		ok: false;
		error: {
			code: string;
			message: string;
			/** 当前 server-side policy revision(WRITE_CONFLICT 时返回)。 */
			currentRevision?: number;
			/** 受影响节点 / 地址(便于 UI 标注)。 */
			address?: string | null;
		};
	};

// ---------------------------------------------------------------------------
// §2 — Addresses
// ---------------------------------------------------------------------------

/** 动态 resolver 闭集(plan-02 §2)。null = 静态 alias。 */
export const ADMIN_ADDRESS_RESOLVERS = [
	"current_agent_memory_root",
	"current_project_root",
] as const;
export type AdminAddressResolver = (typeof ADMIN_ADDRESS_RESOLVERS)[number];

/** scope 合法闭集(同 plan-02 §2)。 */
export const ADMIN_ADDRESS_SCOPES = ["runtime", "static", "alias", "managed"] as const;
export type AdminAddressScope = (typeof ADMIN_ADDRESS_SCOPES)[number];

/** 管理面 address 视图(无 target_id 内部 ID)。 */
export interface WikiAdminAddressView {
	address: string;
	scope: AdminAddressScope;
	kind: string;
	resolver: AdminAddressResolver | null;
	/** 当前 target canonical path(target_id → node.path 实时解析)。 */
	targetCanonicalPath: string | null;
	/** target 节点已归档 / 缺失。 */
	targetArchived: boolean;
	targetMissing: boolean;
	promptPolicy: string | null;
	revision: number;
	createdAt: string;
	updatedAt: string;
}

export interface AddressListResult {
	addresses: WikiAdminAddressView[];
}
export interface AddressUpsertInput {
	address: string;
	scope: AdminAddressScope;
	kind: string;
	resolver?: AdminAddressResolver | null;
	/** 目标 canonical path;管理面只用 path,不接 target_id。 */
	targetPath?: string | null;
	promptPolicy?: string | null;
}
export interface AddressValidateInput extends AddressUpsertInput {}
export interface AddressValidateResult {
	ok: boolean;
	code?: string;
	message?: string;
	resolvedTargetPath?: string | null;
}
export interface AddressImpactInput {
	/** 注册类 impact:输入拟新增的 address(若已存在则模拟 update)。 */
	address: string;
	targetPath?: string | null;
	resolver?: AdminAddressResolver | null;
}
export interface AddressImpactResult {
	affectedAgents: Array<{
		agentId: string;
		agentName: string;
		via: "wikiGrants" | "wikiContext";
		entries: Array<{ scope: string; address: string }>;
	}>;
	affectedSessions: Array<{
		sessionId: string;
		agentId: string;
		needsRefresh: boolean;
	}>;
	/** 拟变更后 vs 当前 scope 大小估计(粗略 children 数差)。 */
	scopeDeltaHint: "expand" | "shrink" | "same" | "unknown";
}

// ---------------------------------------------------------------------------
// §5 — Repositories
// ---------------------------------------------------------------------------

export interface WikiAdminRepositoryView {
	projectId: string;
	projectName: string;
	repositoryId: string;
	/** project root canonical path(`wiki-root/projects/<projectId>`)。 */
	projectNodePath: string;
	/** workspaceDir 来自 ProjectStore —— **只读展示,不入 Wiki DB**(§E1/H)。 */
	workspaceDir: string;
	/** source_root(仓库相对,不入绝对路径)。 */
	sourceRoot: string;
	defaultBranch: string;
	/** Git HEAD(实时解析,可能等于 indexedRevision)。 */
	headRevision: string | null;
	indexedRevision: string | null;
	syncStatus: "pending" | "indexing" | "synced" | "stale" | "failed";
	lastError: string | null;
	lastIndexedAt: string | null;
}
export interface RepositoryListResult {
	repositories: WikiAdminRepositoryView[];
}
export interface RepositoryBindInput {
	projectId: string;
	sourceRoot?: string;
	defaultBranch?: string;
}
export interface RepositoryUpdateInput {
	sourceRoot?: string;
	defaultBranch?: string;
}
export interface RepositoryValidateInput {
	projectId: string;
	sourceRoot?: string;
}
export interface RepositoryValidateResult {
	ok: boolean;
	code?: string;
	message?: string;
	workspaceDir?: string;
	defaultBranch?: string;
	headRevision?: string | null;
}
export interface RepositoryReindexInput {
	projectId: string;
	/** 强制 full reindex(rebuild);默认 false(走增量 sync)。 */
	full?: boolean;
	targetRevision?: string;
}
export interface RepositoryReindexResult {
	projectId: string;
	repositoryId: string;
	ok: boolean;
	indexedRevision: string | null;
	error?: string;
	syncStatus: string;
}
export interface RepositoryStatusResult extends WikiAdminRepositoryView {}

// ---------------------------------------------------------------------------
// §3 — Grants
// ---------------------------------------------------------------------------

export interface GrantsValidateInput {
	agentId: string;
	grants: WikiGrant[];
	/** 可选 active project(preview/validate 时用)。 */
	activeProjectId?: string;
}
export interface GrantsValidateResult {
	ok: boolean;
	/** canonicalScope → actions 并集(去重 / merge)。 */
	mergedGrants: Array<{ canonicalScope: string; actions: string[] }>;
	warnings: string[];
	/** 检测到的重复 / 重叠 grant(同 canonicalScope 多行)。 */
	overlaps: Array<{ canonicalScope: string; count: number }>;
	/** wiki-root 全树 grant(plan-07 §3 二次确认触发器)。 */
	hasRootWriteGrant: boolean;
}
export interface GrantsPreviewInput extends GrantsValidateInput {
	/** preview 时给 compiler 用,不影响 AgentRecord。 */
}
export interface GrantsPreviewResult {
	/** CompiledWikiAccess(同 runtime)。 */
	access: {
		agentId: string;
		activeProjectId?: string;
		grants: Array<{ canonicalScope: string; actions: string[] }>;
		policyRevision: number;
	};
	warnings: string[];
	mergedGrants: Array<{ canonicalScope: string; actions: string[] }>;
	/** 检测到的重复 / 重叠 grant(同 canonicalScope 多行;§3 C5)。 */
	overlaps: Array<{ canonicalScope: string; count: number }>;
	hasRootWriteGrant: boolean;
}
export interface GrantsPublishInput {
	agentId: string;
	grants: WikiGrant[];
	/**
	 * 客户端从上次 publish 或 agent record 读到的 wikiPolicyRevision。
	 * server 比较当前 AgentRecord.wikiPolicyRevision,不一致 → WRITE_CONFLICT。
	 */
	expectedRevision: number;
	/** wiki-root 全树 grant 的二次确认 flag(§3 C4)。 */
	confirmRootWriteGrant?: boolean;
}
export interface GrantsPublishResult {
	agentId: string;
	newRevision: number;
	affectedSessions: Array<{ sessionId: string; applied: boolean }>;
}

// ---------------------------------------------------------------------------
// §4 — Context
// ---------------------------------------------------------------------------

export interface ContextValidateInput {
	agentId: string;
	entries: WikiContextEntry[];
	grants?: WikiGrant[];
	activeProjectId?: string;
}
export interface ContextValidateResult {
	ok: boolean;
	warnings: string[];
	/** 缺 read grant 的 entry address(§4 D3 阻止 publish)。 */
	unauthorizedAddresses: string[];
	/** 同 AgentRecord.wikiGrants 中已有的 grants(用于 cross-check)。 */
	coveredAddresses: string[];
}
export interface ContextPreviewInput extends ContextValidateInput {}
export interface ContextPreviewResult {
	text: string;
	stats: {
		memoryNodesTotal: number;
		memoryNodesIncluded: number;
		memoryNodesDropped: number;
		projectNodesTotal: number;
		projectNodesIncluded: number;
		projectNodesDropped: number;
		memoryTokensUsed: number;
		projectTokensUsed: number;
		truncated: boolean;
	};
	snapshot: {
		memoryRevision: number | null;
		projectRevision: number | null;
		policyRevision: number;
	};
	warnings: string[];
	unauthorizedAddresses: string[];
}
export interface ContextPublishInput {
	agentId: string;
	entries: WikiContextEntry[];
	expectedRevision: number;
}
export interface ContextPublishResult {
	agentId: string;
	newRevision: number;
	affectedSessions: Array<{ sessionId: string; applied: boolean }>;
}

// ---------------------------------------------------------------------------
// §6 — Session publish status(用于 UI 显示哪些 session 已应用 / 待应用)
// ---------------------------------------------------------------------------

export interface SessionPublishStatusResult {
	agentId: string;
	sessions: Array<{
		sessionId: string;
		isBusy: boolean;
		policyRevision: number | null;
		pendingPatch: boolean;
	}>;
}
