// WikiService —— 数据面 API + Memory lifecycle（wiki-system-redesign plan-02 §1 / §4 / §6）
//
// # 文件说明书
//
// ## 核心功能
// 公共数据面 service。固定 10 个 action(expand/read/create/update/archive/
// hardDelete/restore/link/unlink/move) + memory lifecycle helper。
//
// 每个写操作严格按 5 步:
//   1. 解析地址(用 WikiAddressService;**不**读节点正文)。
//   2. 授权 action(用 WikiAuthorizationService;**先于**节点存在性查询)。
//   3. 查询/校验目标。
//   4. 在 wikiDb.transaction(...) 内更新 node/link/FTS/audit(原子)。
//   5. 返回无内部 ID 的 view。
//
// ## 关键不变量（plan-02 §3 / §4 / acceptance-02 §A/§C/§G）
//   - **授权先于节点存在性查询**:无 grant 覆盖 → NOT_FOUND;scope 但无 action →
//     ACCESS_DENIED;action 但节点不存在 → NOT_FOUND（与第一种同外观）。
//   - **FTS transaction discipline**（sub-01 handoff）：所有节点写入都在
//     wikiDb.transaction(...) 内 + 显式 syncFtsInsert / syncFtsDelete + audit append。
//   - **revision 乐观并发**:update 必须带 expected_revision;mismatch → WRITE_CONFLICT。
//   - **move**:更新整棵子树 materialized path + 仅根 revision+1;links/addresses
//     target 不变;数据面 cap 10,000 节点 → MOVE_TOO_LARGE。
//   - **source-bound 节点** structural ops(create/move/delete) → SOURCE_MANAGED。
//   - **Memory lifecycle**:idempotent ensureAgentMemoryRoot + archiveAgentMemoryRoot。
//
// ## 不做
//   - 不写 grants 到 DB（design.md §7.1）。
//   - 不接 AgentRecord / session（plan-05）。
//   - 不实现 Project Git scan（plan-03）。
//   - 不注册 Wiki tool（plan-04）。
//   - 不在数据面 API 上暴露 address register/delete（管理面专属）。
//
// 参见:
//   - docs/plan/wiki-system-redesign/plan-02-core-service-address-auth.md
//   - docs/plan/wiki-system-redesign/design.md §6–§8

import type {
	AnyWikiRequestContext,
	CompiledWikiAccess,
	WikiAction,
	WikiAdminRequestContext,
	WikiArchiveRequest,
	WikiAuditView,
	WikiCreateRequest,
	WikiExpandChildItem,
	WikiExpandRequest,
	WikiExpandResult,
	WikiHardDeleteRequest,
	WikiLinkRequest,
	WikiLinkView,
	WikiMoveRequest,
	WikiMutationResult,
	WikiNodeAttributes,
	WikiNodeKind,
	WikiNodeView,
	WikiPageResult,
	WikiReadRequest,
	WikiReadResult,
	WikiRequestContext,
	WikiRestoreRequest,
	WikiUnlinkRequest,
	WikiUpdateRequest,
} from "../../shared/wiki-types.js";
import type { WikiDatabase } from "./wiki-database.js";
import {
	WikiNodeRepository,
	type WikiNodeRow,
} from "./wiki-node-repository.js";
import { WikiLinkRepository } from "./wiki-link-repository.js";
import { WikiAuditRepository, type WikiAuditRow } from "./wiki-audit-repository.js";
import {
	WikiRepositoryStore,
	type WikiAddressRow,
	type WikiRepositoryRow,
} from "./wiki-repository-store.js";
import {
	WikiAddressService,
	type WikiAddressContext,
	type WikiResolvedAddress,
} from "./wiki-address-service.js";
import {
	WikiAuthorizationService,
} from "./wiki-authorization-service.js";
import { WikiEditService } from "./wiki-edit-service.js";
import {
	WIKI_ROOT_PATH,
	isSameOrDescendant,
	isWikiRoot,
	joinWikiPath,
	lastSegmentOfWikiPath,
	normalizeWikiPath,
	parentWikiPath,
	validateWikiName,
} from "./wiki-path.js";
import { isWikiServiceError, wikiError, WikiServiceError } from "./wiki-errors.js";

/**
 * Agent data-plane move 节点上限(plan-02 §4)。超过 → MOVE_TOO_LARGE。
 * 管理/indexer 批量入口可绕过(WikiService 内部直接走 moveSubtreeInternal)。
 */
export const WIKI_MOVE_NODE_CAP = 10_000;

/**
 * 一个内部辅助:WikiService 注入依赖（便于测试 mock / 装饰）。
 */
export interface WikiServiceDeps {
	readonly wikiDb: WikiDatabase;
	readonly nodeRepo: WikiNodeRepository;
	readonly linkRepo: WikiLinkRepository;
	readonly auditRepo: WikiAuditRepository;
	readonly repositoryStore: WikiRepositoryStore;
	readonly addressService: WikiAddressService;
	readonly authorizationService: WikiAuthorizationService;
	readonly editService: WikiEditService;
}

/**
 * 把 {@link WikiAuditRow} 转为 {@link WikiAuditView}(snake_case → camelCase;
 * `detail_json` 反序列化为 `detail`)。失败的反序列化 → `detail = null`(与
 * wiki-audit-repository 的 "null/undefined → NULL" 写入语义对齐)。
 */
export function auditRowToView(row: WikiAuditRow): WikiAuditView {
	let detail: unknown = null;
	if (row.detail_json !== null && row.detail_json !== undefined) {
		try {
			detail = JSON.parse(row.detail_json);
		} catch {
			detail = null;
		}
	}
	return {
		auditId: row.audit_id,
		requestId: row.request_id,
		actorAgentId: row.actor_agent_id,
		sessionId: row.session_id,
		action: row.action,
		nodePath: row.node_path,
		oldRevision: row.old_revision,
		newRevision: row.new_revision,
		detail,
		createdAt: row.created_at,
	};
}

/**
 * 把 WikiNodeRow 转为 WikiNodeView(无内部 ID;acceptance-02 §C「不泄露 ID」)。
 */
export function nodeRowToView(row: WikiNodeRow): WikiNodeView {
	const attributes = parseAttributesJson(row.attributes_json);
	const displayTitle = attributes?.display_name ?? row.name;
	return {
		path: row.path,
		name: row.name,
		kind: row.kind as WikiNodeKind,
		summary: row.summary,
		revision: row.revision,
		parentPath: parentWikiPath(row.path),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		archivedAt: row.archived_at,
		attributes,
		sourceBound: false, // 由 service 层根据 wiki_source_bindings 决定(下面 enrich)
		displayTitle,
	};
}

/**
 * 解析 attributes_json。null/undefined/非法 JSON → 空对象。
 */
function parseAttributesJson(json: string | null): WikiNodeAttributes {
	if (json === null || json === undefined) return {};
	try {
		const parsed = JSON.parse(json);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as WikiNodeAttributes;
		}
	} catch {
		// fall through to default empty object
	}
	return {};
}

/**
 * Wiki Context compiler candidate(plan-05 §6 / round-2 review P1 §4)。
 *
 * 携带 compiler 的 `SubtreeNodeSnapshot` 所需的全字段 —— 直接从 wiki_nodes 行
 * + attributes_json 解析得出,**不再 per-node read**。由 {@link WikiService.listContextCandidates}
 * 单条 bounded SELECT + 单条 grouped COUNT 组装,把 candidate 选择 + attributes
 * + childrenCount 合并为常数次查询(消除 2× N+1 + 首 100 bias)。
 *
 * 字段语义与 compiler 旧路径(`read` + `countActiveChildren`)输出的字段一一对应,
 * 默认值(undefined / null)与旧 read-failed 路径一致 —— 旧 read 失败时
 * `updated_at=""` / 无 attributes / `review_after=null` / `childrenCount=0`;
 * 新路径 row 必然带 updated_at + JSON 解析后的 attributes,无 read 失败路径。
 */
export interface ContextCandidate {
	/** 规范路径(来自 row.path)。 */
	path: string;
	/** 最后一段 name(来自 row.name)。 */
	name: string;
	/** 短摘要(来自 row.summary)。 */
	summary: string;
	/** 当前 revision(整数,来自 row.revision)。 */
	revision: number;
	/** ISO updated_at(来自 row.updated_at)。 */
	updated_at: string;
	/** attributes.memory_type(未设 → undefined)。 */
	memory_type?: string;
	/** attributes.durability(未设 → undefined)。 */
	durability?: "permanent" | "long_term" | "short_term";
	/** attributes.confidence(非数字 → undefined)。 */
	confidence?: number;
	/** attributes.priority(非数字 → undefined)。 */
	priority?: number;
	/** attributes.review_after(ISO 字符串;未设 → null)。 */
	review_after: string | null;
	/** 该 candidate 的 active 直接 children 真实计数(单条 grouped 查询)。 */
	childrenCount: number;
}

/**
 * WikiService —— 数据面 API 主入口。
 */
export class WikiService {
	private readonly deps: WikiServiceDeps;

	constructor(deps: WikiServiceDeps) {
		this.deps = deps;
	}

	/**
	 * 从 WikiDatabase 单参构造,内部组装所有依赖。生产推荐此构造器。
	 */
	static fromDatabase(wikiDb: WikiDatabase): WikiService {
		const db = wikiDb.getDb();
		const nodeRepo = new WikiNodeRepository(db);
		const linkRepo = new WikiLinkRepository(db);
		const auditRepo = new WikiAuditRepository(db);
		const repositoryStore = new WikiRepositoryStore(db);
		const addressService = new WikiAddressService(repositoryStore.addresses, nodeRepo);
		const authorizationService = new WikiAuthorizationService();
		const editService = new WikiEditService();
		return new WikiService({
			wikiDb,
			nodeRepo,
			linkRepo,
			auditRepo,
			repositoryStore,
			addressService,
			authorizationService,
			editService,
		});
	}

	// =========================================================================
	// expand —— summary + 直接 children 分页
	// =========================================================================

	async expand(req: WikiExpandRequest, ctx: WikiRequestContext): Promise<WikiExpandResult> {
		const canonicalPath = this.resolveAddress(req.address, ctx);
		this.assertAgentAccess("expand", canonicalPath, ctx);

		const node = this.deps.nodeRepo.getActiveByPath(canonicalPath);
		if (!node) {
			throw wikiError("NOT_FOUND", `no accessible resource at ${canonicalPath}`);
		}
		const parentId = node.id;
		const limit = req.limit ?? 50;
		const cursor = decodeCursor(req.cursor ?? null);
		const page = this.deps.nodeRepo.getActiveChildrenPaged(parentId, limit, cursor);

		const items: WikiExpandChildItem[] = [];
		for (const child of page.items) {
			items.push(await this.toExpandChildItem(child, req.includeLinks ?? false, ctx));
		}

		const auditId = this.appendAuditSafe({
			requestId: ctx.requestId ?? null,
			actorAgentId: ctx.agentId,
			sessionId: ctx.sessionId ?? null,
			action: "expand",
			nodePath: canonicalPath,
			oldRevision: node.revision,
			newRevision: node.revision,
			detail: { origin: req.address, childCount: items.length },
		});

		return {
			path: canonicalPath,
			summary: node.summary,
			displayTitle: nodeRowToView(node).displayTitle,
			kind: node.kind as WikiNodeKind,
			children: {
				items,
				cursor: encodeCursor(page.cursor),
				hasMore: page.hasMore,
			},
			auditId,
		};
	}

	/**
	 * 数某节点的 active 直接 children 总数(plan-05 §6 wiki-context-compiler
	 * 需要 TRUE 直接子节点总数,stats `*NodesTotal` / `*Dropped` 才能真)。
	 *
	 * **授权纪律(与 expand 同模型)**:先解析地址 → assertAgentAccess("expand")
	 * → 再查节点 → 调 repo.countActiveChildren。失败外观与 expand 一致
	 * (无 grant → NOT_FOUND;scope 但无 action → ACCESS_DENIED)。
	 *
	 * **不写 audit**(read-only counting;与 expand 不同,expand 是 Agent 显式
	 * action 需 receipt,counting 是 compiler 内部副查询,写 audit 会污染历史)。
	 *
	 * 节点不存在 / 不可见 → 返回 0(与 NOT_FOUND 同外观,不泄露存在性)。
	 */
	countActiveChildren(address: string, ctx: WikiRequestContext): number {
		const canonicalPath = this.resolveAddress(address, ctx);
		this.assertAgentAccess("expand", canonicalPath, ctx);
		const node = this.deps.nodeRepo.getActiveByPath(canonicalPath);
		if (!node) return 0;
		return this.deps.nodeRepo.countActiveChildren(node.id);
	}

	/**
	 * SCAN CAP for {@link WikiService.listContextCandidates}:5000。足够让现实
	 * 子树(几百个直接 children)永不截断,只对 pathological parent(单 parent
	 * 下 > 5000 active children)才报 `selectionTruncated=true`。设计依据见
	 * plan-05 §6 / round-2 review P1 §4.3.7。
	 */
	static readonly LIST_CONTEXT_CANDIDATES_SCAN_CAP = 5000;

	/**
	 * 一次性取某 root 的全量 active 直接 children 作为 wiki-context-compiler 的
	 * candidate 集(plan-05 §6 / round-2 review P1 §4)。
	 *
	 * **为什么存在**:替代 compiler 之前的 `expand({limit:100})` + per-node
	 * `read()` + per-node `countActiveChildren()` 三段式。问题:
	 *   1. `expand({limit:100})` 按 path ASC 取首 100 → 第 101+ 的高价值节点
	 *      (如 `zzz-critical` priority=999)永远进不了 candidate 集,无论它多
	 *      重要、是否被 workContext 命中。compiler 的 filter→boost→sort 管道
	 *      在有偏的子集上跑,排序结果不可信。
	 *   2. 每个 candidate 一次 `read()` + 一次 `countActiveChildren()` → 2× N+1
	 *      查询。N=100 时单次编译 200+ SQL,session build latency 飙升。
	 *
	 * 本方法走单条 bounded SELECT(全字段)+ 单条 grouped COUNT,把 candidate
	 * 选择 + attributes + childrenCount 合并为常数次查询(1 + 1 + 1,与 N 无关)。
	 * candidate 集 = 全量 active 直接 children(由 {@link WikiService.LIST_CONTEXT_CANDIDATES_SCAN_CAP}
	 * 封顶),compiler 下游 filter→boost→sort 在无偏集合上跑,sort 结果可信。
	 *
	 * **授权纪律(与 expand/countActiveChildren 完全一致)**:先解析地址 →
	 * {@link assertAgentAccess}(`"expand"`)→ 再查节点 → 调 repo。授权失败抛
	 * (NOT_FOUND / ACCESS_DENIED);调用方(compiler)的 try/catch 把异常转为空
	 * snapshot,**绝不**泄露 total 或节点存在性 —— 与 `read` / `expand` 同外观。
	 *
	 * **不写 audit**(read-only candidate query;与 countActiveChildren 同模型 ——
	 * compiler 内部副查询,写 audit 会污染历史)。
	 *
	 * @param req.address root 地址(memory://、project://、wiki-root/...)。
	 * @param req.scanCap 可选 SCAN CAP;不传 → 默认 {@link WikiService.LIST_CONTEXT_CANDIDATES_SCAN_CAP}=5000。
	 * @param ctx 标准 WikiRequestContext(access 是唯一权威 grants 来源)。
	 * @returns `{ candidates, total, selectionTruncated }`:candidates 按行
	 *   (path ASC, id ASC) 排序;total = TRUE active 直接 children 总数;
	 *   selectionTruncated = total > candidates.length(pathological parent 才为真)。
	 *   root 不存在 / 无授权 → 走异常(调用方转空)。
	 */
	listContextCandidates(
		req: { address: string; scanCap?: number },
		ctx: WikiRequestContext,
	): {
		candidates: ContextCandidate[];
		total: number;
		selectionTruncated: boolean;
	} {
		const canonicalPath = this.resolveAddress(req.address, ctx);
		this.assertAgentAccess("expand", canonicalPath, ctx);
		const node = this.deps.nodeRepo.getActiveByPath(canonicalPath);
		if (!node) {
			throw wikiError("NOT_FOUND", `no accessible resource at ${canonicalPath}`);
		}
		const scanCap = req.scanCap ?? WikiService.LIST_CONTEXT_CANDIDATES_SCAN_CAP;
		const bounded = this.deps.nodeRepo.getActiveChildrenBounded(node.id, scanCap);
		// 单条 grouped COUNT 补齐所有 candidate 的 childrenCount(无 N+1)。
		const countMap = this.deps.nodeRepo.countChildrenByParents(
			bounded.rows.map((r) => r.id),
		);
		const candidates: ContextCandidate[] = bounded.rows.map((row) => {
			const attrs = parseAttributesJson(row.attributes_json);
			const priority = typeof attrs.priority === "number" ? attrs.priority : undefined;
			const confidence = typeof attrs.confidence === "number" ? attrs.confidence : undefined;
			const review_after = typeof attrs.review_after === "string" ? attrs.review_after : null;
			return {
				path: row.path,
				name: row.name,
				summary: row.summary,
				revision: row.revision,
				updated_at: row.updated_at,
				memory_type: attrs.memory_type,
				durability: attrs.durability,
				confidence,
				priority,
				review_after,
				childrenCount: countMap.get(row.id) ?? 0,
			};
		});
		return {
			candidates,
			total: bounded.total,
			selectionTruncated: bounded.truncated,
		};
	}

	/**
	 * 读 project 仓库绑定(branch / indexed_revision / sync_status / last_error /
	 * last_indexed_at)。plan-05 §6 wiki-context-compiler 在 Project 段渲染 binding
	 * status —— 通过 service 读取(而不是 caller 直接持 repositoryStore)以保持
	 * preview == runtime:runtime(AgentService)与 preview(wiki-admin-router)
	 * 都注入同一个 WikiService,二者调用本 accessor 得到字节级一致输出。
	 *
	 * 未绑定 → undefined(compiler 渲染 "(none)" empty state)。
	 */
	getRepositoryBinding(projectId: string): WikiRepositoryRow | undefined {
		return this.deps.repositoryStore.repositories.getByProjectId(projectId);
	}

	/**
	 * 数 active project 子树下 `source_stale=true` 的节点数(plan-05 §6 P1-5
	 * semantic-sync)。
	 *
	 * **定位**:**structure-sync vs semantic-sync** 区分(P1-5):
	 *   - `syncStatus`(structure)= Git tree / binding 是否已索引到 HEAD(indexer 管)。
	 *   - `source_stale` count(semantic)= 已索引的节点里,有多少 source 文件变了
	 *     但 summary/content 还没被 Archivist 重新充实。
	 * 一个项目可以 structure=synced 同时 semantic=stale(N 个 modify 等 enrichment)。
	 *
	 * **Layering(与 {@link getRepositoryBinding} 同模型)**:service-level accessor,
	 * 不接 ctx。理由:
	 *   1. status endpoint(`wiki-admin-router`)在 server host admin 上下文运行。
	 *   2. wiki-context-compiler 已通过 `getRepositoryBinding(projectId)` 无 ctx
	 *      读 binding 行(只在 `access.activeProjectId` 存在时调用,即 agent 已有
	 *      project grant,否则 activeProjectId 为 undefined 不会走到这里)。本计数是
	 *      同级 metadata(一个数字,不泄露节点正文),与 binding 同模型无 ctx。
	 *   3. 节点正文仍由 expand/read 的 grant 体系保护;这里只返 COUNT。
	 *
	 * **单一真相源**:status endpoint / Project Prompt / UI 都走本方法,不重复 SQL。
	 * 项目未绑定 / 根节点不存在 → 返回 0(与 getRepositoryBinding 返 undefined 同语义:
	 * 没有子树就没有 stale 节点)。
	 */
	countSourceStale(projectId: string): number {
		const projectRootPath = `${WIKI_ROOT_PATH}/projects/${projectId}`;
		const escaped = projectRootPath.replace(/[%_]/g, (c) => "\\" + c);
		try {
			return this.deps.nodeRepo.countSourceStaleUnder(escaped);
		} catch {
			// 与 safeGetRepositoryBinding 同兜底:DB 异常不阻塞 status/编译。
			return 0;
		}
	}

	// =========================================================================
	// read —— summary / content / links / all / source
	// =========================================================================

	async read(req: WikiReadRequest, ctx: WikiRequestContext): Promise<WikiReadResult> {
		const canonicalPath = this.resolveAddress(req.address, ctx);
		this.assertAgentAccess("read", canonicalPath, ctx);

		const node = this.deps.nodeRepo.getActiveByPath(canonicalPath);
		if (!node) {
			throw wikiError("NOT_FOUND", `no accessible resource at ${canonicalPath}`);
		}
		const view = nodeRowToView(node);
		const view1: WikiReadViewLite = req.view ?? "summary";

		const result: WikiReadResult = {
			path: canonicalPath,
			node: view,
			auditId: null,
		};

		if (view1 === "links" || view1 === "all") {
			const links = this.deps.linkRepo.both(node.id);
			const linkViews: WikiLinkView[] = links.outgoing
				.concat(links.incoming)
				.map((l) => linkRowToView(l, this.deps.nodeRepo));
			const filtered = this.deps.authorizationService.filterVisibleLinks(
				canonicalPath,
				linkViews,
				ctx.access,
			);
			result.links = {
				outgoing: filtered.outgoing,
				incoming: filtered.incoming,
			};
		}

		if (view1 === "content" || view1 === "all") {
			// section / lineStart-lineEnd 切片。
			let content = node.content;
			let startLine: number | null = null;
			let endLine: number | null = null;
			const totalLines = countLines(node.content);
			if (req.section) {
				const hit = this.deps.editService.findSectionPublic(
					node.content,
					req.section,
					req.sectionLevel ?? null,
					req.sectionOccurrence ?? null,
				);
				content = node.content.slice(hit.start, hit.end);
				startLine = offsetToLine(node.content, hit.start);
				endLine = offsetToLine(node.content, hit.end);
			} else if (req.lineStart !== null && req.lineStart !== undefined) {
				const s = lineToOffset(node.content, req.lineStart);
				const e = req.lineEnd !== null && req.lineEnd !== undefined
					? lineToOffset(node.content, req.lineEnd + 1)
					: node.content.length;
				content = node.content.slice(s, e);
				startLine = req.lineStart;
				endLine = req.lineEnd ?? null;
			}
			result.content = content;
			result.contentSlice = {
				startLine,
				endLine,
				totalLines,
			};
		}

		result.auditId = this.appendAuditSafe({
			requestId: ctx.requestId ?? null,
			actorAgentId: ctx.agentId,
			sessionId: ctx.sessionId ?? null,
			action: "read",
			nodePath: canonicalPath,
			oldRevision: node.revision,
			newRevision: node.revision,
			detail: { view: view1, address: req.address },
		});

		return result;
	}

	// =========================================================================
	// create —— 新建节点
	// =========================================================================

	async create(req: WikiCreateRequest, ctx: WikiRequestContext): Promise<WikiMutationResult> {
		const parentPath = this.resolveAddress(req.parent, ctx);
		this.assertAgentAccess("create", parentPath, ctx);

		validateWikiName(req.name);

		return this.deps.wikiDb.transaction(() => {
			const parent = this.deps.nodeRepo.getActiveByPath(parentPath);
			if (!parent) {
				throw wikiError("NOT_FOUND", `parent does not exist at ${parentPath}`);
			}
			// source-bound parent 拒绝普通 create（镜像结构由 indexer 维护）。
			if (this.isSourceBound(parent.id)) {
				throw wikiError(
					"SOURCE_MANAGED",
					`parent ${parentPath} is source-bound; structural create is reserved for indexer`,
				);
			}
			const newPath = joinWikiPath(parentPath, req.name);
			const existing = this.deps.nodeRepo.getActiveByPath(newPath);
			if (existing) {
				throw wikiError("ALREADY_EXISTS", `sibling already exists at ${newPath}`);
			}
			const kind: WikiNodeKind = req.kind ?? "node";
			const summary = req.summary ?? "";
			const content = req.content ?? "";
			const attributes = req.attributes ?? {};
			const attributesJson = JSON.stringify(attributes);

			const row = this.deps.nodeRepo.insert({
				parent_id: parent.id,
				name: req.name,
				path: newPath,
				kind,
				summary,
				content,
				attributes_json: attributesJson,
			});
			// FTS 同步(insert 不自动同步;acceptance-01 §A.11)。
			this.deps.nodeRepo.syncFtsInsert(row.id, row.name, row.summary, row.content);

			const audit = this.deps.auditRepo.append({
				requestId: ctx.requestId ?? null,
				actorAgentId: ctx.agentId,
				sessionId: ctx.sessionId ?? null,
				action: "create",
				nodePath: newPath,
				oldRevision: null,
				newRevision: row.revision,
				detail: { kind, parent: parentPath, name: req.name },
			});

			return {
				success: true,
				path: row.path,
				revision: row.revision,
				auditId: audit.auditId,
				oldRevision: null,
			};
		});
	}

	// =========================================================================
	// update —— 字段 patch + 局部正文编辑
	// =========================================================================

	async update(req: WikiUpdateRequest, ctx: WikiRequestContext): Promise<WikiMutationResult> {
		const canonicalPath = this.resolveAddress(req.address, ctx);
		this.assertAgentAccess("update", canonicalPath, ctx);

		return this.deps.wikiDb.transaction(() => {
			const node = this.deps.nodeRepo.getActiveByPath(canonicalPath);
			if (!node) {
				throw wikiError("NOT_FOUND", `no accessible resource at ${canonicalPath}`);
			}

			// 准备 patch 字段。
			const patch: {
				summary?: string;
				content?: string;
				attributes_json?: string | null;
			} = {};

			if (req.changes) {
				if (typeof req.changes.summary === "string") patch.summary = req.changes.summary;
				if (typeof req.changes.content === "string") patch.content = req.changes.content;
				if (req.changes.attributes !== undefined) {
					const currentAttrs = parseAttributesJson(node.attributes_json);
					const patched = applyAttributesPatch(
						currentAttrs,
						req.changes.attributes,
					);
					patch.attributes_json = JSON.stringify(patched);
				}
			}

			// 局部正文 ops:在当前 content 上叠加（在 transaction 内读+改+写）。
			if (req.operations && req.operations.length > 0) {
				const currentContent = patch.content ?? node.content;
				const newContent = this.deps.editService.applyOperations(currentContent, req.operations);
				patch.content = newContent;
			}

			// P1-5: 语义更新(summary / content 重新概括)→ 清除 source_stale /
			// source_stale_at。理由:source_stale 由 indexer 在 MODIFY change 时置位
			// (wiki-project-indexer.ts ~1093),意思是「source 文件变了,摘要可能过时,
			// 等 Archivist 重新充实」。一旦 summary/content 被 Archivist 或任何 agent
			// update(语义层 enrichment 完成),该节点就不再是 semantic stale —— 这里
			// 自动清位,让 status endpoint / Project Prompt 的 semanticStaleNodeCount 随
			// enrichment 进度 drain 到 0。仅 attributes patch(无 summary/content 改动)
			// 不触发清位 —— 例如 agent 显式标 attrs.confidence=low 不应误清 stale。
			//
			// 合并语义:若 caller 同时 patch 了 attributes,以已 patched 的 attributes 为
			// base 再清 stale(避免覆盖 caller 的 attributes 改动);无 stale 标志则不写
			// attributes_json(避免无谓写入 + revision 噪音)。
			if (patch.summary !== undefined || patch.content !== undefined) {
				const baseAttrs = patch.attributes_json !== undefined
					? parseAttributesJson(patch.attributes_json)
					: parseAttributesJson(node.attributes_json);
				if (baseAttrs.source_stale === true || baseAttrs.source_stale_at !== undefined) {
					delete baseAttrs.source_stale;
					delete baseAttrs.source_stale_at;
					patch.attributes_json = JSON.stringify(baseAttrs);
				}
			}

			// source-bound 节点(design §6.3 / plan-02 §4):
			//   - 允许 Agent 更新 summary/content/attributes(语义层 enrichment)。
			//   - 仅 STRUCTURAL 字段(parent_id/path/name/kind)变更是 indexer 专属,
			//     返回 SOURCE_MANAGED。
			// update() patch 当前只承载 summary/content/attributes_json,所以正常
			// 路径不会触发拒绝;此 guard 主要防御未来扩展 patch 字段时漏接 indexer 边界。
			if (this.isSourceBound(node.id)) {
				const STRUCTURAL_FIELDS = ["parent_id", "path", "name", "kind"] as const;
				const patchKeys = Object.keys(patch) as Array<keyof typeof patch>;
				const touchesStructural = patchKeys.some(
					(k) => (STRUCTURAL_FIELDS as readonly string[]).includes(k as string),
				);
				if (touchesStructural) {
					throw wikiError(
						"SOURCE_MANAGED",
						`node ${canonicalPath} is source-bound; structural update reserved for indexer`,
					);
				}
			}

			const oldRevision = node.revision;
			const updated = this.deps.nodeRepo.update(node.id, req.expected_revision, patch);
			// update() 已在内部完成 FTS sync（acceptance-01 §A.11）。

			const audit = this.deps.auditRepo.append({
				requestId: ctx.requestId ?? null,
				actorAgentId: ctx.agentId,
				sessionId: ctx.sessionId ?? null,
				action: "update",
				nodePath: updated.path,
				oldRevision,
				newRevision: updated.revision,
				detail: {
					address: req.address,
					fields: Object.keys(patch),
					operationCount: req.operations?.length ?? 0,
				},
			});

			return {
				success: true,
				path: updated.path,
				revision: updated.revision,
				auditId: audit.auditId,
				oldRevision,
			};
		});
	}

	// =========================================================================
	// archive —— 默认 delete 行为,级联整棵子树
	// =========================================================================

	async archive(req: WikiArchiveRequest, ctx: WikiRequestContext): Promise<WikiMutationResult> {
		const canonicalPath = this.resolveAddress(req.address, ctx);
		this.assertAgentAccess("delete", canonicalPath, ctx);

		const cascade = req.cascade ?? true;

		return this.deps.wikiDb.transaction(() => {
			const node = this.deps.nodeRepo.getActiveByPath(canonicalPath);
			if (!node) {
				throw wikiError("NOT_FOUND", `no accessible resource at ${canonicalPath}`);
			}
			if (this.isSourceBound(node.id)) {
				throw wikiError(
					"SOURCE_MANAGED",
					`node ${canonicalPath} is source-bound; archive reserved for indexer`,
				);
			}

			const oldRevision = node.revision;
			const archiveSubtree = cascade;
			const archivedIds: number[] = [node.id];
			if (archiveSubtree) {
				const subtree = this.collectSubtree(node.id);
				for (const id of subtree) {
					if (id === node.id) continue;
					archivedIds.push(id);
				}
			}
			for (const id of archivedIds) {
				this.deps.nodeRepo.archive(id);
			}

			const audit = this.deps.auditRepo.append({
				requestId: ctx.requestId ?? null,
				actorAgentId: ctx.agentId,
				sessionId: ctx.sessionId ?? null,
				action: "archive",
				nodePath: canonicalPath,
				oldRevision,
				newRevision: oldRevision,
				detail: { cascade: archiveSubtree, archivedNodeCount: archivedIds.length },
			});

			return {
				success: true,
				path: canonicalPath,
				revision: oldRevision,
				auditId: audit.auditId,
				oldRevision,
			};
		});
	}

	// =========================================================================
	// hardDelete —— 管理面;检查 child/incoming link/address/source binding
	// =========================================================================

	async hardDelete(req: WikiHardDeleteRequest, ctx: WikiAdminRequestContext): Promise<WikiMutationResult> {
		const canonicalPath = this.resolveAddressAdmin(req.address, ctx);
		const cascade = req.cascade ?? true;

		return this.deps.wikiDb.transaction(() => {
			const node = this.deps.nodeRepo.getByPath(canonicalPath);
			if (!node) {
				throw wikiError("NOT_FOUND", `node not found at ${canonicalPath}`);
			}

			// 检查 children（除非 cascade=true 且确定可以批量）。
			const children = this.deps.nodeRepo.getActiveChildren(node.id);
			if (children.length > 0 && !cascade) {
				throw wikiError(
					"HARD_DELETE_BLOCKED",
					`node ${canonicalPath} has ${children.length} active children; cascade=true required`,
				);
			}

			// 检查 incoming link（target_id = node.id）—— incoming 由 FK RESTRICT
			// 阻止;但我们要在 RESTRICT 抛 SQL 错前给出明确错误码。
			const incoming = this.deps.linkRepo.incoming(node.id);
			if (incoming.length > 0) {
				throw wikiError(
					"HARD_DELETE_BLOCKED",
					`node ${canonicalPath} is target of ${incoming.length} incoming links; unlink first`,
				);
			}

			// 检查 address 引用。
			const addresses = this.deps.repositoryStore.addresses.listByTargetId(node.id);
			if (addresses.length > 0) {
				throw wikiError(
					"HARD_DELETE_BLOCKED",
					`node ${canonicalPath} is referenced by ${addresses.length} static address(es); delete address first`,
				);
			}

			// 检查 source binding —— source-bound 节点硬删由 indexer 负责。
			if (this.isSourceBound(node.id)) {
				throw wikiError(
					"SOURCE_MANAGED",
					`node ${canonicalPath} is source-bound; hard-delete reserved for indexer`,
				);
			}

			// 收集整个子树（含归档）,按 child→parent 顺序删（避免 FK parent_id RESTRICT 报错）。
			const allIds = this.collectSubtreeAll(node.id);
			// children 在父之前删。
			allIds.sort((a, b) => b - a);
			// 校验:对每个非根（指非 node.id）的子节点,确认没有外部 incoming link。
			for (const id of allIds) {
				if (id === node.id) continue;
				const inc = this.deps.linkRepo.incoming(id);
				if (inc.length > 0) {
					throw wikiError(
						"HARD_DELETE_BLOCKED",
						`descendant id=${id} is target of incoming links; unlink first`,
					);
				}
				const addr = this.deps.repositoryStore.addresses.listByTargetId(id);
				if (addr.length > 0) {
					throw wikiError(
						"HARD_DELETE_BLOCKED",
						`descendant id=${id} is referenced by static address; delete address first`,
					);
				}
			}
			for (const id of allIds) {
				this.deps.nodeRepo.hardDelete(id);
			}

			const audit = this.deps.auditRepo.append({
				requestId: ctx.requestId ?? null,
				actorAgentId: ctx.actor,
				sessionId: ctx.sessionId ?? null,
				action: "hardDelete",
				nodePath: canonicalPath,
				oldRevision: node.revision,
				newRevision: null,
				detail: { cascade, deletedNodeCount: allIds.length, channel: ctx.channel },
			});

			return {
				success: true,
				path: canonicalPath,
				revision: 0,
				auditId: audit.auditId,
				oldRevision: node.revision,
			};
		});
	}

	// =========================================================================
	// restore —— 管理面;重新激活归档节点,检查 active 路径/sibling 冲突
	// =========================================================================

	async restore(req: WikiRestoreRequest, ctx: WikiAdminRequestContext): Promise<WikiMutationResult> {
		const canonicalPath = normalizeWikiPath(req.path);
		const cascade = req.cascade ?? true;

		return this.deps.wikiDb.transaction(() => {
			// 找归档节点（按 path + archived 非空）。
			const node = this.deps.nodeRepo.getByPath(canonicalPath);
			if (!node) {
				throw wikiError("NOT_FOUND", `no archived node at ${canonicalPath}`);
			}
			if (node.archived_at === null) {
				throw wikiError("INVALID_REQUEST", `node ${canonicalPath} is already active`);
			}
			if (this.isSourceBound(node.id)) {
				throw wikiError(
					"SOURCE_MANAGED",
					`node ${canonicalPath} is source-bound; restore reserved for indexer`,
				);
			}

			// 检查 active path 冲突（partial unique index 会 reject,但我们要给出
			// 明确错误码便于客户端区分）。
			const conflict = this.deps.nodeRepo.getActiveByPath(canonicalPath);
			if (conflict) {
				throw wikiError(
					"ALREADY_EXISTS",
					`active node already exists at ${canonicalPath}; cannot restore`,
				);
			}

			const idsToRestore: number[] = [node.id];
			if (cascade) {
				const subtree = this.collectSubtreeAll(node.id);
				for (const id of subtree) {
					if (id === node.id) continue;
					idsToRestore.push(id);
				}
			}
			// 检查每个要恢复的子节点的 active path 冲突。
			for (const id of idsToRestore) {
				const row = this.deps.nodeRepo.getById(id);
				if (!row || row.archived_at === null) continue;
				const c = this.deps.nodeRepo.getActiveByPath(row.path);
				if (c) {
					throw wikiError(
						"ALREADY_EXISTS",
						`active node already exists at ${row.path}; cannot restore subtree`,
					);
				}
			}

			for (const id of idsToRestore) {
				this.deps.nodeRepo.unarchive(id);
			}

			const audit = this.deps.auditRepo.append({
				requestId: ctx.requestId ?? null,
				actorAgentId: ctx.actor,
				sessionId: ctx.sessionId ?? null,
				action: "restore",
				nodePath: canonicalPath,
				oldRevision: node.revision,
				newRevision: node.revision,
				detail: { cascade, restoredNodeCount: idsToRestore.length, channel: ctx.channel },
			});

			return {
				success: true,
				path: canonicalPath,
				revision: node.revision,
				auditId: audit.auditId,
				oldRevision: node.revision,
			};
		});
	}

	// =========================================================================
	// link / unlink —— 写一条 wiki_links 记录;按 visibility 过滤对端
	// =========================================================================

	async link(req: WikiLinkRequest, ctx: WikiRequestContext): Promise<WikiMutationResult> {
		const sourcePath = this.resolveAddress(req.source, ctx);
		const targetPath = this.resolveAddress(req.target, ctx);
		// link action 检查 source;read 检查 target（design.md §8.8）。
		this.assertAgentAccess("link", sourcePath, ctx);
		if (!this.deps.authorizationService.canRead(targetPath, ctx.access)) {
			throw wikiError("NOT_FOUND", `no accessible resource at ${targetPath}`);
		}

		return this.deps.wikiDb.transaction(() => {
			const source = this.deps.nodeRepo.getActiveByPath(sourcePath);
			if (!source) {
				throw wikiError("NOT_FOUND", `no accessible resource at ${sourcePath}`);
			}
			const target = this.deps.nodeRepo.getActiveByPath(targetPath);
			if (!target) {
				throw wikiError("NOT_FOUND", `no accessible resource at ${targetPath}`);
			}
			// 重复 link 由 PK reject —— service 提前检查,返回 ALREADY_EXISTS（与 mutation
			// 外观一致,不泄露对端存在性）。
			if (this.deps.linkRepo.exists(source.id, target.id, req.relation)) {
				throw wikiError(
					"ALREADY_EXISTS",
					`link ${sourcePath} -> ${targetPath} (${req.relation}) already exists`,
				);
			}
			this.deps.linkRepo.insert({
				source_id: source.id,
				target_id: target.id,
				relation: req.relation,
				created_by: ctx.agentId,
			});
			const audit = this.deps.auditRepo.append({
				requestId: ctx.requestId ?? null,
				actorAgentId: ctx.agentId,
				sessionId: ctx.sessionId ?? null,
				action: "link",
				nodePath: sourcePath,
				oldRevision: source.revision,
				newRevision: source.revision,
				detail: { target: targetPath, relation: req.relation },
			});
			return {
				success: true,
				path: sourcePath,
				revision: source.revision,
				auditId: audit.auditId,
				oldRevision: source.revision,
			};
		});
	}

	async unlink(req: WikiUnlinkRequest, ctx: WikiRequestContext): Promise<WikiMutationResult> {
		const sourcePath = this.resolveAddress(req.source, ctx);
		const targetPath = this.resolveAddress(req.target, ctx);
		this.assertAgentAccess("unlink", sourcePath, ctx);
		if (!this.deps.authorizationService.canRead(targetPath, ctx.access)) {
			throw wikiError("NOT_FOUND", `no accessible resource at ${targetPath}`);
		}

		return this.deps.wikiDb.transaction(() => {
			const source = this.deps.nodeRepo.getActiveByPath(sourcePath);
			if (!source) {
				throw wikiError("NOT_FOUND", `no accessible resource at ${sourcePath}`);
			}
			const target = this.deps.nodeRepo.getActiveByPath(targetPath);
			if (!target) {
				throw wikiError("NOT_FOUND", `no accessible resource at ${targetPath}`);
			}
			const deleted = this.deps.linkRepo.delete(source.id, target.id, req.relation);
			if (!deleted) {
				throw wikiError(
					"NOT_FOUND",
					`link ${sourcePath} -> ${targetPath} (${req.relation}) not found`,
				);
			}
			const audit = this.deps.auditRepo.append({
				requestId: ctx.requestId ?? null,
				actorAgentId: ctx.agentId,
				sessionId: ctx.sessionId ?? null,
				action: "unlink",
				nodePath: sourcePath,
				oldRevision: source.revision,
				newRevision: source.revision,
				detail: { target: targetPath, relation: req.relation },
			});
			return {
				success: true,
				path: sourcePath,
				revision: source.revision,
				auditId: audit.auditId,
				oldRevision: source.revision,
			};
		});
	}

	// =========================================================================
	// move —— 更新子树 materialized path;仅根 revision+1;cap 10,000
	// =========================================================================

	async move(req: WikiMoveRequest, ctx: WikiRequestContext): Promise<WikiMutationResult> {
		const oldPath = this.resolveAddress(req.address, ctx);
		const newParentPath = this.resolveAddress(req.newParent, ctx);
		this.assertAgentAccess("move", oldPath, ctx);
		this.assertAgentAccess("create", newParentPath, ctx);

		const newName = req.newName ?? lastSegmentOfWikiPath(oldPath);
		validateWikiName(newName);
		const newPath = joinWikiPath(newParentPath, newName);

		if (oldPath === newPath) {
			throw wikiError("INVALID_REQUEST", `move: source and target are the same (${oldPath})`);
		}
		// 不能把自己移到自己的子树下(会形成环)。
		if (isSameOrDescendant(oldPath, newParentPath) || isSameOrDescendant(oldPath, newPath)) {
			throw wikiError(
				"INVALID_REQUEST",
				`move: cannot move ${oldPath} under its own subtree`,
			);
		}

		return this.deps.wikiDb.transaction(() => {
			const node = this.deps.nodeRepo.getActiveByPath(oldPath);
			if (!node) {
				throw wikiError("NOT_FOUND", `no accessible resource at ${oldPath}`);
			}
			if (this.isSourceBound(node.id)) {
				throw wikiError(
					"SOURCE_MANAGED",
					`node ${oldPath} is source-bound; move reserved for indexer`,
				);
			}
			const newParent = this.deps.nodeRepo.getActiveByPath(newParentPath);
			if (!newParent) {
				throw wikiError("NOT_FOUND", `new parent does not exist at ${newParentPath}`);
			}
			if (this.isSourceBound(newParent.id)) {
				throw wikiError(
					"SOURCE_MANAGED",
					`new parent ${newParentPath} is source-bound; cannot move into mirror subtree`,
				);
			}

			// 收集整棵子树（active + archived）—— materialized path 更新。
			const allRows = this.collectSubtreeRows(node.id);
			if (allRows.length > WIKI_MOVE_NODE_CAP) {
				throw wikiError(
					"MOVE_TOO_LARGE",
					`move ${oldPath} -> ${newPath}: subtree has ${allRows.length} nodes > cap ${WIKI_MOVE_NODE_CAP}`,
				);
			}

			// 检查目标路径不存在 active 占用。
			const conflict = this.deps.nodeRepo.getActiveByPath(newPath);
			if (conflict && conflict.id !== node.id) {
				throw wikiError(
					"ALREADY_EXISTS",
					`target path already occupied: ${newPath}`,
				);
			}

			// 仅根 revision +1;后代 path 派生更新,revision/updated_at 不变。
			const oldRevision = node.revision;
			const updatedRoot = this.deps.nodeRepo.update(node.id, oldRevision, {
				parent_id: newParent.id,
				path: newPath,
				name: newName,
			});
			// update() 已同步根节点 FTS（path/name 变更也需 resync index tokens）。

			// 后代:逐个 update path（不动 revision,绕开 update() 的 revision+1）。
			// 这里直接走 SQL（WikiNodeRepository.update 会 revision+1,不适合后代）。
			for (const row of allRows) {
				if (row.id === node.id) continue;
				if (!row.path.startsWith(oldPath + "/")) continue;
				const suffix = row.path.slice(oldPath.length);
				const newChildPath = newPath + suffix;
				this.deps.nodeRepo.updateChildPathOnly(row.id, newChildPath);
			}

			const audit = this.deps.auditRepo.append({
				requestId: ctx.requestId ?? null,
				actorAgentId: ctx.agentId,
				sessionId: ctx.sessionId ?? null,
				action: "move",
				nodePath: newPath,
				oldRevision,
				newRevision: updatedRoot.revision,
				detail: {
					oldPath,
					newPath,
					newParent: newParentPath,
					newName,
					subtreeNodeCount: allRows.length,
				},
			});

			return {
				success: true,
				path: newPath,
				revision: updatedRoot.revision,
				auditId: audit.auditId,
				oldRevision,
			};
		});
	}

	// =========================================================================
	// Memory lifecycle helper（plan-02 §6）
	// =========================================================================

	/**
	 * 幂等保证 Agent memory root 存在。多次调用:同一 stable agentId → 不动 path;
	 * displayName 变化 → 更新 attributes.display_name / summary,不改 path/name。
	 *
	 * 不自动创建 preferences/lessons 子树（plan-02 §6）。
	 */
	async ensureAgentMemoryRoot(agentId: string, displayName: string): Promise<WikiMutationResult> {
		validateWikiName(agentId);
		const memoryRootPath = joinWikiPath(joinWikiPath(WIKI_ROOT_PATH, "memory"), agentId);

		return this.deps.wikiDb.transaction(() => {
			const existing = this.deps.nodeRepo.getActiveByPath(memoryRootPath);
			if (existing) {
				// 幂等:不改 path/name;只更新 display_name / summary。
				const attrs = parseAttributesJson(existing.attributes_json);
				const nextSummary = displayName;
				const nextAttrs = { ...attrs, display_name: displayName };
				if (existing.summary === nextSummary && JSON.stringify(nextAttrs) === existing.attributes_json) {
					// 完全无变化 —— 不 bump revision,只 append audit receipt。
					const audit = this.deps.auditRepo.append({
						action: "ensureAgentMemoryRoot",
						nodePath: memoryRootPath,
						oldRevision: existing.revision,
						newRevision: existing.revision,
						detail: { agentId, displayName, noop: true },
					});
					return {
						success: true,
						path: memoryRootPath,
						revision: existing.revision,
						auditId: audit.auditId,
						oldRevision: existing.revision,
					};
				}
				const oldRevision = existing.revision;
				const updated = this.deps.nodeRepo.update(existing.id, oldRevision, {
					summary: nextSummary,
					attributes_json: JSON.stringify(nextAttrs),
				});
				const audit = this.deps.auditRepo.append({
					action: "ensureAgentMemoryRoot",
					nodePath: memoryRootPath,
					oldRevision,
					newRevision: updated.revision,
					detail: { agentId, displayName, updated: true },
				});
				return {
					success: true,
					path: memoryRootPath,
					revision: updated.revision,
					auditId: audit.auditId,
					oldRevision,
				};
			}

			// 新建 root:父为 wiki-root/memory。
			const parent = this.deps.nodeRepo.getActiveByPath(joinWikiPath(WIKI_ROOT_PATH, "memory"));
			if (!parent) {
				throw wikiError(
					"INTERNAL_ERROR",
					"missing fixed root wiki-root/memory; database bootstrap incomplete",
				);
			}
			const row = this.deps.nodeRepo.insert({
				parent_id: parent.id,
				name: agentId,
				path: memoryRootPath,
				kind: "memory",
				summary: displayName,
				content: "",
				attributes_json: JSON.stringify({ display_name: displayName }),
			});
			this.deps.nodeRepo.syncFtsInsert(row.id, row.name, row.summary, row.content);
			const audit = this.deps.auditRepo.append({
				action: "ensureAgentMemoryRoot",
				nodePath: memoryRootPath,
				oldRevision: null,
				newRevision: row.revision,
				detail: { agentId, displayName, created: true },
			});
			return {
				success: true,
				path: memoryRootPath,
				revision: row.revision,
				auditId: audit.auditId,
				oldRevision: null,
			};
		});
	}

	/**
	 * 归档 Agent memory root（不硬删;保留历史供审计）。
	 */
	async archiveAgentMemoryRoot(agentId: string): Promise<WikiMutationResult> {
		validateWikiName(agentId);
		const memoryRootPath = joinWikiPath(joinWikiPath(WIKI_ROOT_PATH, "memory"), agentId);

		return this.deps.wikiDb.transaction(() => {
			const node = this.deps.nodeRepo.getActiveByPath(memoryRootPath);
			if (!node) {
				// 已归档或从未存在 → 幂等返回（不报错）。
				const audit = this.deps.auditRepo.append({
					action: "archiveAgentMemoryRoot",
					nodePath: memoryRootPath,
					oldRevision: null,
					newRevision: null,
					detail: { agentId, noop: true },
				});
				return {
					success: true,
					path: memoryRootPath,
					revision: 0,
					auditId: audit.auditId,
					oldRevision: null,
				};
			}
			const oldRevision = node.revision;
			const ids = this.collectSubtree(node.id);
			for (const id of ids) {
				this.deps.nodeRepo.archive(id);
			}
			const audit = this.deps.auditRepo.append({
				action: "archiveAgentMemoryRoot",
				nodePath: memoryRootPath,
				oldRevision,
				newRevision: oldRevision,
				detail: { agentId, archivedNodeCount: ids.length },
			});
			return {
				success: true,
				path: memoryRootPath,
				revision: oldRevision,
				auditId: audit.auditId,
				oldRevision,
			};
		});
	}

	// =========================================================================
	// listHistory —— 节点 audit 历史(只读;plan-06 §6 History tab)
	// =========================================================================

	/**
	 * 列出某节点的 audit 历史(时间倒序)。委托**已有**的
	 * {@link WikiAuditRepository.listByNodePath}。
	 *
	 * **不 append audit**:与 expand/read 不同,history 是 meta-query
	 * (audit-of-audit)。为每次浏览历史再写一条 audit 行会污染真实历史,
	 * 让 History tab 永远显示 "listHistory" 噪音。读路径不写 audit 是合理的
	 * (管理面浏览日志不应改变日志本身)。
	 *
	 * 走 `read` action 授权(与 read 同级;UI-admin 的 wiki-root grant 自动通过)。
	 * 不校验节点存在性:对不存在节点返空数组(与 NOT_FOUND 外观一致,不泄露存在性
	 * 给无授权调用方)。已存在的节点 → 按授权后的 scope 查 audit log。
	 */
	listHistory(
		nodePath: string,
		limit: number,
		ctx: WikiRequestContext,
	): WikiAuditView[] {
		const canonicalPath = this.resolveAddress(nodePath, ctx);
		this.assertAgentAccess("read", canonicalPath, ctx);
		const rows = this.deps.auditRepo.listByNodePath(canonicalPath, limit);
		return rows.map(auditRowToView);
	}

	// =========================================================================
	// Internal helpers
	// =========================================================================

	/**
	 * 解析地址为 canonical path（数据面 ctx）。提前于授权与节点查询。
	 */
	private resolveAddress(address: string, ctx: WikiRequestContext): string {
		const resolved = this.deps.addressService.resolve(address, this.ctxToAddressCtx(ctx));
		return resolved.canonicalPath;
	}

	/**
	 * 解析地址（管理面 ctx）。管理面 ctx 没有 agentId/activeProjectId —— 不接受
	 * memory:// / project:// 动态地址;只接受 canonical path 或静态 alias。
	 */
	private resolveAddressAdmin(address: string, ctx: WikiAdminRequestContext): string {
		if (ctx.effectiveAccess) {
			const agentCtx: WikiAddressContext = {
				agentId: ctx.effectiveAccess.agentId,
				activeProjectId: ctx.effectiveAccess.activeProjectId,
			};
			return this.deps.addressService.resolve(address, agentCtx).canonicalPath;
		}
		// 无 effectiveAccess:只允许 canonical path 或静态 alias。
		const resolved = this.deps.addressService.resolve(address, {});
		return resolved.canonicalPath;
	}

	private ctxToAddressCtx(ctx: WikiRequestContext): WikiAddressContext {
		return {
			agentId: ctx.agentId,
			activeProjectId: ctx.activeProjectId,
		};
	}

	/**
	 * 授权断言:先于节点存在性查询。**关键不变量**（plan-02 §3 / acceptance-02 §C）。
	 *
	 * 失败外观:
	 *   - 无 grant 覆盖 → NOT_FOUND（与节点不存在同外观）
	 *   - scope 但无 action → ACCESS_DENIED
	 */
	private assertAgentAccess(action: WikiAction, canonicalPath: string, ctx: WikiRequestContext): void {
		this.deps.authorizationService.authorize(action, canonicalPath, ctx.access);
	}

	/**
	 * 判断节点是否 source-bound（绑定到 Git 镜像）。从 wiki_source_bindings 查。
	 */
	private isSourceBound(nodeId: number): boolean {
		return this.deps.repositoryStore.sourceBindings.getByNodeId(nodeId) !== undefined;
	}

	/**
	 * 收集 active 子树（不含归档）—— BFS,返回 id 列表（含 root）。
	 */
	private collectSubtree(rootId: number): number[] {
		const out: number[] = [];
		const queue: number[] = [rootId];
		while (queue.length > 0) {
			const id = queue.shift()!;
			out.push(id);
			const children = this.deps.nodeRepo.getActiveChildren(id);
			for (const c of children) queue.push(c.id);
		}
		return out;
	}

	/**
	 * 收集所有子树行（含归档）—— 用于 hardDelete / move。
	 */
	private collectSubtreeRows(rootId: number): WikiNodeRow[] {
		const out: WikiNodeRow[] = [];
		const root = this.deps.nodeRepo.getById(rootId);
		if (!root) return out;
		out.push(root);
		// 通过 path LIKE '<rootPath>/%' 一次性取所有后代（含归档）。
		const escapedPath = root.path.replace(/[%_]/g, (c) => "\\" + c);
		const all = this.deps.nodeRepo.getAllByPathPrefix(escapedPath);
		for (const row of all) {
			if (row.id === rootId) continue;
			out.push(row);
		}
		return out;
	}

	/**
	 * 收集所有子树 id（含归档）—— 用于 hardDelete。
	 */
	private collectSubtreeAll(rootId: number): number[] {
		return this.collectSubtreeRows(rootId).map((r) => r.id);
	}

	/**
	 * 给 expand 把 child row 转 view。includeLinks=true 时填计数。
	 *
	 * 关键不变量(acceptance-02 §C「不暗示数量」/design §C.5 read-links 防泄露):
	 *   - 计数必须经过 authorizationService.filterVisibleLinks 过滤,只反映对端
	 *     在 ctx.access 下可见的链接。直接返回 linkRepo.countBoth 的全量计数
	 *     会让 expand 成为 count-oracle:即使对端被 grant 切掉,也能从计数推断
	 *     存在性 —— 与 read links 的过滤纪律一致。
	 */
	private async toExpandChildItem(
		child: WikiNodeRow,
		includeLinks: boolean,
		ctx: WikiRequestContext,
	): Promise<WikiExpandChildItem> {
		const view = nodeRowToView(child);
		const item: WikiExpandChildItem = {
			path: child.path,
			name: child.name,
			kind: view.kind,
			summary: child.summary,
			revision: child.revision,
			displayTitle: view.displayTitle,
			archived: child.archived_at !== null,
		};
		if (includeLinks) {
			// 拉全量 outgoing/incoming link 行 → 转 view(path 形态)→ 过滤对端可见 →
			// 取过滤后长度作为计数。对端不可见的 link 既不出现在结果里,也不贡献计数。
			const both = this.deps.linkRepo.both(child.id);
			const linkViews: WikiLinkView[] = both.outgoing
				.concat(both.incoming)
				.map((l) => linkRowToView(l, this.deps.nodeRepo));
			const filtered = this.deps.authorizationService.filterVisibleLinks(
				child.path,
				linkViews,
				ctx.access,
			);
			item.outgoingCount = filtered.outgoing.length;
			item.incomingCount = filtered.incoming.length;
		}
		return item;
	}

	/**
	 * 安全 append audit —— 任何失败都吞掉并返回 null auditId（read-only action 不应
	 * 因为 audit 写失败而失败）。写 action 直接调 auditRepo.append（让失败回滚）。
	 */
	private appendAuditSafe(input: Parameters<WikiAuditRepository["append"]>[0]): string | null {
		try {
			return this.deps.auditRepo.append(input).auditId;
		} catch (err) {
			// 不报告详细错误给客户端（避免泄露内部状态）;记日志由调用方决定。
			void err;
			return null;
		}
	}
}

// ---------------------------------------------------------------------------
// View helpers + cursor 编解码
// ---------------------------------------------------------------------------

/**
 * 内部使用的 read view 别名（避免与 ctx 类型混淆）。
 */
type WikiReadViewLite = "summary" | "content" | "links" | "all" | "source";

/**
 * 把 WikiLinkRow（含整数 source_id/target_id）转为 WikiLinkView（含 canonical 路径）。
 * 节点不存在时（理论不应发生,FK RESTRICT 保证 target）→ path 用 `?` 占位。
 */
function linkRowToView(
	row: { source_id: number; target_id: number; relation: string; created_at: string; created_by: string | null },
	nodeRepo: WikiNodeRepository,
): WikiLinkView {
	const source = nodeRepo.getById(row.source_id);
	const target = nodeRepo.getById(row.target_id);
	return {
		relation: row.relation,
		sourcePath: source?.path ?? `?id=${row.source_id}`,
		targetPath: target?.path ?? `?id=${row.target_id}`,
		createdAt: row.created_at,
		createdBy: row.created_by,
	};
}

/**
 * cursor 编码:base64(JSON({path,id}))。null → null。
 */
function encodeCursor(cursor: { path: string; id: number } | null): string | null {
	if (cursor === null) return null;
	const json = JSON.stringify(cursor);
	return Buffer.from(json, "utf8").toString("base64");
}

/**
 * cursor 解码。null / 非法 → null。
 */
function decodeCursor(cursor: string | null): { path: string; id: number } | null {
	if (cursor === null) return null;
	try {
		const json = Buffer.from(cursor, "base64").toString("utf8");
		const parsed = JSON.parse(json) as { path: string; id: number };
		if (
			typeof parsed?.path === "string"
			&& typeof parsed?.id === "number"
		) {
			return { path: parsed.path, id: parsed.id };
		}
	} catch {
		// fall through
	}
	return null;
}

/**
 * 计算文本行数（\n 分隔;空文本为 0 行）。
 */
function countLines(text: string): number {
	if (text.length === 0) return 0;
	let n = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charAt(i) === "\n") n++;
	}
	if (text.endsWith("\n")) n--; // 末尾 \n 不算单独一行
	return n < 0 ? 0 : n;
}

/**
 * 1-based 行号 → 字节偏移。lineStart=1 → 0。lineStart=N → 第 N 行起始 offset。
 */
function lineToOffset(text: string, line: number): number {
	if (line <= 1) return 0;
	let currentLine = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charAt(i) === "\n") {
			currentLine++;
			if (currentLine === line) return i + 1;
		}
	}
	return text.length;
}

/**
 * 字节偏移 → 1-based 行号。
 */
function offsetToLine(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text.charAt(i) === "\n") line++;
	}
	return line;
}

/**
 * 字段级 attributes patch。null 删除 key,undefined 不动。
 */
function applyAttributesPatch(
	current: WikiNodeAttributes,
	patch: WikiNodeAttributes | null,
): WikiNodeAttributes {
	if (patch === null) return {};
	const next: WikiNodeAttributes = { ...current };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		if (v === null) {
			delete next[k];
		} else {
			next[k] = v;
		}
	}
	return next;
}

// 重新导出常用类型,供外部组装 service 用。
export type {
	WikiAddressContext,
	WikiResolvedAddress,
	WikiAddressRow,
	WikiServiceError,
};
export {
	WikiAddressService,
	WikiAuthorizationService,
	WikiEditService,
	isWikiServiceError,
	wikiError,
};
