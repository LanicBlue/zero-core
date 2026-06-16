// Session 上下文 bundle 路由器 (v0.8 M0)
//
// # 文件说明书
//
// ## 核心功能
// 实现 RFC §2.11 / 决策 43 的 `{角色(agentId), projectId} → session` find-or-create
// 路由。被 discuss(后续 M4)、跨 agent 通知(后续 M3)、cron 触发(后续 M1) 三者
// 复用为统一入口 —— 当前 M0 只提供路由原语本身,具体调用方在后续 M 落地。
//
// ## 输入
// - SessionDB
// - ProjectStore (查 workspaceDir)
// - WikiRootResolver (回调,把 projectId → wikiRootNodeId;M2 全局 wiki 树落地后接入)
// - agentId + projectId (+ per-call bundle override)
//
// ## 输出
// - resolveSessionByRoleProject(): { session, created }
// - buildProjectBundle(): 构造某 project 的标准 D-B bundle
//
// ## 定位
// 服务层路由 helper,被 server/index.ts 注入 cron/通知/discuss 调用方。
//
// ## 依赖
// - ./session-db、./project-store
// - ../shared/types (SessionContextBundle)
//
// ## 维护规则
// - 路由键 = (agentId, context.projectId);projectSession 不参与 main session 切换
// - 续接语义:存在即返回,不重置 context
// - 异步触发(后续 cron/notification)与同步子 agent 委托不同步 —— 后者由 delegateTask
//   直接继承 caller bundle(见 subagent-delegation.ts),不走本 helper
//

import type { SessionDB } from "./session-db.js";
import type { ProjectStore } from "./project-store.js";
import type { SessionContextBundle, SessionRecord } from "../shared/types.js";

/**
 * Resolve a project's wiki root node id.
 *
 * v0.8 (M2): returns the id of the project's `project` subtree root in the
 * global wiki memory tree (WikiStore.ensureProjectSubtree mints this id as
 * `wiki-root:<projectId>`). For project-role sessions, this is the
 * wikiRootNodeId carried in the session context bundle — and WikiStore's
 * view-truncated queries treat it as the upper visibility bound (decision 38).
 */
export type WikiRootResolver = (projectId: string) => string;

/**
 * Default wiki root resolver — returns the per-project subtree root id.
 * Stable across restarts (deterministic from projectId).
 */
export const defaultWikiRootResolver: WikiRootResolver = (projectId: string) =>
	`wiki-root:${projectId}`;

/**
 * v0.8 (M2): the global wiki memory tree root id. Sessions whose wikiRootNodeId
 * is this value (zero global-management sessions, observation cron) see the
 * whole tree — every project subtree + global memory type nodes.
 */
export const GLOBAL_WIKI_ROOT_ID = "wiki-root:global";

export interface SessionContextRouterDeps {
	sessionDB: SessionDB;
	projectStore: ProjectStore;
	/** Optional override; defaults to defaultWikiRootResolver. */
	resolveWikiRoot?: WikiRootResolver;
}

export interface ResolveOptions {
	/**
	 * Caller can override parts of the bundle (e.g. narrow workspace to a
	 * subdirectory).projectId override is ignored (project is the lookup key).
	 */
	bundleOverride?: Partial<SessionContextBundle>;
	/** Title for newly-created sessions. */
	title?: string;
}

export interface ResolvedSession {
	session: SessionRecord;
	/** true if a new session was created this call; false if reused existing. */
	created: boolean;
}

/**
 * `{agentId, projectId} → session` find-or-create routing (RFC §2.11).
 *
 * - Lookup key = `(agentId, context.projectId)`.
 * - If a session exists for this pair → return it (续接).
 * - Otherwise build the project's standard bundle (workspaceDir from project,
 *   wikiRootNodeId from resolver) with optional per-call override, create a
 *   new session carrying that bundle, and return it.
 *
 * Identity / toolPolicy / history all live on the target agent (caller's
 * responsibility); only the context bundle is decided here.
 */
export function resolveSessionByRoleProject(
	deps: SessionContextRouterDeps,
	agentId: string,
	projectId: string,
	options?: ResolveOptions,
): ResolvedSession {
	const { sessionDB, projectStore } = deps;
	const resolveWikiRoot = deps.resolveWikiRoot ?? defaultWikiRootResolver;

	// 1. Lookup existing session by routing key
	const existing = sessionDB.findSessionByAgentAndProject(agentId, projectId);
	if (existing) {
		return { session: existing, created: false };
	}

	// 2. Build the project's standard bundle
	const project = projectStore.get(projectId);
	if (!project) {
		throw new Error(`Project not found: ${projectId}`);
	}

	const bundle = buildProjectBundle({ projectStore, resolveWikiRoot }, projectId);
	const merged: SessionContextBundle = {
		...bundle,
		...options?.bundleOverride,
		// projectId is the lookup key — never override it
		projectId,
	};

	// 3. Create a new session carrying the bundle
	const session = sessionDB.createSession(agentId, options?.title ?? `${agentId}:${project.name}`, merged);
	return { session, created: true };
}

/**
 * Build the standard context bundle for a project (workspaceDir from project,
 * wikiRootNodeId via resolver). Used by both the router and cron scope (M1)
 * and notification scope (M3).
 */
export function buildProjectBundle(
	deps: { projectStore: ProjectStore; resolveWikiRoot?: WikiRootResolver },
	projectId: string,
): SessionContextBundle {
	const { projectStore, resolveWikiRoot = defaultWikiRootResolver } = deps;
	const project = projectStore.get(projectId);
	if (!project) {
		throw new Error(`Project not found: ${projectId}`);
	}
	return {
		projectId,
		workspaceDir: project.workspaceDir,
		wikiRootNodeId: resolveWikiRoot(projectId),
	};
}
