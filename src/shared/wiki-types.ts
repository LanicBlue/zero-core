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
// Request context（plan-02 §1 / design.md §7.2 / §7.4）
// ---------------------------------------------------------------------------

/**
 * 普通 Agent 数据面调用上下文（plan-02 §1）。
 *
 * 关键不变量（plan-02 §3 / acceptance-02 §C「compiled access 不能从 service 输入
 * 中的 agentId/projectId 被覆盖」）:
 *   - `access` 由 AgentService 在 session build 时编译为 `CompiledWikiAccess`,
 *     由 host（Agent loop / REST host for UI）注入;**禁止**由 Agent 工具输入
 *     自报。WikiService 必须忽略 req 中的 agentId/projectId/scope 字段 —— 唯一
 *     权威来源是 ctx.access。
 *   - 普通 ctx 不能执行管理面 action（restore / hardDelete / 地址注册）。
 *   - `agentId` / `activeProjectId` 用于解析 `memory://` / `project://`,
 *     不用于授权覆盖。
 */
export interface WikiRequestContext {
	/** Host 注入的编译后访问上下文（权威 grants 来源）。 */
	access: CompiledWikiAccess;
	/** Agent 稳定 ID（用于解析 memory:// + audit）。 */
	agentId: string;
	/** 当前活跃项目稳定 ID（用于解析 project://;可能为空）。 */
	activeProjectId?: string;
	/** 会话 ID（audit 关联;可选）。 */
	sessionId?: string | null;
	/** 请求 ID（安全重试去重;可选）。 */
	requestId?: string | null;
}

/**
 * 管理面调用上下文（plan-02 §1 / §4）。restore / hardDelete / 地址注册走此 ctx。
 *
 * 设计（plan-02 §4 + design.md §7.4）：REST host 为管理 UI 注入管理 authority;
 * UI 不提交任意 callerCtx 或 grants。管理面 ctx 不携带 Agent grants —— 权限来自
 * host 的管理 authority 校验（不在 WikiService 内判定）。
 */
export interface WikiAdminRequestContext {
	/** 管理通道标识（如 'rest-ui' / 'cli' / 'indexer'）。 */
	channel: string;
	/** 操作发起者（用户 ID / 系统服务名;audit 用）。 */
	actor: string;
	/** 请求 ID（安全重试去重;可选）。 */
	requestId?: string | null;
	/** 会话 ID（audit;可选）。 */
	sessionId?: string | null;
	/**
	 * 可选的管理员视图：当管理操作需要走 Agent grants 判定时（罕见,例如 index
	 * batch），host 可注入 effective access。无则视为管理 authority 已通过。
	 */
	effectiveAccess?: CompiledWikiAccess;
}

/**
 * 任意 Wiki 调用上下文（internal helper 用;公开 API 用具体子类型）。
 */
export type AnyWikiRequestContext = WikiRequestContext | WikiAdminRequestContext;

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

// ---------------------------------------------------------------------------
// Data-plane request / result shapes（plan-02 §1 / design.md §8.3–§8.9）
// ---------------------------------------------------------------------------

/**
 * 逻辑地址输入。接受 canonical path（`wiki-root/...`）、动态地址（`memory://` /
 * `project://`）或静态 alias（`runtime://...`）。
 */
export interface WikiAddressInput {
	/**
	 * 节点地址（canonical / 动态 / alias）。`memory://` / `project://` 走内建
	 * 动态 resolver;其它 scheme 走 wiki_addresses 静态 alias。
	 */
	address: string;
}

/** 分页参数（design.md §8.3 expand）。 */
export interface WikiPaginationInput {
	/** 每页上限（service 层裁剪到合法区间）。 */
	limit?: number;
	/** 上一页 cursor;首次请求不传。 */
	cursor?: string | null;
}

/**
 * `expand` 请求（design.md §8.3）。返回当前节点 summary + 直接 children 分页,
 * 不返回长正文。
 */
export interface WikiExpandRequest extends WikiAddressInput, WikiPaginationInput {
	/** 是否在每个 child 上附带 link 摘要计数。 */
	includeLinks?: boolean;
}

/**
 * `expand` 结果项（一个直接 child 的紧凑视图）。
 */
export interface WikiExpandChildItem {
	/** Child 规范路径。 */
	path: string;
	/** 最后一段 name。 */
	name: string;
	/** v1 闭合 kind。 */
	kind: WikiNodeKind;
	/** 短摘要。 */
	summary: string;
	/** 当前 revision。 */
	revision: number;
	/** display title。 */
	displayTitle: string;
	/** 是否归档（expand 默认只返回 active;管理面可包含 archived）。 */
	archived: boolean;
	/** Outgoing + incoming 链接计数（includeLinks=true 时填）。 */
	outgoingCount?: number;
	incomingCount?: number;
}

/**
 * `expand` 结果。
 */
export interface WikiExpandResult {
	/** 当前节点规范路径。 */
	path: string;
	/** 当前节点 summary。 */
	summary: string;
	/** 当前节点 display title。 */
	displayTitle: string;
	/** 当前节点 kind。 */
	kind: WikiNodeKind;
	/** 直接 children 分页。 */
	children: WikiPageResult<WikiExpandChildItem>;
	/** 操作 audit receipt（read-only action 也记录一条 expand 操作;null=未记录）。 */
	auditId: string | null;
}

/**
 * `read` 请求视图选择（design.md §8.4）。
 */
export type WikiReadView = "summary" | "content" | "links" | "all" | "source";

/**
 * `read` 请求（design.md §8.4）。
 */
export interface WikiReadRequest extends WikiAddressInput {
	/** 视图选择（默认 summary）。 */
	view?: WikiReadView;
	/** section 名（content 视图;按 heading 取一段）。 */
	section?: string | null;
	/** 同名 section 1-based occurrence（可选）。 */
	sectionOccurrence?: number | null;
	/** 同名 section level 消歧（可选）。 */
	sectionLevel?: number | null;
	/** content 行范围（line_start / line_end;可选）。 */
	lineStart?: number | null;
	lineEnd?: number | null;
	/** source 视图模式（indexed / dirty;plan-03 实现 dirty）。 */
	sourceView?: "indexed" | "dirty" | null;
}

/**
 * `read` 结果。
 */
export interface WikiReadResult {
	/** 节点规范路径。 */
	path: string;
	/** 节点视图（含 summary / attributes 等完整字段;无内部 ID）。 */
	node: WikiNodeView;
	/**
	 * 当 view=content/all 时的正文内容（按 section / lineStart-lineEnd 切片后）。
	 * WikiNodeView 不含 content（避免 expand/search 携带长正文）—— read action
	 * 显式在此字段提供。
	 */
	content?: string;
	/** 当 view 包含 links 时的可见链接列表（已按授权过滤对端不可见条目）。 */
	links?: {
		outgoing: WikiLinkView[];
		incoming: WikiLinkView[];
	};
	/** 当 view=source 时的源码元数据（无则不填）。 */
	source?: {
		repositoryId: string;
		sourcePath: string;
		indexedRevision: string;
		syncStatus: string;
	};
	/** 行范围或 section 切片（view=content 时;null 表示全文）。 */
	contentSlice?: {
		/** 切片起点行号（1-based;null=从 1 开始）。 */
		startLine: number | null;
		/** 切片终点行号（1-based inclusive;null=到末尾）。 */
		endLine: number | null;
		/** 总行数（用于客户端判断是否被截断）。 */
		totalLines: number;
	};
	/** 操作 audit receipt（read-only;null=未记录）。 */
	auditId: string | null;
}

/**
 * `create` 请求（design.md §8.6）。
 */
export interface WikiCreateRequest {
	/** 父节点地址。 */
	parent: string;
	/** 新节点最后一段 name。 */
	name: string;
	/** v1 闭合 kind（默认 node）。 */
	kind?: WikiNodeKind;
	/** 短摘要。 */
	summary?: string;
	/** 长正文（默认空串）。 */
	content?: string;
	/** attributes 容器（整体写入;后续 update 走字段级 patch）。 */
	attributes?: WikiNodeAttributes;
	/** 创建者标识（默认取 ctx.agentId）。 */
	createdBy?: string | null;
}

/**
 * 字段更新集合（design.md §8.7 字段更新）。`attributes` 为字段级 patch;
 * 值为 `null` 删除该 key。
 */
export interface WikiUpdateFieldChanges {
	/** 新 summary。 */
	summary?: string;
	/** 整段 content 替换（少见;常用 operations 局部编辑）。 */
	content?: string;
	/** attributes 字段级 patch（null 删除 key,不传 key 不动）。 */
	attributes?: WikiNodeAttributes | null;
}

/**
 * 单个局部编辑 operation（design.md §8.7）。
 */
export type WikiEditOperation =
	| {
		op: "replace_text";
		old_text: string;
		new_text: string;
		expected_occurrences?: number | null;
	}
	| {
		op: "insert_before";
		text: string;
		anchor: string;
		anchor_section?: string | null;
	}
	| {
		op: "insert_after";
		text: string;
		anchor: string;
		anchor_section?: string | null;
	}
	| {
		op: "append";
		text: string;
	}
	| {
		op: "prepend";
		text: string;
	}
	| {
		op: "replace_section";
		section: string;
		new_text: string;
		level?: number | null;
		occurrence?: number | null;
	}
	| {
		op: "append_to_section";
		section: string;
		text: string;
		level?: number | null;
		occurrence?: number | null;
	}
	| {
		op: "delete_section";
		section: string;
		level?: number | null;
		occurrence?: number | null;
	};

/**
 * `update` 请求（design.md §8.7）。`changes` 与 `operations` 二选一或都传
 * （先应用 changes 再 operations;同一 transaction 内 revision +1 一次）。
 */
export interface WikiUpdateRequest extends WikiAddressInput {
	/** 乐观并发：调用方观察到的当前 revision。 */
	expected_revision: number;
	/** 字段级更新（可选;不传则不修改具体字段）。 */
	changes?: WikiUpdateFieldChanges;
	/** 局部正文编辑（可选）。 */
	operations?: WikiEditOperation[];
}

/**
 * `archive`（默认 delete 行为）请求（design.md §8.9）。
 */
export interface WikiArchiveRequest extends WikiAddressInput {
	/** 是否级联整棵子树（默认 true）。 */
	cascade?: boolean;
}

/**
 * `hardDelete` 请求（管理面;design.md §8.9）。
 */
export interface WikiHardDeleteRequest extends WikiAddressInput {
	/** 是否级联整棵子树（默认 true）。 */
	cascade?: boolean;
}

/**
 * `restore` 请求（管理面;plan-02 §4）。重新激活归档节点。
 */
export interface WikiRestoreRequest {
	/** 归档节点的 canonical path（不接受动态地址;管理面使用稳定路径）。 */
	path: string;
	/** 是否级联恢复整棵子树（默认 true）。 */
	cascade?: boolean;
}

/**
 * `link` 请求（design.md §8.8）。
 */
export interface WikiLinkRequest {
	/** source 节点地址。 */
	source: string;
	/** target 节点地址。 */
	target: string;
	/** 关系语义（depends_on / used_by / contains / ...）。 */
	relation: string;
}

/**
 * `unlink` 请求（design.md §8.8）。
 */
export interface WikiUnlinkRequest {
	/** source 节点地址。 */
	source: string;
	/** target 节点地址。 */
	target: string;
	/** 关系语义。 */
	relation: string;
}

/**
 * `move` 请求（design.md §8.9）。
 */
export interface WikiMoveRequest extends WikiAddressInput {
	/** 新父节点地址。 */
	newParent: string;
	/** 可选新 name（不传则保留原名）。 */
	newName?: string | null;
}
