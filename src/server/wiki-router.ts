// Wiki v2 浏览器 REST API 路由(wiki-system-redesign plan-06 §1)
//
// # 文件说明书
//
// ## 核心功能
// 暴露 wiki 浏览器所需的 10 个结构化 POST endpoint,薄 REST 适配层:
//
//   POST /api/wiki/expand
//   POST /api/wiki/read
//   POST /api/wiki/search
//   POST /api/wiki/create
//   POST /api/wiki/update
//   POST /api/wiki/delete      → 调 WikiService.archive(软删;hardDelete 是 plan-07)
//   POST /api/wiki/link
//   POST /api/wiki/unlink
//   POST /api/wiki/move
//   POST /api/wiki/history     → 调 WikiService.listHistory(节点 audit log;§D7)
//
// ## 关键不变量(plan-06 §1 / acceptance-06 §A/§H)
//   - **路径放 body,不用 /:nodeId**:canonical path / 逻辑地址是输入字段,
//     不在 URL 段里。
//   - **UI authority 由 server host 注入**:CompiledWikiAccess 在 server 内构造,
//     **不从 body 读**;body 里带 `callerCtx/grants/agentId/admin/global` 等
//     身份字段一律拒绝(acceptance-06 §A.2/§H)。
//   - **同一 service 实例**:通过 getWikiService / getWikiSearchService 取
//     runtime 单例,与 Agent Wiki v2 tool 同源,不复制业务逻辑。
//   - **结构化 result/error code**:成功返回 service 的 view 类型;失败返回
//     `{ ok: false, error: { code, message, path?, requestId? } }` + HTTP 400。
//
// ## 不做
//   - 不混管理面 API(hardDelete/restore/地址注册 = plan-07)。
//   - 不在 router 里实现业务逻辑;只做 schema 校验 + ctx 注入 + 调 service。
//   - 不接受伪造身份(body 里的 agentId/projectId/grants/callerCtx 一律忽略或拒)。
//
// 参见:
//   - docs/plan/wiki-system-redesign/plan-06-data-api-browser-ui.md §1
//   - docs/plan/wiki-system-redesign/acceptance-06-data-api-browser-ui.md §A

import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { resolve, relative, isAbsolute } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { ProjectStore } from "./project-store.js";
import type {
	CompiledWikiAccess,
	CompiledWikiGrant,
	WikiAction,
	WikiArchiveRequest,
	WikiAuditView,
	WikiCreateRequest,
	WikiExpandRequest,
	WikiLinkRequest,
	WikiMoveRequest,
	WikiReadRequest,
	WikiRequestContext,
	WikiUnlinkRequest,
	WikiUpdateRequest,
	WikiNodeAttributes,
	WikiNodeKind,
	WikiEditOperation,
} from "../shared/wiki-types.js";
import type {
	WikiSearchRequest,
} from "../shared/wiki-search-types.js";
import { getWikiService, getWikiSearchService } from "./wiki/wiki-runtime.js";
import { isWikiServiceError, type WikiServiceError } from "./wiki/wiki-errors.js";

// ---------------------------------------------------------------------------
// UI admin authority — server-injected, never read from request body
// ---------------------------------------------------------------------------

/**
 * Wiki 浏览器 UI 的 admin/data authority。**Server host 决定,renderer 不能扩大
 * 权限**(acceptance-06 §A.3 / §H「UI 不能传 global=true/admin=true 自授予」)。
 *
 * 此处显式构造一份覆盖 wiki-root 全树 + 9 个 data-plane action 的
 * CompiledWikiAccess;router 把它注入每次 WikiService 调用,与 renderer 输入无关。
 *
 * agentId 用占位 `"@ui-browser"`(memory:// 在 UI 上下文不应解析到真实 agent;
 * UI 不应通过 memory:// 触达任何 agent 的私有 memory 子树,只应通过 canonical
 * path 浏览)。
 */
const UI_ADMIN_GRANT: CompiledWikiGrant = {
	canonicalScope: "wiki-root",
	actions: [
		"expand", "read", "search",
		"create", "update", "delete",
		"link", "unlink", "move",
	],
};

const UI_ADMIN_ACCESS: CompiledWikiAccess = {
	agentId: "@ui-browser",
	activeProjectId: undefined,
	grants: [UI_ADMIN_GRANT],
	policyRevision: 1,
};

/**
 * 构造 Wiki UI 浏览器的请求上下文。每次调用新建(避免共享可变 requestId)。
 */
function buildUiCtx(): WikiRequestContext {
	return {
		access: UI_ADMIN_ACCESS,
		agentId: UI_ADMIN_ACCESS.agentId,
		activeProjectId: undefined,
		sessionId: null,
		requestId: null,
	};
}

// ---------------------------------------------------------------------------
// Forged-identity guard — body 必须不含身份/权限字段
// ---------------------------------------------------------------------------

/**
 * Body 里出现以下任一字段 → 拒绝(acceptance-06 §A.2 / §H)。这些字段是 host
 * 注入身份的载体,绝不能让 renderer 自报。`agentId` / `projectId` 在数据面
 * 契约里也无效(WikiRequestContext 由 host 构造)。
 */
const FORBIDDEN_BODY_KEYS = new Set([
	// 身份/权限字段(server-injected,不应出现在 input)
	"callerCtx", "grants", "access", "compiledAccess", "wikiAccess",
	"admin", "global", "is-admin", "isAdmin", "isGlobal",
	// Wiki service ctx 字段 + 身份同义词(server 注入,renderer 自报一律拒)
	"agentId", "actorAgentId", "sessionId", "requestId", "policyRevision",
	"projectId", "activeProjectId", "actor", "channel", "effectiveAccess",
	"targetId", "sourceId",
	// 旧 anchor / nodeId 字段(已退役)
	"nodeId", "anchorIds", "wikiAnchors", "wikiAnchorNodeIds",
]);

/**
 * Body 字段名 scan —— 含任一禁用 key 返 true。Zod refine 之前先走这一道,
 * 避免 zod 把禁用字段 silently strip 后又 pass through。
 */
function bodyHasForgedIdentity(raw: unknown): string[] {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
	const found: string[] = [];
	for (const key of Object.keys(raw as Record<string, unknown>)) {
		if (FORBIDDEN_BODY_KEYS.has(key)) found.push(key);
	}
	return found;
}

// ---------------------------------------------------------------------------
// Request schemas — 与 WikiService / WikiSearchService 入参同源
// ---------------------------------------------------------------------------

const addressField = z.string().min(1);
const kindSchema = z.enum([
	"root", "namespace", "project", "directory",
	"source_file", "source_symlink", "source_submodule",
	"knowledge", "memory", "node",
]);
const attributesSchema = z.record(z.string(), z.unknown());

const expandSchema = z.object({
	address: addressField,
	limit: z.number().int().positive().max(500).optional(),
	cursor: z.string().nullable().optional(),
	includeLinks: z.boolean().optional(),
});

const readSchema = z.object({
	address: addressField,
	view: z.enum(["summary", "content", "links", "all", "source"]).optional(),
	section: z.string().nullable().optional(),
	sectionOccurrence: z.number().int().positive().nullable().optional(),
	sectionLevel: z.number().int().positive().nullable().optional(),
	lineStart: z.number().int().positive().nullable().optional(),
	lineEnd: z.number().int().positive().nullable().optional(),
	sourceView: z.enum(["indexed", "dirty"]).nullable().optional(),
});

const searchSchema = z.object({
	mode: z.enum(["exact", "substring", "glob", "regex", "fulltext", "hybrid"]).optional(),
	target: z.enum(["wiki", "source", "both"]).optional(),
	query: z.string().min(1),
	fields: z.array(z.enum(["name", "path", "summary", "content"])).optional(),
	caseSensitive: z.boolean().optional(),
	kinds: z.array(kindSchema).optional(),
	scope: z.string().nullable().optional(),
	limit: z.number().int().positive().max(200).optional(),
	cursor: z.string().nullable().optional(),
	sourceView: z.enum(["indexed", "dirty"]).nullable().optional(),
	fileGlobs: z.array(z.string()).optional(),
});

const createSchema = z.object({
	parent: addressField,
	name: z.string().min(1),
	kind: kindSchema.optional(),
	summary: z.string().optional(),
	content: z.string().optional(),
	attributes: attributesSchema.optional(),
});

const updateChangesSchema = z.object({
	summary: z.string().optional(),
	content: z.string().optional(),
	attributes: attributesSchema.nullable().optional(),
});

const operationsSchema: z.ZodType<WikiEditOperation> = z.discriminatedUnion("op", [
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
]) as z.ZodType<WikiEditOperation>;

const updateSchema = z.object({
	address: addressField,
	expected_revision: z.number().int().positive(),
	changes: updateChangesSchema.optional(),
	operations: z.array(operationsSchema).optional(),
});

const deleteSchema = z.object({
	address: addressField,
	cascade: z.boolean().optional(),
});

const linkSchema = z.object({
	source: addressField,
	target: addressField,
	relation: z.string().min(1),
});

const unlinkSchema = z.object({
	source: addressField,
	target: addressField,
	relation: z.string().min(1),
});

const moveSchema = z.object({
	address: addressField,
	newParent: addressField,
	newName: z.string().nullable().optional(),
});

const historySchema = z.object({
	address: addressField,
	limit: z.number().int().positive().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Error → HTTP mapping
// ---------------------------------------------------------------------------

interface RestErrorBody {
	ok: false;
	error: {
		code: string;
		message: string;
		path?: string | null;
		requestId?: string | null;
	};
}

function mapWikiError(err: WikiServiceError): RestErrorBody {
	return {
		ok: false,
		error: {
			code: err.code,
			message: err.message,
			path: err.path,
			requestId: err.requestId,
		},
	};
}

/**
 * Router 工厂的 deps。`requireService=true` 时若 runtime 单例未注册立即抛
 * INTERNAL_ERROR(避免无谓 500 噪音)。
 */
function resolveServices() {
	const wikiService = getWikiService();
	const searchService = getWikiSearchService();
	if (!wikiService || !searchService) {
		return null;
	}
	return { wikiService, searchService };
}

/**
 * Build the 9 structured POST endpoints. Mounted under `/api/wiki` by
 * `src/server/index.ts`. Replaces the legacy `anchors` / `preview-injection` /
 * `list-by-anchors` / `nodes/:id/children` / `nodes/:id/detail` / `search`
 * anchor-based surface.
 *
 * Body fields only — no `:nodeId` path params. Server injects UI admin
 * authority; renderer cannot expand permissions via body fields
 * (`grants` / `callerCtx` / `admin` / `global` are rejected up front).
 */
export function createWikiBrowserRouter(): Router {
	const router = Router();

	/**
	 * 共用:校验 body + 拒绝伪造身份字段。失败 → 直接 res.json(400) 终止。
	 * 返回 zod-parsed body,或 null(已 res 终止)。
	 */
	function parseBody<T>(
		req: { body: unknown },
		res: { json: (body: unknown) => void; status: (code: number) => { json: (body: unknown) => void } },
		schema: z.ZodType<T>,
	): T | null {
		// 1. 拒绝伪造身份字段(acceptance-06 §A.2 / §H)。
		const forged = bodyHasForgedIdentity(req.body);
		if (forged.length > 0) {
			res.status(400).json({
				ok: false,
				error: {
					code: "INVALID_REQUEST",
					message: `forged identity field(s) rejected: ${forged.join(", ")}`,
				},
			} satisfies RestErrorBody);
			return null;
		}
		// 2. zod schema 校验。
		const parsed = schema.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json({
				ok: false,
				error: {
					code: "INVALID_REQUEST",
					message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
				},
			} satisfies RestErrorBody);
			return null;
		}
		return parsed.data;
	}

	/**
	 * 共用:执行 service 调用,捕获 WikiServiceError → 400 结构化 error。
	 */
	async function callService<T>(
		res: { json: (body: unknown) => void; status: (code: number) => { json: (body: unknown) => void } },
		fn: () => Promise<T>,
	): Promise<T | null> {
		try {
			return await fn();
		} catch (err) {
			if (isWikiServiceError(err)) {
				res.status(400).json(mapWikiError(err));
				return null;
			}
			res.status(500).json({
				ok: false,
				error: {
					code: "INTERNAL_ERROR",
					message: (err as Error)?.message ?? "internal error",
				},
			} satisfies RestErrorBody);
			return null;
		}
	}

	// ── POST /expand ─────────────────────────────────────────────────
	router.post("/expand", async (req, res) => {
		const services = resolveServices();
		if (!services) return res.status(503).json({ ok: false, error: { code: "INTERNAL_ERROR", message: "wiki runtime not ready" } });
		const body = parseBody(req, res, expandSchema);
		if (body === null) return;
		const reqInput: WikiExpandRequest = {
			address: body.address,
			limit: body.limit,
			cursor: body.cursor ?? null,
			includeLinks: body.includeLinks,
		};
		const result = await callService(res, () => services.wikiService.expand(reqInput, buildUiCtx()));
		if (result === null) return;
		res.json({ ok: true, result });
	});

	// ── POST /read ──────────────────────────────────────────────────
	router.post("/read", async (req, res) => {
		const services = resolveServices();
		if (!services) return res.status(503).json({ ok: false, error: { code: "INTERNAL_ERROR", message: "wiki runtime not ready" } });
		const body = parseBody(req, res, readSchema);
		if (body === null) return;
		const reqInput: WikiReadRequest = {
			address: body.address,
			view: body.view,
			section: body.section ?? null,
			sectionOccurrence: body.sectionOccurrence ?? null,
			sectionLevel: body.sectionLevel ?? null,
			lineStart: body.lineStart ?? null,
			lineEnd: body.lineEnd ?? null,
			sourceView: body.sourceView ?? null,
		};
		const result = await callService(res, () => services.wikiService.read(reqInput, buildUiCtx()));
		if (result === null) return;
		res.json({ ok: true, result });
	});

	// ── POST /search ────────────────────────────────────────────────
	router.post("/search", async (req, res) => {
		const services = resolveServices();
		if (!services) return res.status(503).json({ ok: false, error: { code: "INTERNAL_ERROR", message: "wiki runtime not ready" } });
		const body = parseBody(req, res, searchSchema);
		if (body === null) return;
		const reqInput: WikiSearchRequest = {
			mode: body.mode,
			target: body.target,
			query: body.query,
			fields: body.fields,
			caseSensitive: body.caseSensitive,
			kinds: body.kinds,
			scope: body.scope ?? null,
			limit: body.limit,
			cursor: body.cursor ?? null,
			sourceView: body.sourceView ?? null,
			fileGlobs: body.fileGlobs,
		};
		const result = await callService(res, () => services.searchService.search(reqInput, buildUiCtx()));
		if (result === null) return;
		res.json({ ok: true, result });
	});

	// ── POST /create ────────────────────────────────────────────────
	router.post("/create", async (req, res) => {
		const services = resolveServices();
		if (!services) return res.status(503).json({ ok: false, error: { code: "INTERNAL_ERROR", message: "wiki runtime not ready" } });
		const body = parseBody(req, res, createSchema);
		if (body === null) return;
		const reqInput: WikiCreateRequest = {
			parent: body.parent,
			name: body.name,
			kind: body.kind,
			summary: body.summary,
			content: body.content,
			attributes: body.attributes as WikiNodeAttributes | undefined,
		};
		const result = await callService(res, () => services.wikiService.create(reqInput, buildUiCtx()));
		if (result === null) return;
		emitWikiNodeChange("create", result.path, result.revision, undefined, undefined);
		res.json({ ok: true, result });
	});

	// ── POST /update ────────────────────────────────────────────────
	router.post("/update", async (req, res) => {
		const services = resolveServices();
		if (!services) return res.status(503).json({ ok: false, error: { code: "INTERNAL_ERROR", message: "wiki runtime not ready" } });
		const body = parseBody(req, res, updateSchema);
		if (body === null) return;
		const reqInput: WikiUpdateRequest = {
			address: body.address,
			expected_revision: body.expected_revision,
			changes: body.changes as never,
			operations: body.operations,
		};
		const result = await callService(res, () => services.wikiService.update(reqInput, buildUiCtx()));
		if (result === null) return;
		emitWikiNodeChange("update", result.path, result.revision, undefined, body.address);
		res.json({ ok: true, result });
	});

	// ── POST /delete (软删 = archive) ───────────────────────────────
	router.post("/delete", async (req, res) => {
		const services = resolveServices();
		if (!services) return res.status(503).json({ ok: false, error: { code: "INTERNAL_ERROR", message: "wiki runtime not ready" } });
		const body = parseBody(req, res, deleteSchema);
		if (body === null) return;
		const reqInput: WikiArchiveRequest = {
			address: body.address,
			cascade: body.cascade,
		};
		const result = await callService(res, () => services.wikiService.archive(reqInput, buildUiCtx()));
		if (result === null) return;
		emitWikiNodeChange("delete", result.path, result.revision, undefined, body.address);
		res.json({ ok: true, result });
	});

	// ── POST /link ──────────────────────────────────────────────────
	router.post("/link", async (req, res) => {
		const services = resolveServices();
		if (!services) return res.status(503).json({ ok: false, error: { code: "INTERNAL_ERROR", message: "wiki runtime not ready" } });
		const body = parseBody(req, res, linkSchema);
		if (body === null) return;
		const reqInput: WikiLinkRequest = {
			source: body.source,
			target: body.target,
			relation: body.relation,
		};
		const result = await callService(res, () => services.wikiService.link(reqInput, buildUiCtx()));
		if (result === null) return;
		emitWikiLinkChange("link", body.source, body.target, body.relation);
		res.json({ ok: true, result });
	});

	// ── POST /unlink ────────────────────────────────────────────────
	router.post("/unlink", async (req, res) => {
		const services = resolveServices();
		if (!services) return res.status(503).json({ ok: false, error: { code: "INTERNAL_ERROR", message: "wiki runtime not ready" } });
		const body = parseBody(req, res, unlinkSchema);
		if (body === null) return;
		const reqInput: WikiUnlinkRequest = {
			source: body.source,
			target: body.target,
			relation: body.relation,
		};
		const result = await callService(res, () => services.wikiService.unlink(reqInput, buildUiCtx()));
		if (result === null) return;
		emitWikiLinkChange("unlink", body.source, body.target, body.relation);
		res.json({ ok: true, result });
	});

	// ── POST /move ──────────────────────────────────────────────────
	router.post("/move", async (req, res) => {
		const services = resolveServices();
		if (!services) return res.status(503).json({ ok: false, error: { code: "INTERNAL_ERROR", message: "wiki runtime not ready" } });
		const body = parseBody(req, res, moveSchema);
		if (body === null) return;
		const reqInput: WikiMoveRequest = {
			address: body.address,
			newParent: body.newParent,
			newName: body.newName ?? null,
		};
		const result = await callService(res, () => services.wikiService.move(reqInput, buildUiCtx()));
		if (result === null) return;
		// move 既触发 wiki_nodes(oldPath delete / newPath create)又触发 wiki_sync
		// (subtree path rewrite)。前端 store 据此失效局部缓存。
		emitWikiNodeChange("move", result.path, result.revision, body.address, body.newParent);
		emitWikiSyncChange(result.path, body.address);
		res.json({ ok: true, result });
	});

	// ── POST /history (节点 audit log;§D7) ───────────────────────────
	// 只读;调 WikiService.listHistory。不 emit data:changed(纯查询,无 mutation)。
	router.post("/history", async (req, res) => {
		const services = resolveServices();
		if (!services) return res.status(503).json({ ok: false, error: { code: "INTERNAL_ERROR", message: "wiki runtime not ready" } });
		const body = parseBody(req, res, historySchema);
		if (body === null) return;
		const limit = body.limit ?? 100;
		const result = await callService(res, () => Promise.resolve(
			services.wikiService.listHistory(body.address, limit, buildUiCtx()),
		));
		if (result === null) return;
		res.json({ ok: true, result });
	});

	return router;
}

// ---------------------------------------------------------------------------
// data:changed emissions — plan-06 §7
// ---------------------------------------------------------------------------

/**
 * 把 wiki_nodes/wiki_links/wiki_sync collection 加入 data-change-hub 白名单后,
 * REST adapter 在每次 mutation 后 emit。collection 名稳定不变,renderer store
 * 只订阅这三个。
 *
 * 注意:WikiService 自身不调 emitDataChange(保持 service 层与 hub 解耦)。
 * plan-06 范围内只有 UI 浏览器 mutation 走此 emit 路径;Agent Wiki v2 tool
 * mutation 由 plan-07/08 cutover 决定如何 emit(可能走 tool dispatcher 包装层)。
 */
function emitWikiNodeChange(
	op: "create" | "update" | "delete" | "move",
	path: string,
	revision: number,
	oldPath: string | undefined,
	parentPath: string | undefined,
): void {
	// Lazy import 避免 wiki-router 在测试 / 静态分析阶段强绑 hub。
	// (data-change-hub 是 server 层单例,模块加载顺序未必先于 router。)
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { emitDataChange } = require("./data-change-hub.js") as typeof import("./data-change-hub.js");
		emitDataChange("wiki_nodes", path, op === "delete" ? "delete" : "update", {
			path,
			op,
			revision,
			oldPath: oldPath ?? null,
			parentPath: parentPath ?? null,
		});
		if (oldPath && op === "move") {
			// move 同时清掉旧 path(MoveFromCache)。emit 一条 delete 让前端清缓存。
			emitDataChange("wiki_nodes", oldPath, "delete", {
				path: oldPath,
				op: "move-source",
				revision: 0,
				oldPath: null,
				parentPath: null,
			});
		}
	} catch {
		// hub 模块缺失不应阻断 mutation 完成本身。
	}
}

function emitWikiLinkChange(
	op: "link" | "unlink",
	source: string,
	target: string,
	relation: string,
): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { emitDataChange } = require("./data-change-hub.js") as typeof import("./data-change-hub.js");
		const id = `${source}|${target}|${relation}`;
		emitDataChange("wiki_links", id, op === "unlink" ? "delete" : "update", {
			source, target, relation, op,
		});
	} catch {
		// ignore
	}
}

function emitWikiSyncChange(newPath: string, oldPath: string): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { emitDataChange } = require("./data-change-hub.js") as typeof import("./data-change-hub.js");
		emitDataChange("wiki_sync", newPath, "update", {
			path: newPath,
			oldPath,
			op: "move",
		});
	} catch {
		// ignore
	}
}

// ---------------------------------------------------------------------------
// Workspace-doc handler — project-scoped source read for view=source
// ---------------------------------------------------------------------------

/**
 * Build the workspace-doc handler. Mounted at
 * `GET /api/projects/:projectId/workspace-doc?relPath=<relPath>` (project-scoped,
 * NOT under /api/wiki — needs projectStore.get to resolve workspaceDir).
 *
 * Used by WikiDetail's Source tab to read the original workspace file (indexed
 * revision's source) under a strict sandbox: resolve + relative check rejects
 * `../` escapes. Returns { content } on success (truncated at 50k chars with a
 * marker), or { error } on missing project / missing workspaceDir / path escape
 * / file not found / read failure.
 */
export function createWorkspaceDocHandler(deps: { projectStore: ProjectStore }): RequestHandler {
	const { projectStore } = deps;
	return (req, res) => {
		try {
			const projectId = String(req.params.projectId);
			const relPath = req.query.relPath as string | undefined;
			if (!relPath) {
				res.status(400).json({ error: "relPath query parameter is required" });
				return;
			}
			const project = projectStore.get(projectId);
			if (!project) {
				res.status(404).json({ error: `project not found: ${projectId}` });
				return;
			}
			const workspaceDir = project.workspaceDir;
			if (!workspaceDir) {
				res.status(400).json({ error: "project has no workspaceDir" });
				return;
			}
			const abs = resolve(workspaceDir, relPath);
			const relCheck = relative(workspaceDir, abs);
			if (isAbsolute(relCheck) || relCheck.startsWith("..")) {
				res.status(400).json({ error: `path outside workspace: ${relPath}` });
				return;
			}
			if (!existsSync(abs)) {
				res.status(404).json({ error: `file not found: ${relPath}` });
				return;
			}
			try {
				const content = readFileSync(abs, "utf-8");
				const max = 50000;
				if (content.length <= max) {
					res.json({ content });
				} else {
					res.json({
						content: content.slice(0, max) + `\n\n[truncated: ${content.length} → ${max} chars]`,
					});
				}
			} catch (e) {
				res.status(500).json({ error: (e as Error).message });
			}
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	};
}

// ---------------------------------------------------------------------------
// Exported helper for tests / management path — shared UI admin access shape.
// ---------------------------------------------------------------------------

/**
 * 公开的 UI admin access 形状。plan-07 management UI 可复用(以 effectiveAccess
 * 字段塞到 WikiAdminRequestContext)。**不要**让 renderer 接触此对象。
 */
export const WIKI_UI_ADMIN_ACCESS: CompiledWikiAccess = UI_ADMIN_ACCESS;

/** 全部 9 个 data-plane action(plan-06 测试 / 文档用)。 */
export const WIKI_UI_ADMIN_ACTIONS: readonly WikiAction[] = UI_ADMIN_GRANT.actions;
