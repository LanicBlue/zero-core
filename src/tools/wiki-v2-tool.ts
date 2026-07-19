// Wiki v2 Agent 工具(wiki-system-redesign plan-04 §1-§4/§7)
//
// # 文件说明书
//
// ## 核心功能
// Plan-04 终态 Wiki 数据面工具实现。**未注册**(plan-04);通过
// `createWikiTool(deps)` factory 暴露,由 plan-05 接到正式 ToolRegistry 并
// 取代 `src/tools/wiki-tool.ts`(原子切换)。
//
// 9 个 action(design.md §8.1 闭集):
//
//     expand, read, search, create, update,
//     delete, link, unlink, move
//
// 旧 `createMemory/updateMemory/docRead/docWrite/docEdit` 全部退役:
// Memory 通过 `memory://` 地址 + create/update 表达;doc 操作合并到 read/update。
//
// ## 关键不变量(plan-04 §1/§2/§3,acceptance-04 §A/§B/§H)
//   - **顶层 z.object schema**(非 discriminatedUnion;LLM 函数调用协议要求)。
//   - **schema 无禁用字段**:agentId/projectId/grants/canonicalScope/cwd/
//     nodeId/短 ID/旧 title path 均不得出现。
//   - **身份只从 `callerCtx.wikiAccess`** —— 不读 AgentStore,不接受 LLM input
//     中的身份字段。
//   - **结构化 ToolResult**:每个 action 返对应类型(WikiExpandResult 等);
//     `format()` 产紧凑 Markdown;REST/UI 直接消费 JSON,不经 format。
//   - **不泄露内部 ID**:payload 与 format 文本均不含整数 ID / 短 ID / 旧 path prefix;
//     auditId 是公开 opaque receipt(允许)。
//   - **不注册**:本 sub 不在 ToolRegistry 注册(避免中间阶段破坏 session);
//     plan-05 用本 factory 的产物注册并删旧 wiki-tool.ts。
//
// ## 寻址(plan-04 §1 / design.md §8.2)
//   - 接受 canonical path(`wiki-root/...`)或逻辑地址(`memory://` /
//     `project://` / `runtime://`)。
//   - **不接受**nodeId / 短 ID / 旧 title path。
//   - 字段:`node / parent / source / target / newParent`(逻辑地址或 canonical)。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-04-wiki-tool-search.md §1-§4
//   - docs/archive/wiki-system-redesign/design.md §8

import { z } from "zod";
import { buildTool, type BuildToolOptions } from "./tool-factory.js";
import type {
	CallerCtx,
	ToolResult,
} from "./types.js";
import type {
	AnyWikiRequestContext,
	CompiledWikiAccess,
	WikiArchiveRequest,
	WikiCreateRequest,
	WikiEditOperation,
	WikiErrorCode,
	WikiExpandRequest,
	WikiExpandResult,
	WikiLinkRequest,
	WikiMoveRequest,
	WikiMutationResult,
	WikiNodeAttributes,
	WikiNodeKind,
	WikiPageResult,
	WikiReadRequest,
	WikiReadResult,
	WikiRequestContext,
	WikiUnlinkRequest,
	WikiUpdateFieldChanges,
	WikiUpdateRequest,
	WikiLinkView,
	WikiExpandChildItem,
	WikiNodeView,
	WikiReadView,
} from "../shared/wiki-types.js";
import type {
	WikiSearchRequest,
	WikiSearchHit,
	WikiSearchResult,
	WikiSourceSearchHit,
	WikiSearchMode,
	WikiSearchTarget,
	WikiSearchField,
} from "../shared/wiki-search-types.js";
import { isWikiServiceError, wikiError } from "../server/wiki/wiki-errors.js";
import { WIKI_ERROR_CODES } from "../shared/wiki-types.js";
import type { WikiService } from "../server/wiki/wiki-service.js";
import type { WikiSearchService } from "../server/wiki/wiki-search-service.js";

// ---------------------------------------------------------------------------
// Section 1 — 9-action flat z.object schema
// ---------------------------------------------------------------------------

/**
 * v1 Wiki 工具顶层 action 枚举(plan-04 §1 闭集,9 个)。
 *
 * **不得**扩展为 createMemory/updateMemory/docRead/docWrite/docEdit 或
 * 任何管理面 action(acceptance-04 §A 拒绝条件)。
 */
const WIKI_V2_ACTIONS = [
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

/**
 * v1 schema 顶层 z.object(plan-04 §1)。
 *
 * **LLM-visible schema 不携带**(acceptance-04 §A):
 *   - `agentId` / `projectId` / `grants` / `canonicalScope` / `cwd` ——
 *     身份由 host 注入 `callerCtx.wikiAccess`,LLM 看不到也填不了。
 *   - `nodeId` / 短 ID / 旧 title path —— 全部用 logical/canonical 寻址。
 *   - `overwrite`(docWrite clobber bypass) —— 已退役;update 用 operations
 *     或 changes.field 精确编辑。
 *
 * 字段(`node` / `parent` / `source` / `target` / `newParent`)接受 logical
 * 地址或 canonical path;不接受 nodeId 或旧 title path。
 */
export const wikiV2ActionSchema = z.object({
	// ── action discriminator(必填;固定 9 个值)──────────────────────────
	action: z.enum(WIKI_V2_ACTIONS),

	// ── 寻址字段(logical address OR canonical path;无 nodeId)──────
	/** expand/read/update/delete 的目标节点(logical address 或 canonical path)。 */
	node: z.string().optional()
		.describe("Node address (logical 'memory://' / 'project://' / 'runtime://...' OR canonical 'wiki-root/...'). Used by expand/read/update/delete."),
	/** create 的父节点地址。 */
	parent: z.string().optional()
		.describe("Parent node address for create."),
	/** link/unlink 的 source 节点地址。 */
	source: z.string().optional()
		.describe("Source node address for link/unlink."),
	/**
	 * link/unlink 的 target 节点地址(字符串)OR search 的目标枚举(wiki/source/both)。
	 *
	 * 由于 flat schema 把所有 action 的字段并列,link.target(字符串)和
	 * search.target(枚举)共用此字段。运行时按 action 区分:link/unlink 取
	 * 字符串解释;search 取枚举解释。
	 */
	target: z.union([
		z.string(),
		z.enum(["wiki", "source", "both"]),
	]).optional()
		.describe("link/unlink: target node address (string). search: target enum 'wiki'|'source'|'both'. Disambiguated by action."),
	/** move 的新父节点地址。 */
	newParent: z.string().optional()
		.describe("New parent address for move."),
	/** move 的可选新 name(不传则保留原名)。 */
	newName: z.string().optional()
		.describe("Optional new name for move/rename (omit to keep current name)."),

	// ── create/update 公共字段 ─────────────────────────────────────────
	/** create 的最后一段 name;move 也用作 newName 的 alt(旧字段)。 */
	name: z.string().optional()
		.describe("create: last path segment name. (move uses newName.)"),
	/** create/update 的 kind(v1 闭合)。 */
	kind: z.enum([
		"root", "namespace", "project", "directory",
		"source_file", "source_symlink", "source_submodule",
		"knowledge", "memory", "node",
	]).optional()
		.describe("Node kind (v1 closed set). Default 'node'."),
	/** create 的初始 summary;update 的 summary 字段(用 changes.summary)。 */
	summary: z.string().optional()
		.describe("create: initial summary. update: use changes.summary instead."),
	/** create 的初始 content;read 不使用(read 用 view=content)。 */
	content: z.string().optional()
		.describe("create: initial content body."),
	/** create 的初始 attributes。 */
	attributes: z.record(z.string(), z.unknown()).optional()
		.describe("create: initial attributes (display_name, memory_type, durability, ...)."),

	// ── expand 字段 ───────────────────────────────────────────────────
	limit: z.number().int().positive().max(500).optional()
		.describe("expand/search: page size (max 500 for expand, 200 for search)."),
	cursor: z.string().nullable().optional()
		.describe("expand/search: pagination cursor from previous page; null on first request."),
	/** expand 是否在每个 child 上附带可见 link 计数。 */
	includeLinks: z.boolean().optional()
		.describe("expand: include outgoing/incoming link counts per child (visible to caller only)."),

	// ── read 字段 ─────────────────────────────────────────────────────
	view: z.enum(["summary", "content", "links", "all", "source"]).optional()
		.describe("read: view selection. summary (default) / content / links / all / source."),
	section: z.string().nullable().optional()
		.describe("read(view=content): section name (heading text)."),
	sectionOccurrence: z.number().int().positive().nullable().optional()
		.describe("read: same-name section 1-based occurrence (optional disambiguation)."),
	sectionLevel: z.number().int().positive().nullable().optional()
		.describe("read: same-name section level disambiguation."),
	lineStart: z.number().int().positive().nullable().optional()
		.describe("read(view=content): 1-based start line."),
	lineEnd: z.number().int().positive().nullable().optional()
		.describe("read(view=content): 1-based end line (inclusive)."),
	sourceView: z.enum(["indexed", "dirty"]).nullable().optional()
		.describe("read(view=source): 'indexed' (default) reads indexed_revision; 'dirty' reads workspace."),

	// ── search 字段(plan-04 §5)──────────────────────────────────────
	query: z.string().optional()
		.describe("search: pattern (mode-dependent: substring literal, regex syntax, FTS phrase, glob)."),
	mode: z.enum(["exact", "substring", "glob", "regex", "fulltext", "hybrid"]).optional()
		.describe("search: mode (default fulltext). regex runs in a sandboxed worker with hard limits."),
	// 注:`target` 字段已在「寻址字段」段定义(union of string | enum);
	// search action 取 enum 解释,link/unlink 取 string 解释。
	fields: z.array(z.enum(["name", "path", "summary", "content"])).optional()
		.describe("search: restrict match to these fields."),
	caseSensitive: z.boolean().optional()
		.describe("search: case-sensitive (default false; ASCII-only folding caveat for substring)."),
	kinds: z.array(z.enum([
		"root", "namespace", "project", "directory",
		"source_file", "source_symlink", "source_submodule",
		"knowledge", "memory", "node",
	])).optional()
		.describe("search: filter by kind."),
	scope: z.string().nullable().optional()
		.describe("search: canonical scope or logical address to narrow (intersect with caller grants)."),
	fileGlobs: z.array(z.string()).optional()
		.describe("search(target=source/both): ripgrep `--glob` file filter."),

	// ── update 字段(plan-04 §6)──────────────────────────────────────
	/** update 必填:乐观并发(调用方观察到的当前 revision)。 */
	expected_revision: z.number().int().positive().optional()
		.describe("update REQUIRED: caller's observed revision (optimistic concurrency)."),
	/** update 字段级 patch(summary/content/attributes)。 */
	changes: z.object({
		summary: z.string().optional(),
		content: z.string().optional(),
		attributes: z.record(z.string(), z.unknown()).nullable().optional(),
	}).optional()
		.describe("update: field-level patch. attributes=null clears; key=null clears that key."),
	/** update 局部正文编辑 operations。 */
	operations: z.array(z.discriminatedUnion("op", [
		z.object({
			op: z.literal("replace_text"),
			old_text: z.string(),
			new_text: z.string(),
			expected_occurrences: z.number().int().nonnegative().nullable().optional(),
		}),
		z.object({
			op: z.literal("insert_before"),
			text: z.string(),
			anchor: z.string(),
			anchor_section: z.string().nullable().optional(),
		}),
		z.object({
			op: z.literal("insert_after"),
			text: z.string(),
			anchor: z.string(),
			anchor_section: z.string().nullable().optional(),
		}),
		z.object({ op: z.literal("append"), text: z.string() }),
		z.object({ op: z.literal("prepend"), text: z.string() }),
		z.object({
			op: z.literal("replace_section"),
			section: z.string(),
			new_text: z.string(),
			level: z.number().int().positive().nullable().optional(),
			occurrence: z.number().int().positive().nullable().optional(),
		}),
		z.object({
			op: z.literal("append_to_section"),
			section: z.string(),
			text: z.string(),
			level: z.number().int().positive().nullable().optional(),
			occurrence: z.number().int().positive().nullable().optional(),
		}),
		z.object({
			op: z.literal("delete_section"),
			section: z.string(),
			level: z.number().int().positive().nullable().optional(),
			occurrence: z.number().int().positive().nullable().optional(),
		}),
	])).optional()
		.describe("update: localized content edits (replace_text / insert_*/append/prepend/replace_section/append_to_section/delete_section)."),

	// ── link 字段 ─────────────────────────────────────────────────────
	relation: z.string().optional()
		.describe("link/unlink: relation semantic (depends_on / used_by / contains / implements / tested_by / documented_by / derived_from / supersedes / related_to)."),

	// ── delete 字段(默认 archive)──────────────────────────────────
	cascade: z.boolean().optional()
		.describe("delete: cascade archive to subtree (default true)."),

	// ── 创建者标识(可选;用于 audit)──────────────────────────────
	createdBy: z.string().nullable().optional()
		.describe("create: optional creator ID for audit (defaults to caller agentId)."),
});

export type WikiV2ActionInput = z.infer<typeof wikiV2ActionSchema>;

// ---------------------------------------------------------------------------
// Section 2 — ToolResult types (already in shared/wiki-types.ts:
// WikiExpandResult, WikiReadResult, WikiMutationResult; + WikiSearchResult
// from wiki-search-types.ts). Union exported for callers.
// ---------------------------------------------------------------------------

export type WikiV2ToolData =
	| WikiExpandResult
	| WikiReadResult
	| WikiSearchResult
	| WikiMutationResult;

// ---------------------------------------------------------------------------
// Section 3 — Error → ToolResult mapping
// ---------------------------------------------------------------------------

/**
 * WikiErrorCode 闭集的 Set 形式,用于 duck-typed code 识别(round-2 FIX 1)。
 * 比 Array.includes 快,且避免 `as WikiErrorCode` 强转绕过 TS。
 */
const WIKI_ERROR_CODE_SET: ReadonlySet<string> = new Set(WIKI_ERROR_CODES);

/**
 * 从任意 message 文本中剥除内部整数 id leakage(round-2 FIX 1)。
 *
 * 匹配 `node id=5` / `id=5` / `id = 5` / `id\t= 5` 等模式(数字字面量)。
 * revision / auditId / projectId 等公开标识不受影响。
 */
function stripInternalIds(message: string): string {
	return message.replace(/(\bnode\s+)?id\s*=\s*\d+/gi, "").trim();
}

/**
 * 把 WikiServiceError 映射为结构化 ToolResult{ok:false}。
 *
 * error code 是闭集 WikiErrorCode(机器可判);message 不含内部 ID(由 service
 * 层保证);details 暂不返回(service 层已 permission-filter links/snippets)。
 *
 * **Defense-in-depth(round-2 FIX 1)**:
 *   - 即使 service 层漏抛 raw Error 但带 `.code` 字段(duck-typed),也按闭集
 *     code 映射,避免 fall-through 到 INTERNAL_ERROR 把冲突伪装成内部错误
 *     (round-1 BLOCKER FIX 1 复现路径)。
 *   - 对所有 surfaced message 做一次 `stripInternalIds` —— 无论来源是
 *     WikiServiceError / raw Error / 兜底 INTERNAL_ERROR,都剥除任何 `id=N`
 *     形式的内部整数 id 泄露(acceptance-02 §A.4 / §G)。
 */
function wikiErrorToToolResult(err: unknown): ToolResult<WikiV2ToolData> {
	if (isWikiServiceError(err)) {
		return {
			ok: false,
			error: `${err.code}: ${stripInternalIds(err.message)}`,
			data: {
				success: false,
				path: err.path ?? "",
				revision: 0,
				auditId: "",
				oldRevision: null,
			} as WikiMutationResult,
		};
	}
	// Duck-typed: raw Error 带 `.code` 字段且 code ∈ 闭集 → 按该 code 映射,
	// 避免 service 层遗漏的 raw throw 被错误地包装成 INTERNAL_ERROR。
	const duckCode = (err as { code?: unknown })?.code;
	const mappedCode: WikiErrorCode | null =
		typeof duckCode === "string" && WIKI_ERROR_CODE_SET.has(duckCode)
			? (duckCode as WikiErrorCode)
			: null;
	const rawMsg = (err as Error)?.message ?? "unknown error";
	const safeMsg = stripInternalIds(rawMsg);
	const code: WikiErrorCode = mappedCode ?? "INTERNAL_ERROR";
	return {
		ok: false,
		error: `${code}: ${safeMsg}`,
		data: {
			success: false,
			path: (err as { path?: string })?.path ?? "",
			revision: 0,
			auditId: "",
			oldRevision: null,
		} as WikiMutationResult,
	};
}

// ---------------------------------------------------------------------------
// Section 4 — CallerCtx.wikiAccess → WikiRequestContext bridge
// ---------------------------------------------------------------------------

/**
 * 从 callerCtx.wikiAccess 构造 WikiRequestContext。**唯一**身份来源
 * (plan-04 §2 / acceptance-04 §H「工具不通过 AgentStore 或 input 决定身份」)。
 *
 * wikiAccess 缺失 → 抛 ACCESS_DENIED(不退回旧 anchor 模型)。
 */
function buildRequestContext(
	callerCtx: CallerCtx,
	requestId?: string | null,
): WikiRequestContext {
	const access = callerCtx.wikiAccess;
	if (!access) {
		// 没有 wikiAccess = host 未注入 → 立即拒绝,不静默退回旧路径。
		throw wikiError(
			"ACCESS_DENIED",
			"Wiki access context not provided by host (callerCtx.wikiAccess is missing)",
		);
	}
	return {
		access,
		agentId: access.agentId,
		activeProjectId: access.activeProjectId,
		sessionId: callerCtx.sessionId ?? null,
		requestId: requestId ?? callerCtx.toolCallId ?? null,
	};
}

// ---------------------------------------------------------------------------
// Section 5 — Tool factory
// ---------------------------------------------------------------------------

/**
 * Wiki v2 工具依赖。Plan-05 在 AgentService / server tool-execute 接线时
 * 构造;Plan-04 测试 host 直接 new。
 *
 * 字段接受**实例**或 **getter 函数**两种形态:
 *   - 测试 / 直接 host:传实例(`{ wikiService, searchService }`)。
 *   - 生产注册(`src/tools/wiki-tool.ts` 注册到 ALL_TOOLS 时服务还未实例化):
 *     传 getter(`{ wikiService: getWikiService, searchService: getWikiSearchService }`),
 *     execute 调用时才解析 —— 避开 module-load 时序陷阱。
 */
export interface WikiV2ToolDeps {
	/** sub-02 WikiService —— expand/read/create/update/delete(link/unlink/move)/archive。 */
	readonly wikiService: WikiService | (() => WikiService | undefined);
	/** sub-04 WikiSearchService —— search action。 */
	readonly searchService: WikiSearchService | (() => WikiSearchService | undefined);
}

/** 内部:解析 deps 字段为实例(支持 instance / getter 两种形态)。 */
function resolveService<T>(dep: T | (() => T | undefined), label: string): T {
	const value = typeof dep === "function" ? (dep as () => T | undefined)() : dep;
	if (!value) {
		throw wikiError(
			"INTERNAL_ERROR",
			`Wiki v2 ${label} not registered (setWikiRuntime not called before Wiki tool invocation)`,
		);
	}
	return value;
}

/**
 * Factory:返回未注册的 ToolDefinition(由调用方决定如何挂载)。
 *
 * **plan-04 不在 ToolRegistry 注册**(plan-05 原子切换)。Plan-04 测试 host
 * 直接调 `tool.execute(input, callerCtx)` 或 `getToolExecute(tool)`。
 */
export function createWikiTool(deps: WikiV2ToolDeps) {
	const options: BuildToolOptions<typeof wikiV2ActionSchema> = {
		name: "Wiki", // 与旧工具同名 —— plan-05 注册时直接替换实现
		description: WIKI_V2_TOOL_DESCRIPTION,
		prompt: WIKI_V2_TOOL_PROMPT,
		meta: {
			category: "runtime",
			isReadOnly: false,
			isConcurrencySafe: false,
			isDestructive: false,
			exposable: true,
		},
		inputSchema: wikiV2ActionSchema,
		execute: async (input: WikiV2ActionInput, callerCtx: CallerCtx): Promise<ToolResult<WikiV2ToolData>> => {
			try {
				const ctx = buildRequestContext(callerCtx);
				// plan-05 §5: deps 可能是 getter 形态(注册时服务未实例化)。
				// 每次调用解析一次 —— 注册后 instance 路径只走函数分支一次,几乎零开销。
				const wikiService = resolveService(deps.wikiService, "wikiService");
				const searchService = resolveService(deps.searchService, "searchService");
				switch (input.action) {
					case "expand": {
						const req = buildExpandRequest(input);
						const result = await wikiService.expand(req, ctx);
						return { ok: true, data: result };
					}
					case "read": {
						const req = buildReadRequest(input);
						const result = await wikiService.read(req, ctx);
						return { ok: true, data: result };
					}
					case "search": {
						const req = buildSearchRequest(input);
						const result = await searchService.search(req, ctx);
						return { ok: true, data: result };
					}
					case "create": {
						const req = buildCreateRequest(input);
						const result = await wikiService.create(req, ctx);
						return { ok: true, data: result };
					}
					case "update": {
						const req = buildUpdateRequest(input);
						const result = await wikiService.update(req, ctx);
						return { ok: true, data: result };
					}
					case "delete": {
						const req = buildArchiveRequest(input);
						const result = await wikiService.archive(req, ctx);
						return { ok: true, data: result };
					}
					case "link": {
						const req = buildLinkRequest(input);
						const result = await wikiService.link(req, ctx);
						return { ok: true, data: result };
					}
					case "unlink": {
						const req = buildUnlinkRequest(input);
						const result = await wikiService.unlink(req, ctx);
						return { ok: true, data: result };
					}
					case "move": {
						const req = buildMoveRequest(input);
						const result = await wikiService.move(req, ctx);
						return { ok: true, data: result };
					}
				}
				// Unreachable — schema validates action enum.
				return {
					ok: false,
					error: `INVALID_REQUEST: unknown action`,
				};
			} catch (err) {
				return wikiErrorToToolResult(err);
			}
		},
		format: formatWikiV2Result,
	};
	return buildTool(options);
}

// ---------------------------------------------------------------------------
// Section 6 — Input shape → service request builders
// ---------------------------------------------------------------------------

function requireString(value: string | undefined, field: string, action: string): string {
	if (value === undefined || value === null || value.length === 0) {
		throw wikiError("INVALID_REQUEST", `${action}: '${field}' is required`);
	}
	return value;
}

function buildExpandRequest(input: WikiV2ActionInput): WikiExpandRequest {
	return {
		address: requireString(input.node, "node", "expand"),
		limit: input.limit ?? 50,
		cursor: input.cursor ?? null,
		includeLinks: input.includeLinks ?? false,
	};
}

function buildReadRequest(input: WikiV2ActionInput): WikiReadRequest {
	return {
		address: requireString(input.node, "node", "read"),
		view: input.view ?? "summary",
		section: input.section ?? null,
		sectionOccurrence: input.sectionOccurrence ?? null,
		sectionLevel: input.sectionLevel ?? null,
		lineStart: input.lineStart ?? null,
		lineEnd: input.lineEnd ?? null,
		sourceView: input.sourceView ?? null,
	};
}

function buildSearchRequest(input: WikiV2ActionInput): WikiSearchRequest {
	const query = requireString(input.query, "query", "search");
	// `target` 是 union(string for link/unlink, enum for search)。search action
	// 取 enum 解释;若 LLM 错传字符串,回退到默认 'wiki'。
	const rawTarget = input.target;
	const target: WikiSearchTarget =
		rawTarget === "wiki" || rawTarget === "source" || rawTarget === "both"
			? rawTarget
			: "wiki";
	return {
		mode: input.mode ?? "fulltext",
		target,
		query,
		fields: input.fields as WikiSearchField[] | undefined,
		caseSensitive: input.caseSensitive ?? false,
		kinds: input.kinds as WikiNodeKind[] | undefined,
		scope: input.scope ?? null,
		limit: input.limit ?? 20,
		cursor: input.cursor ?? null,
		sourceView: input.sourceView ?? null,
		fileGlobs: input.fileGlobs,
	};
}

function buildCreateRequest(input: WikiV2ActionInput): WikiCreateRequest {
	return {
		parent: requireString(input.parent, "parent", "create"),
		name: requireString(input.name, "name", "create"),
		kind: input.kind,
		summary: input.summary ?? "",
		content: input.content ?? "",
		attributes: (input.attributes as WikiNodeAttributes | undefined) ?? {},
		createdBy: input.createdBy ?? null,
	};
}

function buildUpdateRequest(input: WikiV2ActionInput): WikiUpdateRequest {
	if (input.expected_revision === undefined || input.expected_revision === null) {
		// 强制乐观并发(acceptance-04 §C「update 缺 expected_revision 被拒绝」)。
		throw wikiError("INVALID_REQUEST", "update: 'expected_revision' is required (optimistic concurrency)");
	}
	if (!input.changes && !input.operations) {
		throw wikiError("INVALID_REQUEST", "update: provide 'changes' (field patch) or 'operations' (content edits); both empty is a no-op");
	}
	return {
		address: requireString(input.node, "node", "update"),
		expected_revision: input.expected_revision,
		changes: input.changes as WikiUpdateFieldChanges | undefined,
		operations: input.operations as WikiEditOperation[] | undefined,
	};
}

function buildArchiveRequest(input: WikiV2ActionInput): WikiArchiveRequest {
	return {
		address: requireString(input.node, "node", "delete"),
		cascade: input.cascade ?? true,
	};
}

function buildLinkRequest(input: WikiV2ActionInput): WikiLinkRequest {
	return {
		source: requireString(input.source, "source", "link"),
		target: requireString(input.target, "target", "link"),
		relation: requireString(input.relation, "relation", "link"),
	};
}

function buildUnlinkRequest(input: WikiV2ActionInput): WikiUnlinkRequest {
	return {
		source: requireString(input.source, "source", "unlink"),
		target: requireString(input.target, "target", "unlink"),
		relation: requireString(input.relation, "relation", "unlink"),
	};
}

function buildMoveRequest(input: WikiV2ActionInput): WikiMoveRequest {
	return {
		address: requireString(input.node, "node", "move"),
		newParent: requireString(input.newParent, "newParent", "move"),
		newName: input.newName ?? input.name ?? null,
	};
}

// ---------------------------------------------------------------------------
// Section 7 — format() — ToolResult → compact Markdown for LLM
// ---------------------------------------------------------------------------

/**
 * format():把结构化 ToolResult 转紧凑 Markdown 喂 LLM。REST/UI 直接消费
 * JSON,**不**调 format(acceptance-04 §B「UI 可不经 format 消费完整字段」)。
 *
 * 每条 canonical path / 逻辑地址都可回灌 expand/read/search 解析。
 *
 * 注:签名匹配 BuildToolOptions.format((result: ToolResult) => string)。
 * 内部把 data 窄化到 WikiV2ToolData 联合(discriminate by shape)。
 */
export function formatWikiV2Result(result: ToolResult): string {
	if (!result.ok) {
		return result.error ?? "Wiki action failed.";
	}
	const data = result.data as WikiV2ToolData | undefined;
	if (!data) return "(no data)";
	// Discriminate by shape markers.
	if (isExpandResult(data)) return formatExpandResult(data);
	if (isReadResult(data)) return formatReadResult(data);
	if (isSearchResult(data)) return formatSearchResult(data);
	if (isMutationResult(data)) return formatMutationResult(data);
	return JSON.stringify(data);
}

function isExpandResult(d: WikiV2ToolData): d is WikiExpandResult {
	return typeof (d as WikiExpandResult).children !== "undefined";
}
function isReadResult(d: WikiV2ToolData): d is WikiReadResult {
	return typeof (d as WikiReadResult).node !== "undefined";
}
function isSearchResult(d: WikiV2ToolData): d is WikiSearchResult {
	return Array.isArray((d as WikiSearchResult).wikiHits)
		|| Array.isArray((d as WikiSearchResult).sourceHits);
}
function isMutationResult(d: WikiV2ToolData): d is WikiMutationResult {
	return typeof (d as WikiMutationResult).auditId !== "undefined";
}

function formatExpandResult(r: WikiExpandResult): string {
	const lines: string[] = [];
	lines.push(`# Wiki expand: ${r.path}`);
	lines.push(`**${r.displayTitle}** (${r.kind}) — revision ${r.auditId ? "" : ""}`.replace("revision ", `revision `));
	lines.push(`Summary: ${r.summary || "(empty)"}`);
	lines.push("");
	lines.push(`## Children (${r.children.items.length}${r.children.hasMore ? "+ more" : ""})`);
	if (r.children.items.length === 0) {
		lines.push("_(no visible children)_");
	} else {
		for (const c of r.children.items) {
			const counts = (c.outgoingCount !== undefined && c.incomingCount !== undefined)
				? ` [links:→${c.outgoingCount} ←${c.incomingCount}]`
				: "";
			const archiveMark = c.archived ? " (archived)" : "";
			lines.push(`- \`${c.path}\` — **${c.displayTitle}** (${c.kind}, r${c.revision})${counts}${archiveMark}`);
		}
	}
	if (r.children.hasMore) {
		lines.push("");
		lines.push(`_More children available — pass cursor to expand.limit/next page._`);
	}
	return lines.join("\n");
}

function formatReadResult(r: WikiReadResult): string {
	const lines: string[] = [];
	lines.push(`# Wiki read: ${r.path}`);
	lines.push(`**${r.node.displayTitle}** (${r.node.kind}, revision ${r.node.revision})`);
	lines.push(`Summary: ${r.node.summary || "(empty)"}`);
	if (r.content !== undefined) {
		lines.push("");
		lines.push("## Content");
		if (r.contentSlice) {
			const { startLine, endLine, totalLines } = r.contentSlice;
			const range = startLine !== null && endLine !== null
				? `lines ${startLine}-${endLine} of ${totalLines}`
				: `all ${totalLines} lines`;
			lines.push(`_(${range})_`);
		}
		lines.push(r.content || "(empty)");
	}
	if (r.links) {
		lines.push("");
		lines.push("## Links");
		if (r.links.outgoing.length === 0 && r.links.incoming.length === 0) {
			lines.push("_(no visible links)_");
		} else {
			if (r.links.outgoing.length > 0) {
				lines.push("**Outgoing:**");
				for (const l of r.links.outgoing) {
					lines.push(`- \`${l.sourcePath}\` —${l.relation}→ \`${l.targetPath}\``);
				}
			}
			if (r.links.incoming.length > 0) {
				lines.push("**Incoming:**");
				for (const l of r.links.incoming) {
					lines.push(`- \`${l.sourcePath}\` —${l.relation}→ \`${l.targetPath}\``);
				}
			}
		}
	}
	if (r.source) {
		lines.push("");
		lines.push("## Source");
		lines.push(`- repository: \`${r.source.repositoryId}\``);
		lines.push(`- source path: \`${r.source.sourcePath}\``);
		lines.push(`- indexed revision: \`${r.source.indexedRevision}\``);
		lines.push(`- sync status: \`${r.source.syncStatus}\``);
	}
	return lines.join("\n");
}

function formatSearchResult(r: WikiSearchResult): string {
	const lines: string[] = [];
	lines.push(`# Wiki search: mode=${r.mode} target=${r.target}${r.truncated ? " (truncated)" : ""}`);
	lines.push(`scope: ${r.effectiveScope ?? "(all authorized)"}`);
	lines.push("");
	if (r.wikiHits.length > 0) {
		lines.push(`## Wiki hits (${r.wikiHits.length})`);
		for (const h of r.wikiHits) {
			// plan-05 §5 defer concern C: 渲染 matchTypes 聚合证据。
			// 当 matchTypes 长度 ≥ 2 时,该节点同时被多种 matchType 命中 —— Agent
			// 只看 primary 会漏证据(例如 summary 含 substring + content FTS 命中)。
			// 在 primary 后用 `[also: type2, type3]` 形式补全(matchTypes 已按
			// 去重保证不含重复;顺序未规定)。长度 0/1 时不显示(等同 primary)。
			const primary = `${h.matchType}/${h.matchedField}`;
			const also = (h.matchTypes && h.matchTypes.length >= 2)
				? h.matchTypes
					.filter((t) => t !== h.matchType)
					.slice(0, 5)  // 安全上限:多于 5 个聚合意义不大,避免噪声
					.map((t) => String(t))
					.join(", ")
				: "";
			const matchInfo = also ? `${primary} [also: ${also}]` : primary;
			lines.push(`- \`${h.path}\` — **${h.displayTitle}** (${h.kind}, ${matchInfo}, score=${h.normalizedScore.toFixed(2)})`);
			if (h.snippet) {
				lines.push(`  > ${h.snippet.replace(/\n/g, " ").slice(0, 200)}`);
			}
		}
	}
	if (r.sourceHits.length > 0) {
		lines.push("");
		lines.push(`## Source hits (${r.sourceHits.length})`);
		for (const h of r.sourceHits) {
			lines.push(`- \`${h.path}:${h.line}:${h.columnStart}\` — ${h.matchType}/content, score=${h.normalizedScore.toFixed(2)}`);
			if (h.text) {
				lines.push(`  > ${h.text.replace(/\n/g, " ").slice(0, 200)}`);
			}
		}
	}
	if (r.wikiHits.length === 0 && r.sourceHits.length === 0) {
		lines.push("_(no matches in authorized scopes)_");
	}
	return lines.join("\n");
}

function formatMutationResult(r: WikiMutationResult): string {
	const lines: string[] = [];
	lines.push(`# Wiki mutation: ${r.path}`);
	lines.push(`- success: ${r.success ? "true" : "false"}`);
	lines.push(`- revision: ${r.revision}${r.oldRevision !== null ? ` (was ${r.oldRevision})` : ""}`);
	lines.push(`- audit receipt: \`${r.auditId}\``);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Section 8 — LLM-visible tool description + prompt(plan-04 §7)
// ---------------------------------------------------------------------------

/**
 * Wiki v2 工具的 LLM 描述(plan-04 §7 / design.md §8)。
 *
 * 约束:
 *   - 告知逻辑地址 + canonical path 寻址。
 *   - 推荐 search → expand → read 工作流。
 *   - 说明 update.expected_revision + source-managed 限制。
 *   - **不**解释内部 ID / 数据库 / anchor / 旧 doc actions。
 */
const WIKI_V2_TOOL_DESCRIPTION =
	"Operate on the unified Wiki tree (knowledge + memory + project semantic mirrors). " +
	"Use logical addresses (memory://, project://, runtime://) or canonical paths (wiki-root/...). " +
	"Recommended flow: search to locate, expand to see direct children, read to load content/links/source.";

/**
 * 完整 LLM prompt。覆盖 9 个 action 的语义 + 字段约束 + 工作流。
 */
const WIKI_V2_TOOL_PROMPT = [
	"Operate on the unified Wiki tree. Address nodes by **logical address** or **canonical path**:",
	"- `memory://`           → your long-term memory root (per-agent).",
	"- `memory://<rest>`     → descendant under your memory root.",
	"- `project://`          → active project semantic mirror root.",
	"- `project://<rest>`    → descendant under the project root (e.g. `project://src/tools`).",
	"- `runtime://...`       → administrator-registered alias (rare).",
	"- `wiki-root/...`       → canonical path (always works; shown in results).",
	"",
	"## Actions (9 total)",
	"",
	"**Locate / browse:**",
	"- `{action:'search', query, mode?, target?, fields?, scope?, limit?}` — unified search. `mode`: `fulltext` (default, FTS5), `exact`, `substring`, `glob` (segment-aware: `*`=no-segment, `**`=cross-segment, `?`=single char), `regex` (sandboxed worker, hard caps), `hybrid` (fuses exact+path+FTS+source). `target`: `wiki` (default), `source` (bound Git repo via ripgrep), `both`. `case_sensitive` defaults false (ASCII-only folding caveat for substring).",
	"- `{action:'expand', node, limit?, cursor?, includeLinks?}` — direct children (paged). Does NOT return child content. `includeLinks:true` adds visible link counts per child (filtered to caller's grants).",
	"- `{action:'read', node, view?, section?, lineStart?, lineEnd?, sourceView?}` — load node fields. `view`: `summary` (default), `content` (supports Markdown `section` + line range), `links` (visible outgoing/incoming), `all`, `source` (bound Git blob; `sourceView:'dirty'` reads workspace).",
	"",
	"**Mutate (require write grant on the affected scope):**",
	"- `{action:'create', parent, name, kind?, summary?, content?, attributes?}` — new node under `parent`. `kind` defaults to `node`. `attributes` holds display_name / memory_type / durability / etc.",
	"- `{action:'update', node, expected_revision, changes? and/or operations?}` — field patch + localized content edits. `expected_revision` is **required** (optimistic concurrency; mismatch returns WRITE_CONFLICT). Use `changes.summary/content/attributes` for field patches (`attributes=null` clears all; key=`null` clears that key) or `operations` for localized edits (`replace_text`, `insert_before/after`, `append/prepend`, `replace_section`, `append_to_section`, `delete_section`). No `overwrite=true` bypass — use `operations.replace_text` for targeted edits.",
	"- `{action:'delete', node, cascade?}` — archives the node (and subtree by default). Hard-delete is not exposed; source-bound nodes return SOURCE_MANAGED.",
	"- `{action:'link', source, target, relation}` — add a typed edge (`depends_on` / `used_by` / `contains` / `implements` / `tested_by` / `documented_by` / `derived_from` / `supersedes` / `related_to`). Target must be visible to caller (else NOT_FOUND — no existence leak).",
	"- `{action:'unlink', source, target, relation}` — remove edge.",
	"- `{action:'move', node, newParent, newName?}` — relocate subtree. Only the moved root bumps revision; descendants' paths update without revision change. Source-bound nodes return SOURCE_MANAGED.",
	"",
	"## Conventions",
	"- **Workflow**: `search` to locate candidates → `expand` to see direct children → `read` to load content/links/source. Avoid blind `read` of deep paths you haven't expanded.",
	"- **Identity / scope**: grants are host-injected (you cannot pass `agentId`/`projectId`/`grants`/`cwd` in the input). Unauthorized nodes appear as `NOT_FOUND` (no existence leak).",
	"- **Source-managed nodes** (project mirror files / directories): structural ops (create/move/delete) return `SOURCE_MANAGED`. You can still `update` their summary/content/attributes (semantic enrichment). To change structure, edit the underlying files and let the indexer re-sync on commit.",
	"- **Optimistic concurrency**: every `update` must carry the revision you observed. Stale revision → `WRITE_CONFLICT` (re-read and retry).",
	"- **Pagination**: `expand` and `search` return `cursor` + `hasMore`. Pass `cursor` on the next call; do not assume page size equals result count.",
	"- **Audit receipts**: mutations return an opaque `auditId` (operation receipt, not an internal id).",
].join("\n");

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
	AnyWikiRequestContext,
	CompiledWikiAccess,
	WikiRequestContext,
};
