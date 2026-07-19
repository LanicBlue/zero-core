// Wiki v2 管理面 REST API 路由(wiki-system-redesign plan-07 §1–§7)
//
// # 文件说明书
//
// ## 核心功能
// 暴露 wiki 管理面所需的 4 大类 endpoint,薄 REST 适配层:
//
//   POST /api/wiki-admin/addresses/list
//   POST /api/wiki-admin/addresses/validate
//   POST /api/wiki-admin/addresses/impact
//   POST /api/wiki-admin/addresses/create
//   POST /api/wiki-admin/addresses/update
//   POST /api/wiki-admin/addresses/delete
//
//   POST /api/wiki-admin/repositories/list
//   POST /api/wiki-admin/repositories/validate
//   POST /api/wiki-admin/repositories/status
//   POST /api/wiki-admin/repositories/bind
//   POST /api/wiki-admin/repositories/update
//   POST /api/wiki-admin/repositories/unbind
//   POST /api/wiki-admin/repositories/reindex
//
//   POST /api/wiki-admin/grants/validate
//   POST /api/wiki-admin/grants/preview
//   POST /api/wiki-admin/grants/publish
//
//   POST /api/wiki-admin/context/validate
//   POST /api/wiki-admin/context/preview
//   POST /api/wiki-admin/context/publish
//
//   POST /api/wiki-admin/sessions/status
//
// ## 关键不变量(plan-07 §1 / acceptance-07 §A/§H)
//   - **authority 由 server host 注入**:`WIKI_ADMIN_AUTHORITY` 是模块级常量,
//     renderer 不能扩权;body 里出现身份字段(admin/actor/callerCtx/grants/
//     agentId/...)一律拒(FORBIDDEN_BODY_KEYS 同 wiki-router.ts 模式)。
//   - **validate / preview 无副作用**:不写 DB / audit / revision。
//   - **publish 用 expected policy revision**:AgentService.publishAgentWiki
//     Policy 做 CAS;不一致返 WRITE_CONFLICT。
//   - **mutation 后写管理审计 + revision +1**:audit action 命名
//     `address.create` / `address.update` / `address.delete` /
//     `repository.bind` / `repository.unbind` / `repository.reindex` /
//     `policy.publish.grants` / `policy.publish.context`。
//   - **不代理数据面 action**:不暴露 expand/read/search/create/update/
//     delete/link/unlink/move —— 那些在 wiki-router.ts。
//
// ## 不做
//   - 不实现业务逻辑;只做 schema 校验 + authority 注入 + 调 service。
//   - 不允许 body 声明 admin / actor / agentId(身份字段 server-injected)。
//   - 不暴露内部 DB 整数 ID(target_id / project_node_id / nodeId)。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-07-management-ui.md §1
//   - src/server/wiki-router.ts(同模式的数据面 router)

import { Router } from "express";
import { z } from "zod";
import type { AgentService } from "./agent-service.js";
import type { AgentStore } from "./agent-store.js";
import type { ProjectStore } from "./project-store.js";
import type { ArchivistGit } from "./archivist-git.js";
import type { WikiService } from "./wiki/wiki-service.js";
import type { WikiAddressService } from "./wiki/wiki-address-service.js";
import type { WikiProjectIndexer } from "./wiki/wiki-project-indexer.js";
import type { WikiRepositoryStore, WikiAddressRow, WikiRepositoryRow } from "./wiki/wiki-repository-store.js";
import type { WikiAuditRepository } from "./wiki/wiki-audit-repository.js";
import type { WikiNodeRepository } from "./wiki/wiki-node-repository.js";
import type { WikiGrant, WikiContextEntry } from "../shared/types.js";
import type {
	WikiAdminAuthority,
	WikiAdminResult,
	WikiAdminAddressView,
	AddressListResult,
	AddressUpsertInput,
	AddressValidateInput,
	AddressValidateResult,
	AddressImpactInput,
	AddressImpactResult,
	WikiAdminRepositoryView,
	RepositoryListResult,
	RepositoryBindInput,
	RepositoryUpdateInput,
	RepositoryValidateInput,
	RepositoryValidateResult,
	RepositoryReindexInput,
	RepositoryReindexResult,
	RepositoryStatusResult,
	GrantsValidateInput,
	GrantsValidateResult,
	GrantsPreviewInput,
	GrantsPreviewResult,
	GrantsPublishInput,
	GrantsPublishResult,
	ContextValidateInput,
	ContextValidateResult,
	ContextPreviewInput,
	ContextPreviewResult,
	ContextPublishInput,
	ContextPublishResult,
	SessionPublishStatusResult,
} from "../shared/wiki-admin-types.js";
import { compileWikiAccess } from "./wiki/wiki-access-compiler.js";
import { compileWikiContext } from "./wiki/wiki-context-compiler.js";
import { WIKI_ROOT_PATH } from "./wiki/wiki-path.js";
import { emitDataChange } from "./data-change-hub.js";

// ---------------------------------------------------------------------------
// Authority — server-injected, never from request body
// ---------------------------------------------------------------------------

/**
 * 管理面 authority。**server host 决定**,renderer 不能扩权(acceptance-07 §A
// .1 / §H)。常量注入每次调用;identity 字段永远不入 body schema。
 *
 * actor 用 `@wiki-admin`(管理 audit log 的 actor_agent_id 字段)。后续若要
 * 接入更细粒度管理员身份(Electron main 的 user / 多租户管理员),在 server
 * composition root 改这一个常量,renderer 仍不接触。
 */
const WIKI_ADMIN_AUTHORITY: WikiAdminAuthority = {
	actor: "@wiki-admin",
	canManage: true,
};

// ---------------------------------------------------------------------------
// Forged-identity guard — body 必须不含身份/权限字段
// ---------------------------------------------------------------------------

/**
 * Body 里出现以下任一字段 → 拒绝。**与数据面 wiki-router.ts 的
 * FORBIDDEN_BODY_KEYS 不同**(不要同步):数据面 grants/projectId 是 caller
 * 身份,正确禁止;管理面 grants/projectId/activeProjectId 是 **payload 内容**
 * (§3 GrantsPublishInput / repository schemas 顶层要这些),所以这里 **不禁**。
 * 两边都禁 admin/actor/authority/callerCtx 等真身份键;管理面额外禁 canManage
 * / target_id / project_node_id 等内部 ID。
 */
const FORBIDDEN_BODY_KEYS = new Set([
	// 身份/权限字段(server-injected,不应出现在 input)。
	// 注意:与数据面 wiki-router.ts 不同 —— 管理面 grants / projectId /
	// activeProjectId 是 **payload 内容**(§3 GrantsPublishInput 顶层要 grants;
	// 所有 repository schema 顶层要 projectId),不是 caller 身份。数据面
	// 这些键仍是 caller 身份,wiki-router.ts 的 FORBIDDEN_BODY_KEYS 正确禁止,
	// 两边隔离,不要同步。
	"callerCtx", "access", "compiledAccess", "wikiAccess",
	"admin", "global", "is-admin", "isAdmin", "isGlobal",
	"authority", "actor", "actorAgentId", "effectiveAccess", "canManage",
	// Wiki service ctx 字段 + 身份同义词
	"agentId", "sessionId", "requestId", "policyRevision",
	"channel", "targetId", "sourceId",
	// 旧 anchor / nodeId 字段(已退役)
	"nodeId", "anchorIds", "wikiAnchors", "wikiAnchorNodeIds",
	// 管理面专用:target_id / project_node_id 内部 ID 不允许从 body 进
	"target_id", "project_node_id", "targetId", "projectNodeId",
]);

function bodyHasForgedIdentity(raw: unknown): string[] {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
	const found: string[] = [];
	for (const key of Object.keys(raw as Record<string, unknown>)) {
		if (FORBIDDEN_BODY_KEYS.has(key)) found.push(key);
	}
	return found;
}

// ---------------------------------------------------------------------------
// Request schemas — zod-driven
// ---------------------------------------------------------------------------

const resolverSchema = z.enum(["current_agent_memory_root", "current_project_root"]).nullable().optional();
const scopeSchema = z.enum(["runtime", "static", "alias", "managed"]);

const addressUpsertSchema = z.object({
	address: z.string().min(1),
	scope: scopeSchema,
	kind: z.string().min(1),
	resolver: resolverSchema,
	targetPath: z.string().nullable().optional(),
	promptPolicy: z.string().nullable().optional(),
});

const addressValidateSchema = addressUpsertSchema;

const addressImpactSchema = z.object({
	address: z.string().min(1),
	targetPath: z.string().nullable().optional(),
	resolver: resolverSchema,
});

const addressUpdateSchema = z.object({
	address: z.string().min(1),
	patch: z.object({
		scope: scopeSchema.optional(),
		kind: z.string().min(1).optional(),
		resolver: resolverSchema,
		targetPath: z.string().nullable().optional(),
		promptPolicy: z.string().nullable().optional(),
	}),
});

const addressDeleteSchema = z.object({
	address: z.string().min(1),
});

const repositoryBindSchema = z.object({
	projectId: z.string().min(1),
	sourceRoot: z.string().optional(),
	defaultBranch: z.string().optional(),
});

const repositoryUpdateSchema = z.object({
	projectId: z.string().min(1),
	sourceRoot: z.string().optional(),
	defaultBranch: z.string().optional(),
});

const repositoryValidateSchema = z.object({
	projectId: z.string().min(1),
	sourceRoot: z.string().optional(),
});

const repositoryStatusSchema = z.object({
	projectId: z.string().min(1),
});

const repositoryUnbindSchema = z.object({
	projectId: z.string().min(1),
	/** 默认 soft(unbind binding + 停 sync,不删 Wiki 子树)。hard = 删子树。*/
	hard: z.boolean().optional(),
});

const repositoryReindexSchema = z.object({
	projectId: z.string().min(1),
	full: z.boolean().optional(),
	targetRevision: z.string().optional(),
});

const wikiActionEnum = z.enum([
	"expand", "read", "search", "create", "update", "delete", "link", "unlink", "move",
]);

const grantSchema = z.object({
	scope: z.string().min(1),
	actions: z.array(wikiActionEnum).min(1),
});

const grantsValidateSchema = z.object({
	grants: z.array(grantSchema),
});

const grantsPreviewSchema = grantsValidateSchema;

const grantsPublishSchema = z.object({
	grants: z.array(grantSchema),
	expectedRevision: z.number().int().nonnegative(),
	confirmRootWriteGrant: z.boolean().optional(),
});

const contextEntrySchema = z.object({
	address: z.string().min(1),
	profile: z.enum(["compact", "standard", "deep"]),
	channel: z.enum(["system", "off"]),
	budgetTokens: z.number().int().positive().optional(),
});

const contextValidateSchema = z.object({
	entries: z.array(contextEntrySchema),
	grants: z.array(grantSchema).optional(),
});

const contextPreviewSchema = contextValidateSchema;

const contextPublishSchema = z.object({
	entries: z.array(contextEntrySchema),
	expectedRevision: z.number().int().nonnegative(),
});

const sessionStatusSchema = z.object({});

// ---------------------------------------------------------------------------
// Error → HTTP mapping
// ---------------------------------------------------------------------------

interface RestErrorBody {
	ok: false;
	error: {
		code: string;
		message: string;
		currentRevision?: number;
		address?: string | null;
	};
}

function errorBody(code: string, message: string, extra?: { currentRevision?: number; address?: string | null }): RestErrorBody {
	return {
		ok: false,
		error: {
			code,
			message,
			...(extra?.currentRevision !== undefined ? { currentRevision: extra.currentRevision } : {}),
			...(extra?.address !== undefined ? { address: extra.address ?? null } : {}),
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers:agent context (host-injected, never from body)
// ---------------------------------------------------------------------------

/**
 * 路由 deps。server composition root 在 server/index.ts 注入。所有 service 句
 * 柄**与 runtime 单例同源**(getWikiService / 已 new 出来的 WikiAddressService
 * / WikiProjectIndexer / WikiRepositoryStore / WikiAuditRepository / WikiNode
 * Repository / ProjectStore / AgentService / AgentStore / ArchivistGit)。
 */
export interface WikiAdminRouterDeps {
	readonly wikiService: WikiService;
	readonly addressService: WikiAddressService;
	readonly indexer: WikiProjectIndexer;
	readonly repositoryStore: WikiRepositoryStore;
	readonly auditRepo: WikiAuditRepository;
	readonly nodeRepo: WikiNodeRepository;
	readonly projectStore: ProjectStore;
	readonly agentService: AgentService;
	readonly agentStore: AgentStore;
	readonly git: ArchivistGit;
}

/**
 * Build the management router. Mounted under `/api/wiki-admin` by
 * `src/server/index.ts`. Authority injected at server host; renderer cannot
 * touch identity fields.
 */
export function createWikiAdminRouter(deps: WikiAdminRouterDeps): Router {
	// 把 deps 暴露到模块级 DEPS_REF,供 computeAddressImpact / summarize 等模块
	// scope 工具函数访问。重入安全:idempotent overwrite;production 仅一次
	// 创建 router,测试每次 set。
	DEPS_REF = deps;
	const router = Router();

	/** 共用:forged-identity guard + zod parse。失败 → 400 终止。 */
	function parseBody<T>(
		req: { body: unknown },
		res: { json: (body: unknown) => void; status: (code: number) => { json: (body: unknown) => void } },
		schema: z.ZodType<T>,
	): T | null {
		const forged = bodyHasForgedIdentity(req.body);
		if (forged.length > 0) {
			res.status(400).json(errorBody(
				"INVALID_REQUEST",
				`forged identity field(s) rejected: ${forged.join(", ")}`,
			));
			return null;
		}
		const parsed = schema.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json(errorBody(
				"INVALID_REQUEST",
				parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
			));
			return null;
		}
		return parsed.data;
	}

	/** 共用:捕获 service / publish 错误,做 code 映射。 */
	async function callAdmin<T>(
		res: { json: (body: unknown) => void; status: (code: number) => { json: (body: unknown) => void } },
		fn: () => Promise<T> | T,
	): Promise<T | null> {
		try {
			return await fn();
		} catch (err) {
			const e = err as Error & { code?: string; currentRevision?: number };
			const code = e.code ?? "INTERNAL_ERROR";
			const status = code === "WRITE_CONFLICT" ? 409
				: code === "INVALID_REQUEST" || code === "INVALID_ADDRESS" || code === "ALREADY_EXISTS" || code === "NOT_FOUND" ? 400
				: 500;
			res.status(status).json(errorBody(code, e.message ?? "internal error", {
				currentRevision: e.currentRevision,
			}));
			return null;
		}
	}

	// =========================================================================
	// §2 — Addresses
	// =========================================================================

	/** 把 wiki_addresses 行 + 当前 node 状态 转 view(无内部 ID)。 */
	function addressRowToView(row: WikiAddressRow): WikiAdminAddressView {
		let targetCanonicalPath: string | null = null;
		let targetArchived = false;
		let targetMissing = false;
		if (row.target_id !== null) {
			const node = deps.nodeRepo.getById(row.target_id);
			if (!node) {
				targetMissing = true;
			} else {
				targetCanonicalPath = node.path;
				targetArchived = node.archived_at !== null;
			}
		}
		return {
			address: row.address,
			scope: row.scope as WikiAdminAddressView["scope"],
			kind: row.kind,
			resolver: row.resolver as WikiAdminAddressView["resolver"],
			targetCanonicalPath,
			targetArchived,
			targetMissing,
			promptPolicy: row.prompt_policy,
			revision: row.revision,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	router.post("/addresses/list", (_req, res) => {
		const rows = deps.repositoryStore.addresses.list();
		const result: AddressListResult = { addresses: rows.map(addressRowToView) };
		res.json({ ok: true, result } satisfies { ok: true; result: AddressListResult });
	});

	router.post("/addresses/validate", (req, res) => {
		const body = parseBody(req, res, addressValidateSchema);
		if (body === null) return;
		// 无副作用:只调 service.validate(不入库)。
		const input: AddressValidateInput = {
			address: body.address,
			scope: body.scope,
			kind: body.kind,
			resolver: body.resolver ?? null,
			targetPath: body.targetPath ?? null,
			promptPolicy: body.promptPolicy ?? null,
		};
		const v = deps.addressService.validate({
			address: input.address,
			scope: input.scope,
			kind: input.kind,
			resolver: input.resolver,
			targetPath: input.targetPath,
			promptPolicy: input.promptPolicy,
		});
		const result: AddressValidateResult = v.ok
			? { ok: true }
			: { ok: false, code: v.code, message: v.message };
		res.json({ ok: true, result } satisfies { ok: true; result: AddressValidateResult });
	});

	router.post("/addresses/impact", (req, res) => {
		const body = parseBody(req, res, addressImpactSchema);
		if (body === null) return;
		// 无副作用:扫 agent records + active sessions。
		const result = computeAddressImpact(body.address, body.targetPath ?? null, body.resolver ?? null);
		res.json({ ok: true, result } satisfies { ok: true; result: AddressImpactResult });
	});

	router.post("/addresses/create", async (req, res) => {
		const body = parseBody(req, res, addressUpsertSchema);
		if (body === null) return;
		const created = await callAdmin(res, () => {
			const input: AddressUpsertInput = {
				address: body.address,
				scope: body.scope,
				kind: body.kind,
				resolver: body.resolver ?? null,
				targetPath: body.targetPath ?? null,
				promptPolicy: body.promptPolicy ?? null,
			};
			const row = deps.addressService.register({
				address: input.address,
				scope: input.scope,
				kind: input.kind,
				resolver: input.resolver,
				targetPath: input.targetPath,
				promptPolicy: input.promptPolicy,
			});
			deps.auditRepo.append({
				action: "address.create",
				nodePath: input.targetPath ?? null,
				detail: { address: input.address, scope: input.scope, kind: input.kind, resolver: input.resolver, targetPath: input.targetPath },
				actorAgentId: WIKI_ADMIN_AUTHORITY.actor,
			});
			return row;
		});
		if (created === null) return;
		emitAdminAddressChange("create", created.address);
		res.json({ ok: true, result: { address: addressRowToView(created) } });
	});

	router.post("/addresses/update", async (req, res) => {
		const body = parseBody(req, res, addressUpdateSchema);
		if (body === null) return;
		const updated = await callAdmin(res, () => {
			const patch = body.patch;
			// WikiAddressService.update 的签名要求 scope/kind 必填,但 body 接受
			// partial patch;service body 实际上用 `?? existing` 兜底,接受
			// undefined。所以这里 cast 成 service 期望的 input shape。
			const row = deps.addressService.update(body.address, {
				scope: patch.scope as string,
				kind: patch.kind as string,
				resolver: patch.resolver ?? undefined,
				targetPath: patch.targetPath ?? undefined,
				promptPolicy: patch.promptPolicy ?? undefined,
			});
			deps.auditRepo.append({
				action: "address.update",
				nodePath: patch.targetPath ?? null,
				detail: { address: body.address, patch },
				actorAgentId: WIKI_ADMIN_AUTHORITY.actor,
			});
			return row;
		});
		if (updated === null) return;
		emitAdminAddressChange("update", updated.address);
		res.json({ ok: true, result: { address: addressRowToView(updated) } });
	});

	router.post("/addresses/delete", async (req, res) => {
		const body = parseBody(req, res, addressDeleteSchema);
		if (body === null) return;
		const removed = await callAdmin(res, () => {
			deps.addressService.delete(body.address);
			deps.auditRepo.append({
				action: "address.delete",
				nodePath: null,
				detail: { address: body.address },
				actorAgentId: WIKI_ADMIN_AUTHORITY.actor,
			});
			return { address: body.address };
		});
		if (removed === null) return;
		emitAdminAddressChange("delete", body.address);
		res.json({ ok: true, result: removed });
	});

	// =========================================================================
	// §5 — Repositories
	// =========================================================================

	async function repositoryRowToView(row: WikiRepositoryRow): Promise<WikiAdminRepositoryView> {
		const project = deps.projectStore.get(row.project_id);
		let headRevision: string | null = null;
		if (project?.workspaceDir) {
			try {
				headRevision = (await deps.git.resolveRevision(project.workspaceDir, "HEAD")) ?? null;
			} catch {
				headRevision = null;
			}
		}
		// P1-5: semantic-sync 计数来自 WikiService.countSourceStale(单一真相源,
		// 与 compiler 共用)。一条 COUNT,廉价。未绑定 / 无子树 → 0(fresh)。
		const semanticStaleNodeCount = deps.wikiService.countSourceStale(row.project_id);
		// round-2 review-fix P1 §5.5: project manifest 状态(单一真相源:
		// WikiService.getProjectManifestStatus → 读 project root attributes.manifest_status)。
		// 未绑定 / 无根 → "pending"。与 syncStatus / semanticSyncStatus 正交。
		const manifestStatus = deps.wikiService.getProjectManifestStatus(row.project_id);
		return {
			projectId: row.project_id,
			projectName: project?.name ?? row.project_id,
			repositoryId: row.repository_id,
			projectNodePath: `${WIKI_ROOT_PATH}/projects/${row.project_id}`,
			workspaceDir: project?.workspaceDir ?? "",
			sourceRoot: row.source_root,
			defaultBranch: row.default_branch,
			headRevision,
			indexedRevision: row.indexed_revision,
			syncStatus: (row.sync_status as WikiAdminRepositoryView["syncStatus"]) ?? "pending",
			lastError: row.last_error,
			lastIndexedAt: row.last_indexed_at,
			semanticStaleNodeCount,
			semanticSyncStatus: semanticStaleNodeCount > 0 ? "stale" : "fresh",
			manifestStatus,
		};
	}

	router.post("/repositories/list", async (_req, res) => {
		const rows = deps.repositoryStore.repositories.list();
		const views = await Promise.all(rows.map(repositoryRowToView));
		const result: RepositoryListResult = { repositories: views };
		res.json({ ok: true, result } satisfies { ok: true; result: RepositoryListResult });
	});

	router.post("/repositories/validate", async (req, res) => {
		const body = parseBody(req, res, repositoryValidateSchema);
		if (body === null) return;
		const result = await callAdmin(res, async (): Promise<RepositoryValidateResult> => {
			const project = deps.projectStore.get(body.projectId);
			if (!project) return { ok: false, code: "NOT_FOUND", message: `project not found: ${body.projectId}` };
			const isRepo = await deps.git.isGitRepo(project.workspaceDir);
			if (!isRepo) {
				return { ok: false, code: "INVALID_REQUEST", message: `workspaceDir is not a Git repository: ${project.workspaceDir}` };
			}
			const head = (await deps.git.resolveRevision(project.workspaceDir, "HEAD")) ?? null;
			const branch = await deps.git.detectDefaultBranch(project.workspaceDir);
			return {
				ok: true,
				workspaceDir: project.workspaceDir,
				defaultBranch: branch,
				headRevision: head,
			};
		});
		if (result === null) return;
		res.json({ ok: true, result });
	});

	router.post("/repositories/status", async (req, res) => {
		const body = parseBody(req, res, repositoryStatusSchema);
		if (body === null) return;
		const result = await callAdmin(res, async (): Promise<RepositoryStatusResult> => {
			const row = deps.repositoryStore.repositories.getByProjectId(body.projectId);
			if (!row) {
				const err = new Error(`repository not bound for project ${body.projectId}`);
				(err as Error & { code?: string }).code = "NOT_FOUND";
				throw err;
			}
			return await repositoryRowToView(row);
		});
		if (result === null) return;
		res.json({ ok: true, result });
	});

	router.post("/repositories/bind", async (req, res) => {
		const body = parseBody(req, res, repositoryBindSchema);
		if (body === null) return;
		const result = await callAdmin(res, async (): Promise<RepositoryReindexResult> => {
			const binding = await deps.indexer.ensureBinding(body.projectId, {
				sourceRoot: body.sourceRoot,
				defaultBranch: body.defaultBranch,
			});
			if (!binding.bound) {
				return {
					projectId: body.projectId,
					repositoryId: binding.repositoryId,
					ok: false,
					indexedRevision: null,
					error: binding.error,
					syncStatus: "failed",
				};
			}
			deps.auditRepo.append({
				action: "repository.bind",
				nodePath: binding.projectNodePath,
				detail: { projectId: body.projectId, repositoryId: binding.repositoryId, sourceRoot: binding.sourceRoot, defaultBranch: binding.defaultBranch },
				actorAgentId: WIKI_ADMIN_AUTHORITY.actor,
			});
			emitAdminRepositoryChange("bind", body.projectId);
			// 初次 bind 后 kick off 首次 fullIndex(非阻塞)。
			void deps.indexer.fullIndex(body.projectId).then((r) => {
				emitAdminRepositoryChange(r.ok ? "synced" : "failed", body.projectId);
			}).catch(() => {
				emitAdminRepositoryChange("failed", body.projectId);
			});
			return {
				projectId: body.projectId,
				repositoryId: binding.repositoryId,
				ok: true,
				indexedRevision: null,
				syncStatus: "pending",
			};
		});
		if (result === null) return;
		res.json({ ok: true, result });
	});

	router.post("/repositories/update", async (req, res) => {
		const body = parseBody(req, res, repositoryUpdateSchema);
		if (body === null) return;
		const result = await callAdmin(res, async () => {
			const existing = deps.repositoryStore.repositories.getByProjectId(body.projectId);
			if (!existing) {
				const err = new Error(`repository not bound for project ${body.projectId}`);
				(err as Error & { code?: string }).code = "NOT_FOUND";
				throw err;
			}
			// WikiRepositoryTable 不支持改 source_root/default_branch via
			// updateSyncState;走 upsert(保留 indexed_revision/sync_status 等)。
			deps.repositoryStore.repositories.upsert({
				repository_id: existing.repository_id,
				project_node_id: existing.project_node_id,
				project_id: existing.project_id,
				source_root: body.sourceRoot ?? existing.source_root,
				default_branch: body.defaultBranch ?? existing.default_branch,
			});
			deps.auditRepo.append({
				action: "repository.update",
				nodePath: `${WIKI_ROOT_PATH}/projects/${body.projectId}`,
				detail: { projectId: body.projectId, patch: body },
				actorAgentId: WIKI_ADMIN_AUTHORITY.actor,
			});
			const row = deps.repositoryStore.repositories.getByProjectId(body.projectId)!;
			emitAdminRepositoryChange("update", body.projectId);
			return await repositoryRowToView(row);
		});
		if (result === null) return;
		res.json({ ok: true, result });
	});

	router.post("/repositories/unbind", async (req, res) => {
		const body = parseBody(req, res, repositoryUnbindSchema);
		if (body === null) return;
		const result = await callAdmin(res, async () => {
			const existing = deps.repositoryStore.repositories.getByProjectId(body.projectId);
			if (!existing) return { projectId: body.projectId, unbound: false };
			// soft:只删 binding(repository+source_bindings CASCADE);Wiki 子树保留。
			// hard:rebuildFromScratch 会归档 source-bound 子树 + 删 binding。
			if (body.hard) {
				await deps.indexer.rebuildFromScratch(body.projectId);
				// rebuildFromScratch 会立即 fullIndex 重建 —— 再删 binding 让它
				// 停在「无 binding」状态(用户要求 hard unbind 即彻底解绑)。
				const afterRebuild = deps.repositoryStore.repositories.getByProjectId(body.projectId);
				if (afterRebuild) {
					deps.repositoryStore.repositories.delete(afterRebuild.repository_id);
				}
			} else {
				deps.repositoryStore.repositories.delete(existing.repository_id);
			}
			deps.auditRepo.append({
				action: "repository.unbind",
				nodePath: `${WIKI_ROOT_PATH}/projects/${body.projectId}`,
				detail: { projectId: body.projectId, hard: !!body.hard },
				actorAgentId: WIKI_ADMIN_AUTHORITY.actor,
			});
			emitAdminRepositoryChange("unbind", body.projectId);
			return { projectId: body.projectId, unbound: true, hard: !!body.hard };
		});
		if (result === null) return;
		res.json({ ok: true, result });
	});

	router.post("/repositories/reindex", async (req, res) => {
		const body = parseBody(req, res, repositoryReindexSchema);
		if (body === null) return;
		// reindex 可能跑数秒(~百文件)。**先 emit indexing 让 UI 立即看到状态,
		// 然后再 await full/sync**。response 等到完成才返回——但 server job 独立
		// 运行(即便客户端关闭页面也不取消;service 在 server 进程内同步跑)。
		emitAdminRepositoryChange("indexing", body.projectId);
		const result = await callAdmin(res, async (): Promise<RepositoryReindexResult> => {
			if (body.full) {
				const r = await deps.indexer.rebuildFromScratch(body.projectId);
				deps.auditRepo.append({
					action: "repository.reindex",
					nodePath: `${WIKI_ROOT_PATH}/projects/${body.projectId}`,
					detail: { projectId: body.projectId, full: true, ok: r.ok, indexedRevision: r.indexedRevision, error: r.error },
					actorAgentId: WIKI_ADMIN_AUTHORITY.actor,
				});
				emitAdminRepositoryChange(r.ok ? "synced" : "failed", body.projectId);
				return {
					projectId: body.projectId,
					repositoryId: r.repositoryId,
					ok: r.ok,
					indexedRevision: r.indexedRevision,
					error: r.error,
					syncStatus: r.ok ? "synced" : "failed",
				};
			}
			const r = await deps.indexer.sync(body.projectId, body.targetRevision ? { targetRevision: body.targetRevision } : undefined);
			deps.auditRepo.append({
				action: "repository.reindex",
				nodePath: `${WIKI_ROOT_PATH}/projects/${body.projectId}`,
				detail: {
					projectId: body.projectId, full: false,
					from: r.fromRevision, to: r.toRevision, ok: r.syncStatus !== "failed",
					stats: r.stats, error: r.error,
				},
				actorAgentId: WIKI_ADMIN_AUTHORITY.actor,
			});
			emitAdminRepositoryChange(r.syncStatus === "failed" ? "failed" : "synced", body.projectId);
			return {
				projectId: body.projectId,
				repositoryId: r.repositoryId,
				ok: r.syncStatus !== "failed",
				indexedRevision: r.toRevision,
				error: r.error,
				syncStatus: r.syncStatus,
			};
		});
		if (result === null) return;
		res.json({ ok: true, result });
	});

	// =========================================================================
	// §3 — Grants(validate / preview / publish)
	// =========================================================================

	/** 从 body + agent record 拼编译输入;agentId 来自 agentStore(server-side)。 */
	function resolveAgentContext(agentId: string): {
		agentId: string;
		activeProjectId?: string;
		wikiPolicyRevision: number;
		existingGrants: WikiGrant[];
		existingContext: WikiContextEntry[];
	} {
		const agent = deps.agentStore.get(agentId);
		const rev = typeof agent?.wikiPolicyRevision === "number" ? agent.wikiPolicyRevision : 0;
		return {
			agentId,
			activeProjectId: undefined, // preview 不强制注入 active project;UI 可后续扩参。
			wikiPolicyRevision: rev,
			existingGrants: agent?.wikiGrants ?? [],
			existingContext: agent?.wikiContext ?? [],
		};
	}

	router.post("/grants/validate", (req, res) => {
		// agentId 走 URL query 还是 body? plan-07 §3 grants 是「per-agent 编辑
		// + preview」,所以 agentId 是关键身份字段——但**不能从 body 声明**(伪造
		// guard)。这里改走 query string(?agentId=...)绕开 body forged-identity
		// 检查,且 agentId 在 server 侧用 agentStore.get 真实读取。
		const agentId = (req.query.agentId as string | undefined) ?? "";
		if (!agentId) {
			res.status(400).json(errorBody("INVALID_REQUEST", "agentId query param required"));
			return;
		}
		const body = parseBody(req, res, grantsValidateSchema);
		if (body === null) return;
		const ctx = resolveAgentContext(agentId);
		const compiled = compileWikiAccess({
			agentId: ctx.agentId,
			activeProjectId: ctx.activeProjectId,
			wikiGrants: body.grants,
			wikiPolicyRevision: ctx.wikiPolicyRevision,
		});
		const result: GrantsValidateResult = summarizeGrants(body.grants, compiled);
		res.json({ ok: true, result });
	});

	router.post("/grants/preview", (req, res) => {
		const agentId = (req.query.agentId as string | undefined) ?? "";
		if (!agentId) {
			res.status(400).json(errorBody("INVALID_REQUEST", "agentId query param required"));
			return;
		}
		const body = parseBody(req, res, grantsPreviewSchema);
		if (body === null) return;
		const ctx = resolveAgentContext(agentId);
		const compiled = compileWikiAccess({
			agentId: ctx.agentId,
			activeProjectId: ctx.activeProjectId,
			wikiGrants: body.grants,
			wikiPolicyRevision: ctx.wikiPolicyRevision,
		});
		const validate = summarizeGrants(body.grants, compiled);
		const result: GrantsPreviewResult = {
			access: compiled.access,
			warnings: compiled.warnings,
			mergedGrants: validate.mergedGrants,
			overlaps: validate.overlaps,
			hasRootWriteGrant: validate.hasRootWriteGrant,
		};
		res.json({ ok: true, result });
	});

	router.post("/grants/publish", async (req, res) => {
		const agentId = (req.query.agentId as string | undefined) ?? "";
		if (!agentId) {
			res.status(400).json(errorBody("INVALID_REQUEST", "agentId query param required"));
			return;
		}
		const body = parseBody(req, res, grantsPublishSchema);
		if (body === null) return;

		// 二次确认 wiki-root 全树写 grant(§3 C4)。若 body 携带 root-write grant
		// 且 confirmRootWriteGrant != true → 拒绝(不静默允许,不硬编码禁止)。
		const preview = compileWikiAccess({
			agentId,
			wikiGrants: body.grants,
			wikiPolicyRevision: body.expectedRevision,
		});
		const summary = summarizeGrants(body.grants, preview);
		if (summary.hasRootWriteGrant && !body.confirmRootWriteGrant) {
			res.status(400).json(errorBody(
				"INVALID_REQUEST",
				"wiki-root full-tree write grant requires confirmRootWriteGrant=true (high-risk confirmation)",
			));
			return;
		}

		const result = await callAdmin(res, async (): Promise<GrantsPublishResult> => {
			const pub = deps.agentService.publishAgentWikiPolicy({
				agentId,
				expectedRevision: body.expectedRevision,
				patch: { wikiGrants: body.grants },
				// round-2 FIX 3:透传 service 边界二次确认(service 内单点兜底)。
				confirmRootWriteGrant: body.confirmRootWriteGrant === true,
			});
			deps.auditRepo.append({
				action: "policy.publish.grants",
				nodePath: null,
				newRevision: pub.newRevision,
				detail: {
					agentId,
					grants: body.grants,
					affectedSessions: pub.affectedSessions,
					hasRootWriteGrant: summary.hasRootWriteGrant,
				},
				actorAgentId: WIKI_ADMIN_AUTHORITY.actor,
			});
			emitAdminPolicyChange("grants", agentId);
			return {
				agentId,
				newRevision: pub.newRevision,
				affectedSessions: pub.affectedSessions,
			};
		});
		if (result === null) return;
		res.json({ ok: true, result });
	});

	// =========================================================================
	// §4 — Context(validate / preview / publish)
	// =========================================================================

	router.post("/context/validate", async (req, res) => {
		const agentId = (req.query.agentId as string | undefined) ?? "";
		if (!agentId) {
			res.status(400).json(errorBody("INVALID_REQUEST", "agentId query param required"));
			return;
		}
		const body = parseBody(req, res, contextValidateSchema);
		if (body === null) return;
		const ctx = resolveAgentContext(agentId);
		const grantsForCheck = body.grants ?? ctx.existingGrants;
		const result = await callAdmin(res, async (): Promise<ContextValidateResult> => {
			const { unauthorized, covered, warnings } = await checkContextAuthorization(
				agentId, body.entries, grantsForCheck,
			);
			return {
				ok: unauthorized.length === 0,
				warnings,
				unauthorizedAddresses: unauthorized,
				coveredAddresses: covered,
			};
		});
		if (result === null) return;
		res.json({ ok: true, result });
	});

	router.post("/context/preview", async (req, res) => {
		const agentId = (req.query.agentId as string | undefined) ?? "";
		if (!agentId) {
			res.status(400).json(errorBody("INVALID_REQUEST", "agentId query param required"));
			return;
		}
		const body = parseBody(req, res, contextPreviewSchema);
		if (body === null) return;
		const ctx = resolveAgentContext(agentId);
		const grantsForCheck = body.grants ?? ctx.existingGrants;
		const result = await callAdmin(res, async (): Promise<ContextPreviewResult> => {
			// preview 必须调真实 WikiContextCompiler(plan-07 §4 D2:preview ==
			// runtime)。
			const compiledAccess = compileWikiAccess({
				agentId,
				activeProjectId: ctx.activeProjectId,
				wikiGrants: grantsForCheck,
				wikiPolicyRevision: ctx.wikiPolicyRevision,
			}).access;
			const compiled = await compileWikiContext({
				wikiService: deps.wikiService,
				access: compiledAccess,
				entries: body.entries,
			});
			const auth = await checkContextAuthorization(agentId, body.entries, grantsForCheck);
			return {
				text: compiled.text,
				stats: compiled.stats,
				snapshot: compiled.snapshot,
				warnings: auth.warnings,
				unauthorizedAddresses: auth.unauthorized,
			};
		});
		if (result === null) return;
		res.json({ ok: true, result });
	});

	router.post("/context/publish", async (req, res) => {
		const agentId = (req.query.agentId as string | undefined) ?? "";
		if (!agentId) {
			res.status(400).json(errorBody("INVALID_REQUEST", "agentId query param required"));
			return;
		}
		const body = parseBody(req, res, contextPublishSchema);
		if (body === null) return;

		const result = await callAdmin(res, async (): Promise<ContextPublishResult> => {
			// §4 D3:publish 前再检 unauthorized(防止 UI 绕过 validate 直发)。
			// 不自动新增 grant —— 只允许 publish 当 unauthorized=∅。
			const ctx = resolveAgentContext(agentId);
			const auth = await checkContextAuthorization(agentId, body.entries, ctx.existingGrants);
			if (auth.unauthorized.length > 0) {
				const err = new Error(
					`context publish blocked: addresses lack read grant: ${auth.unauthorized.join(", ")}`,
				);
				(err as Error & { code?: string }).code = "INVALID_REQUEST";
				throw err;
			}
			const pub = deps.agentService.publishAgentWikiPolicy({
				agentId,
				expectedRevision: body.expectedRevision,
				patch: { wikiContext: body.entries },
			});
			deps.auditRepo.append({
				action: "policy.publish.context",
				nodePath: null,
				newRevision: pub.newRevision,
				detail: {
					agentId,
					entries: body.entries,
					affectedSessions: pub.affectedSessions,
				},
				actorAgentId: WIKI_ADMIN_AUTHORITY.actor,
			});
			emitAdminPolicyChange("context", agentId);
			return {
				agentId,
				newRevision: pub.newRevision,
				affectedSessions: pub.affectedSessions,
			};
		});
		if (result === null) return;
		res.json({ ok: true, result });
	});

	// =========================================================================
	// §6 — Session publish status
	// =========================================================================

	router.post("/sessions/status", (req, res) => {
		const agentId = (req.query.agentId as string | undefined) ?? "";
		if (!agentId) {
			res.status(400).json(errorBody("INVALID_REQUEST", "agentId query param required"));
			return;
		}
		// body 是空 object(sessionStatusSchema);允许它存在但不解析。
		const forged = bodyHasForgedIdentity(req.body);
		if (forged.length > 0) {
			res.status(400).json(errorBody("INVALID_REQUEST", `forged identity field(s) rejected: ${forged.join(", ")}`));
			return;
		}
		void sessionStatusSchema.parse(req.body ?? {});
		const sessions = deps.agentService.getAgentWikiSessionStatus(agentId);
		const result: SessionPublishStatusResult = { agentId, sessions };
		res.json({ ok: true, result });
	});

	// =========================================================================
	// §audit — query audit log (plan-07 sub-08 defer 落地点)
	//
	// publish/addresses/repositories 已经在写 wiki_audit_log(policy.publish.
	// grants/context + address.* + repository.*),此前无 query endpoint。
	// 本 endpoint 让管理 UI 能按 node_path / actor / 时间窗查询历史。
	// 只读,不开 transaction,无副作用。
	// =========================================================================

	router.post("/audit/query", (req, res) => {
		const forged = bodyHasForgedIdentity(req.body);
		if (forged.length > 0) {
			res.status(400).json(errorBody("INVALID_REQUEST", `forged identity field(s) rejected: ${forged.join(", ")}`));
			return;
		}
		try {
			const body = req.body ?? {};
			// Optional filters; all empty → recent N (default 100, max 500).
			const nodePath = typeof body.nodePath === "string" ? body.nodePath : null;
			const actorAgentId = typeof body.actorAgentId === "string" ? body.actorAgentId : null;
			const since = typeof body.since === "string" ? body.since : null;
			const until = typeof body.until === "string" ? body.until : null;
			const action = typeof body.action === "string" ? body.action : null;
			const limitRaw = typeof body.limit === "number" ? body.limit : 100;
			const limit = Math.max(1, Math.min(Math.floor(limitRaw), 500));

			// 直接走 WikiAuditRepository 现有 primitives(node_path / actor /
			// time window),action 用 LIKE 过滤(支持 prefix 如 'address.%' /
			// 'policy.%')。如果同时给了多个 filter,以最 narrow 的那个 primitive
			// 起手再 JS 端二次过滤 —— audit 表预期量级在万级以下,二次过滤可接受。
			let rows;
			if (nodePath) {
				rows = deps.auditRepo.listByNodePath(nodePath, limit);
			} else if (actorAgentId) {
				rows = deps.auditRepo.listByActor(actorAgentId, limit);
			} else {
				rows = deps.auditRepo.listByTimeWindow({ since, until, limit });
			}
			// 二次过滤(精确性):action / since / until 在选了 nodePath/actor
			// primitive 时仍要应用,保证 caller 拿到的是 AND 语义。
			const sinceTs = since ? Date.parse(since) : null;
			const untilTs = until ? Date.parse(until) : null;
			const filtered = rows.filter((r) => {
				if (action) {
					// action 可能是 prefix('address.') 也可能是全名('address.create')。
					if (action.endsWith(".") && !r.action.startsWith(action)) return false;
					if (!action.endsWith(".") && r.action !== action) return false;
				}
				if (sinceTs !== null) {
					const ts = Date.parse(r.created_at);
					if (Number.isNaN(ts) || ts < sinceTs) return false;
				}
				if (untilTs !== null) {
					const ts = Date.parse(r.created_at);
					if (Number.isNaN(ts) || ts > untilTs) return false;
				}
				if (actorAgentId && r.actor_agent_id !== actorAgentId) return false;
				return true;
			});
			res.json({ ok: true, result: { items: filtered, count: filtered.length } });
		} catch (err) {
			res.status(500).json(errorBody("INTERNAL", (err as Error).message));
		}
	});

	return router;
}

// ---------------------------------------------------------------------------
// Internal — grants summary, context authorization, address impact
// ---------------------------------------------------------------------------

/**
 * 把 wikiGrants 编译结果汇总成 manage UI 友好的形状(merged / overlaps /
 * hasRootWriteGrant)。无副作用,纯计算。
 */
function summarizeGrants(
	grants: WikiGrant[],
	compiled: { access: { grants: Array<{ canonicalScope: string; actions: string[] }> }; warnings: string[] },
): GrantsValidateResult {
	const mergedByScope = new Map<string, number>();
	for (const g of grants) {
		// 解析后 canonicalize(用 compiler 同款逻辑,避免重复);
		// 这里走近似:把 scope 字符串直接作为 key(compiler 已 canonicalize 过,
		// 但 input 是 raw)。UI 看重叠时用 raw scope 也足够。
		mergedByScope.set(g.scope, (mergedByScope.get(g.scope) ?? 0) + 1);
	}
	const overlaps: Array<{ canonicalScope: string; count: number }> = [];
	for (const [scope, count] of mergedByScope) {
		if (count > 1) overlaps.push({ canonicalScope: scope, count });
	}
	const hasRootWriteGrant = compiled.access.grants.some(
		(g) => g.canonicalScope === WIKI_ROOT_PATH
			&& g.actions.some((a) => a === "create" || a === "update" || a === "delete" || a === "link" || a === "unlink" || a === "move"),
	);
	return {
		ok: compiled.warnings.length === 0 || compiled.warnings.every((w) => !w.includes("invalid") && !w.includes("unknown")),
		mergedGrants: compiled.access.grants,
		warnings: compiled.warnings,
		overlaps,
		hasRootWriteGrant,
	};
}

/**
 * 检查 context entries 的 address 在 grants 下是否有 read 权限。返回
 * unauthorized(address 列表)+ covered(已覆盖地址)+ warnings。
 *
 * 不自动新增 grant —— 仅检查并返回 unauthorized;UI 显示配置错误并阻止
 * publish(plan-07 §4 D3)。
 */
async function checkContextAuthorization(
	agentId: string,
	entries: WikiContextEntry[],
	grants: WikiGrant[],
): Promise<{ unauthorized: string[]; covered: string[]; warnings: string[] }> {
	const warnings: string[] = [];
	const compiledAccess = compileWikiAccess({
		agentId,
		wikiGrants: grants,
	}).access;
	const compiledGrants = compiledAccess.grants;
	const unauthorized: string[] = [];
	const covered: string[] = [];
	for (const entry of entries) {
		if (entry.channel === "off") {
			// off 仍占 grant —— 不注入但仍需 read 权限。同样检查。
		}
		const canonical = resolveEntryCanonicalForAuthz(entry.address, agentId, compiledAccess.activeProjectId);
		if (!canonical) {
			unauthorized.push(entry.address);
			warnings.push(`address ${entry.address} unresolved under current grants`);
			continue;
		}
		const hasRead = compiledGrants.some(
			(g) => (canonical === g.canonicalScope || canonical.startsWith(g.canonicalScope + "/"))
				&& g.actions.includes("read"),
		);
		if (hasRead) {
			covered.push(entry.address);
		} else {
			unauthorized.push(entry.address);
			warnings.push(`address ${entry.address} (canonical ${canonical}) lacks read grant`);
		}
	}
	return { unauthorized, covered, warnings };
}

/**
 * 把 context entry.address 近似解析到 canonical scope 用于 authz 比对。
 * 与 WikiAccessCompiler 同款逻辑(project:// / memory:// / runtime:// /
 * wiki-root/...)。**不**做 IP 节点存在性检查 —— 只做 string-level canonicalization,
 * 与 grant.canonicalScope 比对。完整 read 授权检查仍由 WikiService 在 read
 * 时做(深度防御)。
 */
function resolveEntryCanonicalForAuthz(address: string, agentId: string, activeProjectId: string | undefined): string | null {
	if (address === "memory://" || address.startsWith("memory://")) {
		const rest = address.slice("memory://".length).replace(/^\/+/, "").replace(/\/+$/, "");
		return rest
			? `${WIKI_ROOT_PATH}/memory/${agentId}/${rest}`
			: `${WIKI_ROOT_PATH}/memory/${agentId}`;
	}
	if (address === "project://" || address.startsWith("project://")) {
		if (!activeProjectId) return null;
		const rest = address.slice("project://".length).replace(/^\/+/, "").replace(/\/+$/, "");
		return rest
			? `${WIKI_ROOT_PATH}/projects/${activeProjectId}/${rest}`
			: `${WIKI_ROOT_PATH}/projects/${activeProjectId}`;
	}
	if (address.startsWith("runtime://")) {
		// runtime:// 静态 alias —— 与 grant.canonicalScope 比对即可(grant
		// 也是 runtime:// 原样透传)。
		return address;
	}
	if (address === WIKI_ROOT_PATH || address.startsWith(WIKI_ROOT_PATH + "/")) {
		return address;
	}
	return null;
}

/**
 * 计算地址变更 impact(受影响 Agent / session / scope)。无副作用:扫
 * AgentStore + AgentService active loops。
 */
function computeAddressImpact(
	address: string,
	_targetPath: string | null,
	_resolver: string | null,
): AddressImpactResult {
	const affectedAgents: AddressImpactResult["affectedAgents"] = [];
	const allAgents = deps_accessibleAgentsList();
	for (const agent of allAgents) {
		const viaGrants = (agent.wikiGrants ?? []).filter(
			(g) => g.scope === address || g.scope.startsWith(address + "/") || address.startsWith(g.scope + "/"),
		);
		const viaContext = (agent.wikiContext ?? []).filter(
			(e) => e.address === address || e.address.startsWith(address + "/") || address.startsWith(e.address + "/"),
		);
		if (viaGrants.length === 0 && viaContext.length === 0) continue;
		const entries: Array<{ scope: string; address: string }> = [];
		for (const g of viaGrants) entries.push({ scope: g.scope, address: "" });
		for (const c of viaContext) entries.push({ scope: "", address: c.address });
		affectedAgents.push({
			agentId: agent.id,
			agentName: agent.name,
			via: viaGrants.length > 0 ? "wikiGrants" : "wikiContext",
			entries,
		});
	}
	const affectedSessions: AddressImpactResult["affectedSessions"] = [];
	// AgentService.getAgentWikiSessionStatus 给了 session 列表;impact 调用方
	// 关注「哪些 session 需 refresh」,这里只标 needsRefresh=true(精确判断需
	// 读 loop 当前 wikiAccess 与 publish 后差异,代价高;impact 仅作 hint)。
	const agentService = DEPS_REF?.agentService;
	if (agentService) {
		for (const a of affectedAgents) {
			const sessions = agentService.getAgentWikiSessionStatus(a.agentId);
			for (const s of sessions) {
				affectedSessions.push({
					sessionId: s.sessionId,
					agentId: a.agentId,
					needsRefresh: true,
				});
			}
		}
	}
	return {
		affectedAgents,
		affectedSessions,
		scopeDeltaHint: "unknown",
	};
}

/** 局部闭包:depsAccessibleAgents —— deps.agentStore.list()。 */
function deps_accessibleAgentsList(): Array<{ id: string; name: string; wikiGrants?: WikiGrant[]; wikiContext?: WikiContextEntry[] }> {
	// 注:本函数在 createWikiAdminRouter 闭包内访问 deps;为了保持 summarize/
	// checkContextAuthorization 工具函数无 deps 依赖,impact 单独走闭包 helper。
	// 但上面 computeAddressImpact 模块函数需要 deps。简单起见,把 deps 暴露成
	// 模块 let —— 在 createWikiAdminRouter 入口赋值。
	return DEPS_REF ? DEPS_REF.agentStore.list() : [];
}

/** 模块级 deps 引用(computeAddressImpact 用;createWikiAdminRouter 入口 set)。 */
let DEPS_REF: WikiAdminRouterDeps | null = null;

// =========================================================================
// data-change emissions —— 管理面专用 wiki_admin / wiki_repositories
// =========================================================================

function emitAdminAddressChange(op: "create" | "update" | "delete", address: string): void {
	emitDataChange("wiki_admin", `address:${address}`, op === "delete" ? "delete" : "update", {
		kind: "address",
		address,
		op,
	});
}

function emitAdminPolicyChange(kind: "grants" | "context", agentId: string): void {
	emitDataChange("wiki_admin", `policy:${kind}:${agentId}`, "update", {
		kind: "policy",
		policyKind: kind,
		agentId,
	});
}

function emitAdminRepositoryChange(
	op: "bind" | "unbind" | "update" | "indexing" | "synced" | "stale" | "failed",
	projectId: string,
): void {
	emitDataChange("wiki_repositories", projectId, "update", {
		projectId,
		op,
	});
}

// 重导 WIKI_ADMIN_AUTHORITY 供 server/index.ts / 测试用(renderer 永不接触)。
export const WIKI_ADMIN_AUTHORITY_EXPORTED: WikiAdminAuthority = WIKI_ADMIN_AUTHORITY;
