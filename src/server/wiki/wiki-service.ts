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
import { WikiAuditRepository } from "./wiki-audit-repository.js";
import {
	WikiRepositoryStore,
	type WikiAddressRow,
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
