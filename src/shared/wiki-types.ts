// Wiki 系统共享契约（wiki-system-redesign plan-01 §4）
//
// # 文件说明书
//
// ## 核心功能
// 新 Wiki 子系统跨 server / tool / REST / UI 共用的类型与错误码闭集。
// 本文件是 v1 契约的唯一权威来源：后续 sub 只能 import,不能在此之外
// 静默扩展 WikiErrorCode / WikiNodeKind。
//
// ## 关键不变量（acceptance-01 §A/§E）
//   - Agent-facing view 类型(WikiNodeView 等)严禁携带 DB 内部整数 ID
//     (id / parent_id / source_id / target_id)。
//   - wiki_audit_log.audit_id 是公开 opaque operation receipt,
//     可作为 `auditId` 出现在 mutation 结果中,不属于内部 ID 禁令。
//   - WikiNodeKind / WikiAction / WikiErrorCode 均为闭集;新增必须先更新
//     design.md + 共享契约 + 相关 acceptance,不能由某个 sub 静默扩展。
//
// ## 维护规则
//   - 新增 code/kind:先改 design.md,再改本文件,再更新 acceptance。
//   - view 类型字段调整:保持可选字段可演进,但不要塞内部 ID。
//
// 参见:
//   - docs/plan/wiki-system-redesign/design.md §4–§5(路径/节点/表)
//   - docs/plan/wiki-system-redesign/design.md §8(工具 action / ToolResult / 错误码闭集)
//   - docs/plan/wiki-system-redesign/plan-01-database-contracts.md §4(本文件范围)

// ---------------------------------------------------------------------------
// WikiNodeKind — v1 closed set (design.md §5.1)
// ---------------------------------------------------------------------------

/**
 * v1 闭合的节点 kind 枚举。未知通用节点使用 `node`。
 *
 * 闭集（design.md §5.1）：
 *   root, namespace, project, directory,
 *   source_file, source_symlink, source_submodule,
 *   knowledge, memory, node
 *
 * 细分类（文档/测试/配置/资产）放入 `attributes.source_kind`,不得让任意
 * kind 字符串直接进入 UI 图标和搜索契约。新增 kind 必须先更新 design.md
 * 与 acceptance,不能由某个 sub 静默扩展。
 */
export type WikiNodeKind =
	| "root"
	| "namespace"
	| "project"
	| "directory"
	| "source_file"
	| "source_symlink"
	| "source_submodule"
	| "knowledge"
	| "memory"
	| "node";

/**
 * v1 闭合的 WikiAction 枚举（design.md §8.1）。普通 Agent 只能调用数据面
 * 这 9 个 action;管理面（地址/绑定/grants/context）不在工具 schema 内。
 */
export type WikiAction =
	| "expand"
	| "read"
	| "search"
	| "create"
	| "update"
	| "delete"
	| "link"
	| "unlink"
	| "move";

// ---------------------------------------------------------------------------
// WikiErrorCode — v1 closed set, EXACTLY 20 codes (design.md §8.10 / plan-01 §4)
// ---------------------------------------------------------------------------

/**
 * v1 闭合的 Wiki 错误码枚举,精确 20 个,不得增删（design.md §8.10）。
 * 新增 code 必须先更新设计、共享契约和所有相关 acceptance,不能由某个
 * sub 静默扩展。
 *
 * 分类:
 *   - 请求/路径/命名:INVALID_REQUEST / INVALID_PATH / INVALID_NAME
 *   - 地址:INVALID_ADDRESS / ADDRESS_UNRESOLVED
 *   - 状态/权限:NOT_FOUND / ACCESS_DENIED / ALREADY_EXISTS / WRITE_CONFLICT
 *   - 局部编辑:EDIT_TARGET_NOT_FOUND / EDIT_TARGET_AMBIGUOUS
 *   - 项目源:SOURCE_MANAGED / SOURCE_UNAVAILABLE / SYNC_FAILED
 *   - 正则:REGEX_INVALID / REGEX_LIMIT_EXCEEDED / REGEX_TIMEOUT
 *   - 删除/移动:HARD_DELETE_BLOCKED / MOVE_TOO_LARGE
 *   - 兜底:INTERNAL_ERROR
 */
export type WikiErrorCode =
	| "INVALID_REQUEST"
	| "INVALID_PATH"
	| "INVALID_NAME"
	| "INVALID_ADDRESS"
	| "ADDRESS_UNRESOLVED"
	| "NOT_FOUND"
	| "ACCESS_DENIED"
	| "ALREADY_EXISTS"
	| "WRITE_CONFLICT"
	| "EDIT_TARGET_NOT_FOUND"
	| "EDIT_TARGET_AMBIGUOUS"
	| "SOURCE_MANAGED"
	| "SOURCE_UNAVAILABLE"
	| "SYNC_FAILED"
	| "REGEX_INVALID"
	| "REGEX_LIMIT_EXCEEDED"
	| "REGEX_TIMEOUT"
	| "HARD_DELETE_BLOCKED"
	| "MOVE_TOO_LARGE"
	| "INTERNAL_ERROR";

/**
 * v1 错误码字面量数组。acceptance 用此断言闭集大小与成员（plan-01 §A）。
 * 后续 sub 从此常量 import,避免散落重复。
 */
export const WIKI_ERROR_CODES: readonly WikiErrorCode[] = [
	"INVALID_REQUEST",
	"INVALID_PATH",
	"INVALID_NAME",
	"INVALID_ADDRESS",
	"ADDRESS_UNRESOLVED",
	"NOT_FOUND",
	"ACCESS_DENIED",
	"ALREADY_EXISTS",
	"WRITE_CONFLICT",
	"EDIT_TARGET_NOT_FOUND",
	"EDIT_TARGET_AMBIGUOUS",
	"SOURCE_MANAGED",
	"SOURCE_UNAVAILABLE",
	"SYNC_FAILED",
	"REGEX_INVALID",
	"REGEX_LIMIT_EXCEEDED",
	"REGEX_TIMEOUT",
	"HARD_DELETE_BLOCKED",
	"MOVE_TOO_LARGE",
	"INTERNAL_ERROR",
] as const;

/**
 * v1 kind 字面量数组。acceptance 用此断言闭集大小与成员（plan-01 §A）。
 */
export const WIKI_NODE_KINDS: readonly WikiNodeKind[] = [
	"root",
	"namespace",
	"project",
	"directory",
	"source_file",
	"source_symlink",
	"source_submodule",
	"knowledge",
	"memory",
	"node",
] as const;

/**
 * v1 action 字面量数组。
 */
export const WIKI_ACTIONS: readonly WikiAction[] = [
	"expand",
	"read",
	"search",
	"create",
	"update",
	"delete",
	"link",
	"unlink",
	"move",
] as const;

// ---------------------------------------------------------------------------
// Attributes — 非通用字段容器（design.md §5.1）
// ---------------------------------------------------------------------------

/**
 * 节点属性。Memory 属性、来源状态、显示名等非通用字段。`display_name`
 * 覆盖默认展示名（默认 = name）。其它键自由演进,但不得用于绕过 kind 闭集。
 */
export interface WikiNodeAttributes {
	/** 覆盖 name 的展示名（design.md §4.2: display title = attributes.display_name ?? name）。 */
	display_name?: string;
	/** Memory 类型等语义分类（细分类不放 kind）。 */
	memory_type?: string;
	/** Memory 持久度等级。 */
	durability?: "permanent" | "long_term" | "short_term";
	/** Memory 复核时间（ISO）。 */
	review_after?: string | null;
	/** Memory 置信度（0–1）。 */
	confidence?: number;
	/** source-bound 节点的源码细分类（file/test/config/...）。 */
	source_kind?: string;
	[k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Agent-facing views — 严禁内部 DB 整数 ID（plan-01 §4 / acceptance-01 §A/§E）
// ---------------------------------------------------------------------------

/**
 * Wiki 节点视图（Agent / REST / UI 共用）。严禁出现 `id` / `parent_id` 等
 * DB 内部整数 ID（acceptance-01 §E 拒绝条件）。`path` 是 Agent 唯一资源 key。
 */
export interface WikiNodeView {
	/** 规范路径（Agent 唯一资源 key;`wiki-root/...`）。 */
	path: string;
	/** 最后一段 name（也是默认展示名）。 */
	name: string;
	/** v1 闭合的 kind。 */
	kind: WikiNodeKind;
	/** 短摘要（expand / 搜索 / Prompt 注入使用）。 */
	summary: string;
	/** 乐观并发修订号（从 1 开始）。 */
	revision: number;
	/** 父路径（root 的 parent 为 null）。 */
	parentPath: string | null;
	/** ISO 创建时间。 */
	createdAt: string;
	/** ISO 最后更新时间。 */
	updatedAt: string;
	/** ISO 归档时间（active 节点为 null）。 */
	archivedAt: string | null;
	/** 非通用属性容器。 */
	attributes: WikiNodeAttributes;
	/** 是否绑定到 source（项目镜像节点;true 时 move/delete 受限）。 */
	sourceBound: boolean;
	/** display title（= attributes.display_name ?? name）。 */
	displayTitle: string;
}

/**
 * Wiki 链接视图（无方向;一条记录同时支持 outgoing/incoming）。
 * 严禁 `source_id` / `target_id` 内部整数 ID。
 */
export interface WikiLinkView {
	/** 关系语义（depends_on / used_by / contains / ...;design.md §5.2）。 */
	relation: string;
	/** source 节点规范路径。 */
	sourcePath: string;
	/** target 节点规范路径。 */
	targetPath: string;
	/** ISO 创建时间。 */
	createdAt: string;
	/** 创建者（可选）。 */
	createdBy: string | null;
}

/**
 * Wiki 仓库绑定视图（项目镜像元数据）。`projectNodeId` 是内部 ID,不暴露;
 * 对外只暴露 `projectId` / `repositoryId` / `projectPath`。
 */
export interface WikiRepositoryView {
	/** 仓库稳定 ID（ProjectRecord 维度的业务键）。 */
	repositoryId: string;
	/** 稳定项目业务 ID（ProjectRecord.id 的应用层软引用）。 */
	projectId: string;
	/** 项目根规范路径（`wiki-root/projects/<stable-project-id>`）。 */
	projectPath: string;
	/** 仓库内 source root（相对路径;默认空 = 仓库根）。 */
	sourceRoot: string;
	/** 默认分支（默认 main）。 */
	defaultBranch: string;
	/** 已索引到的 Git revision（SHA 或 null）。 */
	indexedRevision: string | null;
	/** 同步状态（pending / indexing / synced / stale / failed）。 */
	syncStatus: string;
	/** 最近一次同步错误（null = 无错误）。 */
	lastError: string | null;
	/** 最近一次成功索引时间（ISO 或 null）。 */
	lastIndexedAt: string | null;
}

/**
 * Wiki 静态逻辑地址视图（`runtime://` 等管理者注册的地址）。
 * `targetId` 内部 ID 不暴露;对外只暴露 `targetPath`（可能为 null:动态地址）。
 */
export interface WikiAddressView {
	/** 地址字符串（如 `runtime://rules/global`）。 */
	address: string;
	/** 目标节点规范路径（null 表示未绑定或动态解析）。 */
	targetPath: string | null;
	/** resolver 闭集声明值（不是函数名）。 */
	resolver: string | null;
	/** 地址 scope（如 `runtime` / `static`）。 */
	scope: string;
	/** 地址类型（如 `static` / `alias`）。 */
	kind: string;
	/** Prompt 策略（可选 JSON 字符串）。 */
	promptPolicy: string | null;
	/** 地址修订号。 */
	revision: number;
	/** ISO 创建时间。 */
	createdAt: string;
	/** ISO 最后更新时间。 */
	updatedAt: string;
}

/**
 * 审计日志视图。`auditId` 是公开 opaque operation receipt（不属于内部 ID 禁令）;
 * `oldRevision` / `newRevision` 是修订号,可公开。`nodePath` 是规范路径。
 */
export interface WikiAuditView {
	/** 公开 opaque 操作凭据（wiki_audit_log.audit_id）。 */
	auditId: string;
	/** 用于安全重试的请求 ID（可选）。 */
	requestId: string | null;
	/** 发起者 Agent ID（可选）。 */
	actorAgentId: string | null;
	/** 会话 ID（可选）。 */
	sessionId: string | null;
	/** 触发的 action。 */
	action: string;
	/** 受影响节点规范路径（可选）。 */
	nodePath: string | null;
	/** 操作前修订号（可选）。 */
	oldRevision: number | null;
	/** 操作后修订号（可选）。 */
	newRevision: number | null;
	/** 操作详情（自由 JSON;已序列化）。 */
	detail: unknown;
	/** ISO 创建时间。 */
	createdAt: string;
}

// ---------------------------------------------------------------------------
// Pagination — cursor-based（design.md §8.3 expand/search）
// ---------------------------------------------------------------------------

/**
 * 分页结果包装。`cursor` 为 null 表示已到末尾;否则传入下一次请求的 `cursor`。
 */
export interface WikiPageResult<T> {
	/** 当前页条目。 */
	items: T[];
	/** 下一页游标（null = 已到末尾）。 */
	cursor: string | null;
	/** 是否还有更多页（便于 UI 提示）。 */
	hasMore: boolean;
}

/**
 * 分页请求参数。`limit` 必须为正整数;`cursor` 为上一页返回的 opaque 字符串。
 */
export interface WikiPageRequest {
	/** 每页上限（必须 > 0;调用方裁剪到合法区间）。 */
	limit: number;
	/** 上一页返回的 cursor;首次请求传 null。 */
	cursor: string | null;
}

// ---------------------------------------------------------------------------
// Compiled grants / access（design.md §7.2）— shape only, no logic in plan-01
// ---------------------------------------------------------------------------

/**
 * 编译后的 Wiki grant（AgentRecord.wikiGrants 在 session build 时编译）。
 * `canonicalScope` 是已解析为规范路径的 scope（`memory://` → `wiki-root/memory/<agent-id>`）。
 */
export interface CompiledWikiGrant {
	/** 已解析为规范路径的 scope。 */
	canonicalScope: string;
	/** 允许的 action 闭集。 */
	actions: WikiAction[];
}

/**
 * 编译后的 Wiki 访问上下文（放入 SessionConfig / CallerCtx）。
 * Plan-02+ 实现编译逻辑;plan-01 只锁形状。
 */
export interface CompiledWikiAccess {
	/** Agent 稳定 ID。 */
	agentId: string;
	/** 当前活跃项目稳定 ID（可选）。 */
	activeProjectId?: string;
	/** 编译后的 grants 并集。 */
	grants: CompiledWikiGrant[];
	/** 策略修订号（用于 Prompt 缓存失效）。 */
	policyRevision: number;
}

// ---------------------------------------------------------------------------
// Error / Result helpers
// ---------------------------------------------------------------------------

/**
 * Wiki 错误对象（携带闭集 code + 人类可读 message）。
 * ToolResult / REST / UI 共用。
 */
export interface WikiError {
	/** v1 闭合错误码（精确 20 个,plan-01 §4）。 */
	code: WikiErrorCode;
	/** 人类可读说明（不包含内部 ID）。 */
	message: string;
	/** 关联的请求 ID（可选,便于审计回溯）。 */
	requestId?: string | null;
	/** 关联的节点路径（可选）。 */
	path?: string | null;
}

/**
 * Mutation 结果。`auditId` 是公开 opaque operation receipt（wiki_audit_log.audit_id）,
 * 不属于内部整数 ID 禁令（plan-01 §4 / design.md §8.10）。
 */
export interface WikiMutationResult {
	/** 操作是否成功。 */
	success: boolean;
	/** 受影响节点的当前规范路径（move 后是新路径）。 */
	path: string;
	/** 操作后的最新修订号。 */
	revision: number;
	/** 公开 opaque 操作凭据。 */
	auditId: string;
	/** 操作前的修订号（便于客户端冲突检测）。 */
	oldRevision: number | null;
}
