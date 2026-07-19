// WikiAddressService — 逻辑地址解析 + 静态地址注册（wiki-system-redesign plan-02 §2）
//
// # 文件说明书
//
// ## 核心功能
// 把 Agent/UI 输入的逻辑地址解析为 canonical path,并提供静态地址注册管理
// （create / update / delete / validate —— 仅管理面调用,不在数据面 WikiService
// API 上暴露）。
//
// ## 解析顺序（plan-02 §2,严格按序）
//   1. canonical wiki-root path → 直接返回。
//   2. 内建动态 scheme `memory://` / `project://` → 用 ctx.agentId /
//      ctx.activeProjectId 构造 `wiki-root/memory/<stable-agent-id>` /
//      `wiki-root/projects/<stable-project-id>`,可选追加 `<rest>` 相对段。
//   3. registered static address（精确匹配 `address` 字符串）→ 按 target_id
//      解析为当前 canonical path（target 节点可 move,alias 仍稳定）。
//   4. relative path under registered address（最长前缀匹配,address 在 wiki_
//      addresses 里某行的 scope 下,剩余段拼接到 target.canonicalPath）。
//   5. canonical path（再 normalize 一次）。
//
// ## Resolver 闭集（plan-02 §2「resolver 是 closed declarative enum」）
//   - `null` —— 静态 alias（target_id 必须非空,指向稳定内部 ID）。
//   - `"current_agent_memory_root"` —— 动态,解析为 `wiki-root/memory/<agentId>`。
//   - `"current_project_root"` —— 动态,解析为 `wiki-root/projects/<projectId>`。
//   其它值视为非法 → INVALID_ADDRESS。**不**接受任意函数名或脚本。
//
// ## 不做
//   - 不在数据面 WikiService API 上暴露 address register/delete/update。
//   - 不把 memory:// / project:// 写入 wiki_addresses 表（design.md §5.3）。
//   - 不开自动 transaction（注册多表写入时由调用方包装）。
//   - 不做 Agent grants 判定（authorization service 职责）。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-02-core-service-address-auth.md §2
//   - docs/archive/wiki-system-redesign/design.md §5.3 + §8.2

import type { WikiAddressRow } from "./wiki-repository-store.js";
import { WikiAddressTable } from "./wiki-repository-store.js";
import type { WikiNodeRepository } from "./wiki-node-repository.js";
import {
	WIKI_ROOT_PATH,
	joinWikiPath,
	normalizeWikiPath,
	parentWikiPath,
	splitWikiPath,
} from "./wiki-path.js";
import type { WikiErrorCode } from "../../shared/wiki-types.js";
import { wikiError } from "./wiki-errors.js";

/**
 * 内建动态 scheme 前缀。memory:// / project:// 不入 wiki_addresses 表,由
 * address service 内部按 CallerCtx 解析（plan-02 §2）。
 */
export const WIKI_DYNAMIC_MEMORY_SCHEME = "memory://";
export const WIKI_DYNAMIC_PROJECT_SCHEME = "project://";

/**
 * Resolver 闭集（plan-02 §2「closed declarative enum」）。`null` = 静态 alias。
 */
export const WIKI_ADDRESS_RESOLVERS = [
	"current_agent_memory_root",
	"current_project_root",
] as const;
export type WikiAddressResolver = (typeof WIKI_ADDRESS_RESOLVERS)[number];

/**
 * scope 合法闭集（design.md §5.3 `wiki_addresses.scope`）。其它 scope 视为非法。
 * `memory` / `project` 不在此闭集 —— 它们是内建动态 scheme,不入表。
 */
const WIKI_ADDRESS_VALID_SCOPES = ["runtime", "static", "alias", "managed"] as const;
type WikiAddressValidScope = (typeof WIKI_ADDRESS_VALID_SCOPES)[number];

/**
 * 解析时使用的上下文（不含 Agent grants —— 那是 authorization service 职责）。
 */
export interface WikiAddressContext {
	/** 当前 Agent 稳定 ID（用于 `memory://` / `current_agent_memory_root`）。 */
	agentId?: string;
	/** 当前活跃项目稳定 ID（用于 `project://` / `current_project_root`）。 */
	activeProjectId?: string;
}

/**
 * 地址解析结果。
 */
export interface WikiResolvedAddress {
	/** 最终 canonical path（永远以 `wiki-root` 开头）。 */
	canonicalPath: string;
	/** 解析来源（便于 audit / 测试）。 */
	origin:
		| "canonical" // 直接是 canonical wiki-root path
		| "memory" // memory:// 内建动态
		| "project" // project:// 内建动态
		| "static-alias" // wiki_addresses 精确匹配
		| "static-alias-relative" // wiki_addresses 前缀匹配 + 相对段
		| "dynamic-resolver"; // wiki_addresses 中 resolver 闭集
}

/**
 * 地址注册输入（管理面;不在数据面 API 上暴露）。
 */
export interface RegisterAddressInput {
	/** 完整地址字符串（如 `runtime://rules/global`）。 */
	address: string;
	/** target 节点 canonical path（service 内部解析为 target_id）。 */
	targetPath?: string | null;
	/** 动态 resolver 闭集（与 targetPath 互斥;都为 null = 未绑定 alias）。 */
	resolver?: WikiAddressResolver | null;
	/** scope（必须来自 WIKI_ADDRESS_VALID_SCOPES）。 */
	scope: string;
	/** kind（如 `static` / `alias`）。 */
	kind: string;
	/** prompt policy（JSON 字符串;可选）。 */
	promptPolicy?: string | null;
}

/**
 * WikiAddressService —— 逻辑地址解析 + 静态地址注册（管理面）。
 *
 * 设计要点：
 *   - resolve() 是纯读路径,不带 transaction（acceptance-02 §B）。
 *   - register/update/delete 内部组合 wiki_addresses + nodeRepo 查询,但本类
 *     不开 transaction（管理 service / WikiService 决定何时落库）。
 *   - memory:// / project:// 永远不入表 —— register 阶段拒绝 scope=`memory`/`project`。
 */
export class WikiAddressService {
	constructor(
		private readonly addressTable: WikiAddressTable,
		private readonly nodeRepo: WikiNodeRepository,
	) {}

	// -------------------------------------------------------------------------
	// 解析（数据面核心）
	// -------------------------------------------------------------------------

	/**
	 * 把任意逻辑地址解析为 canonical path。
	 *
	 * 错误映射（plan-02 §2）:
	 *   - 非法 scheme / 语法 → INVALID_ADDRESS
	 *   - 内建动态地址缺 agent/project ctx → ADDRESS_UNRESOLVED
	 *   - 有效 alias / 规范路径但目标不存在 → NOT_FOUND
	 */
	resolve(address: string, ctx: WikiAddressContext): WikiResolvedAddress {
		if (typeof address !== "string" || address.length === 0) {
			throw wikiError("INVALID_ADDRESS", "address must be a non-empty string");
		}
		const trimmed = address.trim();
		if (trimmed.length === 0) {
			throw wikiError("INVALID_ADDRESS", "address must not be blank");
		}

		// 1) canonical wiki-root path
		if (trimmed.startsWith(WIKI_ROOT_PATH) || trimmed === WIKI_ROOT_PATH) {
			try {
				const normalized = normalizeWikiPath(trimmed);
				return { canonicalPath: normalized, origin: "canonical" };
			} catch {
				// 不是合法 canonical path（可能恰好以 wiki-root 开头但有非法字符）;
				// 继续走后面的步骤 —— 但其它步骤不会接受 wiki-root 开头的字符串,
				// 所以最终会再尝试 normalizeWikiPath 并抛 INVALID_PATH → 转换为 INVALID_ADDRESS。
			}
		}

		// 2) 内建动态 scheme
		if (trimmed.startsWith(WIKI_DYNAMIC_MEMORY_SCHEME)) {
			return this.resolveMemoryDynamic(trimmed, ctx);
		}
		if (trimmed.startsWith(WIKI_DYNAMIC_PROJECT_SCHEME)) {
			return this.resolveProjectDynamic(trimmed, ctx);
		}

		// 3) registered static address（精确匹配）
		const exactAlias = this.addressTable.getByAddress(trimmed);
		if (exactAlias) {
			return this.resolveAliasRow(exactAlias, ctx, null);
		}

		// 4) relative path under registered address（最长前缀匹配）
		const prefixMatch = this.findLongestAliasPrefix(trimmed);
		if (prefixMatch) {
			const rest = trimmed.slice(prefixMatch.address.length).replace(/^\/+/, "");
			return this.resolveAliasRow(prefixMatch.row, ctx, rest);
		}

		// 5) 最后再尝试 canonical normalize —— 把 INVALID_PATH 统一映射成 INVALID_ADDRESS
		try {
			const normalized = normalizeWikiPath(trimmed);
			return { canonicalPath: normalized, origin: "canonical" };
		} catch (err) {
			const code = (err as { code?: WikiErrorCode }).code;
			if (code === "INVALID_PATH" || code === "INVALID_NAME") {
				throw wikiError("INVALID_ADDRESS", `invalid address: ${trimmed}`);
			}
			throw wikiError("INVALID_ADDRESS", `invalid address: ${trimmed}`, { cause: err });
		}
	}

	/**
	 * memory:// scheme 解析。`memory://` → `wiki-root/memory/<agentId>`;
	 * `memory://<rest>` → `wiki-root/memory/<agentId>/<rest>`。
	 */
	private resolveMemoryDynamic(address: string, ctx: WikiAddressContext): WikiResolvedAddress {
		if (!ctx.agentId) {
			throw wikiError(
				"ADDRESS_UNRESOLVED",
				"memory:// address requires agentId in caller context",
			);
		}
		const rest = address.slice(WIKI_DYNAMIC_MEMORY_SCHEME.length);
		const memoryRoot = joinWikiPath(joinWikiPath(WIKI_ROOT_PATH, "memory"), ctx.agentId);
		const canonicalPath = rest.length === 0 ? memoryRoot : joinPathSegments(memoryRoot, rest);
		return { canonicalPath, origin: "memory" };
	}

	/**
	 * project:// scheme 解析。`project://` → `wiki-root/projects/<projectId>`;
	 * `project://<rest>` → `wiki-root/projects/<projectId>/<rest>`。
	 */
	private resolveProjectDynamic(address: string, ctx: WikiAddressContext): WikiResolvedAddress {
		if (!ctx.activeProjectId) {
			throw wikiError(
				"ADDRESS_UNRESOLVED",
				"project:// address requires activeProjectId in caller context",
			);
		}
		const rest = address.slice(WIKI_DYNAMIC_PROJECT_SCHEME.length);
		const projectRoot = joinWikiPath(
			joinWikiPath(WIKI_ROOT_PATH, "projects"),
			ctx.activeProjectId,
		);
		const canonicalPath = rest.length === 0 ? projectRoot : joinPathSegments(projectRoot, rest);
		return { canonicalPath, origin: "project" };
	}

	/**
	 * 按一行 wiki_addresses 解析为 canonical path。处理两种情况:
	 *   - resolver=null 静态 alias:target_id 必须非空,解析为 target.path;
	 *     若提供 rest 则拼接到 target.path 下。
	 *   - resolver∈闭集:动态解析(覆盖 target_id;target_id 应为 null)。
	 */
	private resolveAliasRow(
		row: WikiAddressRow,
		ctx: WikiAddressContext,
		rest: string | null,
	): WikiResolvedAddress {
		// resolver 闭集校验 —— 非 null 且不在闭集则 INVALID_ADDRESS
		if (row.resolver !== null && !(WIKI_ADDRESS_RESOLVERS as readonly string[]).includes(row.resolver)) {
			throw wikiError(
				"INVALID_ADDRESS",
				`unknown resolver '${row.resolver}' for address ${row.address}`,
			);
		}

		let baseCanonical: string;
		let origin: WikiResolvedAddress["origin"];

		if (row.resolver === "current_agent_memory_root") {
			if (!ctx.agentId) {
				throw wikiError(
					"ADDRESS_UNRESOLVED",
					`resolver ${row.resolver} requires agentId in caller context`,
				);
			}
			baseCanonical = joinWikiPath(joinWikiPath(WIKI_ROOT_PATH, "memory"), ctx.agentId);
			origin = "dynamic-resolver";
		} else if (row.resolver === "current_project_root") {
			if (!ctx.activeProjectId) {
				throw wikiError(
					"ADDRESS_UNRESOLVED",
					`resolver ${row.resolver} requires activeProjectId in caller context`,
				);
			}
			baseCanonical = joinWikiPath(
				joinWikiPath(WIKI_ROOT_PATH, "projects"),
				ctx.activeProjectId,
			);
			origin = "dynamic-resolver";
		} else {
			// 静态 alias:target_id 必须非空且目标存在
			if (row.target_id === null) {
				throw wikiError(
					"NOT_FOUND",
					`address ${row.address} has no target binding`,
				);
			}
			const target = this.nodeRepo.getById(row.target_id);
			if (!target) {
				throw wikiError(
					"NOT_FOUND",
					`address ${row.address} target no longer exists`,
				);
			}
			baseCanonical = target.path;
			origin = rest === null ? "static-alias" : "static-alias-relative";
		}

		// 拼接相对段。若 rest 包含越界段(如 `../..` 越出 alias target 根),
		// joinPathSegments → joinWikiPath → validateWikiName 会抛 INVALID_NAME/INVALID_PATH。
		// plan-02 §2 要求相对越界 → INVALID_ADDRESS(closed-set error code),
		// 与 resolve() 末尾的 canonical-normalize fallback 处理一致(见 ~:187-196)。
		let canonicalPath: string;
		if (rest && rest.length > 0) {
			try {
				canonicalPath = joinPathSegments(baseCanonical, rest);
			} catch (err) {
				const code = (err as { code?: WikiErrorCode }).code;
				if (code === "INVALID_PATH" || code === "INVALID_NAME") {
					throw wikiError(
						"INVALID_ADDRESS",
						`address ${row.address}: relative path '${rest}' escapes alias root or is invalid`,
					);
				}
				throw wikiError(
					"INVALID_ADDRESS",
					`address ${row.address}: invalid relative path '${rest}'`,
					{ cause: err },
				);
			}
		} else {
			canonicalPath = baseCanonical;
		}
		return { canonicalPath, origin };
	}

	/**
	 * 找最长前缀匹配的注册地址。
	 *  例：地址 `runtime://rules/global/sub`,注册 `runtime://rules/global` → 命中。
	 */
	private findLongestAliasPrefix(address: string): {
		row: WikiAddressRow;
		address: string;
	} | null {
		// 全表扫描 —— 注册地址量级小（管理面数据）,无需索引。按 address 长度倒序,
		// 取第一个 address 是输入的前缀（且下一段必须是 `/` 边界）。
		const all = this.addressTable.list();
		const candidates = all
			.filter((row) => {
				if (row.address === address) return false; // 精确匹配已在 step 3 处理
				if (!address.startsWith(row.address)) return false;
				// 边界:必须正好是 `/` 边界,避免 `runtime://foo` 误匹配 `runtime://foobar`
				return address.charAt(row.address.length) === "/";
			})
			.sort((a, b) => b.address.length - a.address.length);
		const top = candidates[0];
		return top ? { row: top, address: top.address } : null;
	}

	// -------------------------------------------------------------------------
	// 注册管理（仅管理面 —— 不在 WikiService 数据面 API 上暴露）
	// -------------------------------------------------------------------------

	/**
	 * 创建或更新地址注册。错误映射（plan-02 §2）:
	 *   - address 重复 → ALREADY_EXISTS（不允许通过 upsert 静默覆盖;需显式 update）
	 *   - target 不存在 → NOT_FOUND
	 *   - alias/resolver 循环、scope 非法、相对越界 → INVALID_ADDRESS
	 *
	 * 注意:本方法**不**开 transaction。调用方负责包装。本方法只在 wiki_addresses
	 * 表插入一行;不动其它表。
	 */
	register(input: RegisterAddressInput): WikiAddressRow {
		this.validateInputShape(input);

		const existing = this.addressTable.getByAddress(input.address);
		if (existing) {
			throw wikiError(
				"ALREADY_EXISTS",
				`address ${input.address} already registered; use update`,
			);
		}

		// 解析 target_id（如果给了 targetPath）。
		let targetId: number | null = null;
		if (input.targetPath) {
			const target = this.nodeRepo.getActiveByPath(input.targetPath);
			if (!target) {
				throw wikiError(
					"NOT_FOUND",
					`address target not found (path=${input.targetPath})`,
				);
			}
			targetId = target.id;
		}

		// resolver 与 target 互斥语义:resolver 非空则 target_id 应为 null（动态）。
		if (input.resolver && targetId !== null) {
			throw wikiError(
				"INVALID_ADDRESS",
				`address ${input.address}: resolver and targetPath are mutually exclusive`,
			);
		}

		// 不做 alias cycle 检测:aliases 指向 NODES(target_id → wiki_nodes.id),
		// 永不指向其它 alias,所以解析环在结构上不可能形成。fan-in(多条 alias 指向
		// 同一节点)是 design §5.3 显式允许的合法形态(target_id 是非唯一 FK)。
		// address 唯一性已由上面 getByAddress + PRIMARY KEY 保证;自指由 register
		// 阶段的 address===address 主键查重覆盖,无需额外检测器。

		return this.addressTable.upsert({
			address: input.address,
			target_id: targetId,
			resolver: input.resolver ?? null,
			scope: input.scope,
			kind: input.kind,
			prompt_policy: input.promptPolicy ?? null,
		});
	}

	/**
	 * 更新地址注册（target / resolver / scope / kind / promptPolicy）。
	 */
	update(address: string, patch: Omit<RegisterAddressInput, "address">): WikiAddressRow {
		const existing = this.addressTable.getByAddress(address);
		if (!existing) {
			throw wikiError("NOT_FOUND", `address ${address} not registered`);
		}
		const merged: RegisterAddressInput = {
			address,
			targetPath: patch.targetPath !== undefined ? patch.targetPath : null,
			resolver: patch.resolver !== undefined ? patch.resolver : existing.resolver as WikiAddressResolver | null,
			scope: patch.scope ?? existing.scope,
			kind: patch.kind ?? existing.kind,
			promptPolicy: patch.promptPolicy !== undefined ? patch.promptPolicy : existing.prompt_policy,
		};
		this.validateInputShape(merged);

		let targetId: number | null = existing.target_id;
		if (patch.targetPath !== undefined) {
			if (patch.targetPath === null) {
				targetId = null;
			} else {
				const target = this.nodeRepo.getActiveByPath(patch.targetPath);
				if (!target) {
					throw wikiError(
						"NOT_FOUND",
						`address target not found (path=${patch.targetPath})`,
					);
				}
				targetId = target.id;
			}
		}
		if (merged.resolver && targetId !== null) {
			throw wikiError(
				"INVALID_ADDRESS",
				`address ${address}: resolver and targetPath are mutually exclusive`,
			);
		}
		// 同 register:不做 alias cycle 检测(结构上不可能形成;fan-in 合法)。

		return this.addressTable.upsert({
			address,
			target_id: targetId,
			resolver: merged.resolver ?? null,
			scope: merged.scope,
			kind: merged.kind,
			prompt_policy: merged.promptPolicy ?? null,
		});
	}

	/**
	 * 删除地址注册。不存在视为已删除（幂等）。
	 */
	delete(address: string): void {
		this.addressTable.delete(address);
	}

	/**
	 * 静态校验（不入库）：返回 ok / 错误码 + 消息。给 UI 预检 / 测试用。
	 */
	validate(input: RegisterAddressInput): { ok: true } | { ok: false; code: WikiErrorCode; message: string } {
		try {
			this.validateInputShape(input);
		} catch (err) {
			const e = err as { code?: WikiErrorCode; message?: string };
			return { ok: false, code: e.code ?? "INVALID_ADDRESS", message: e.message ?? "invalid" };
		}
		return { ok: true };
	}

	// -------------------------------------------------------------------------
	// 内部校验
	// -------------------------------------------------------------------------

	private validateInputShape(input: RegisterAddressInput): void {
		if (typeof input.address !== "string" || input.address.length === 0) {
			throw wikiError("INVALID_ADDRESS", "address must be a non-empty string");
		}
		// 拒绝内建动态 scheme 入表（design.md §5.3）。
		if (
			input.address.startsWith(WIKI_DYNAMIC_MEMORY_SCHEME)
			|| input.address.startsWith(WIKI_DYNAMIC_PROJECT_SCHEME)
		) {
			throw wikiError(
				"INVALID_ADDRESS",
				`address ${input.address}: memory:// / project:// are built-in and cannot be registered`,
			);
		}
		// 必须是 `<scope>://<path>` 风格 —— 检测 `://` 分隔。
		const sep = "://";
		const sepIdx = input.address.indexOf(sep);
		if (sepIdx <= 0 || sepIdx === input.address.length - sep.length) {
			throw wikiError(
				"INVALID_ADDRESS",
				`address must be of form '<scope>://<path>' (got ${input.address})`,
			);
		}
		const scope = input.address.slice(0, sepIdx);
		if (!(WIKI_ADDRESS_VALID_SCOPES as readonly string[]).includes(scope)) {
			throw wikiError(
				"INVALID_ADDRESS",
				`address scope '${scope}' not in valid set ${WIKI_ADDRESS_VALID_SCOPES.join(", ")}`,
			);
		}
		if (!(WIKI_ADDRESS_VALID_SCOPES as readonly string[]).includes(input.scope)) {
			throw wikiError(
				"INVALID_ADDRESS",
				`scope field '${input.scope}' not in valid set ${WIKI_ADDRESS_VALID_SCOPES.join(", ")}`,
			);
		}
		if (input.resolver !== null && input.resolver !== undefined) {
			if (!(WIKI_ADDRESS_RESOLVERS as readonly string[]).includes(input.resolver)) {
				throw wikiError(
					"INVALID_ADDRESS",
					`resolver '${input.resolver}' not in closed enum ${WIKI_ADDRESS_RESOLVERS.join(", ")}`,
				);
			}
		}
		if (typeof input.kind !== "string" || input.kind.length === 0) {
			throw wikiError("INVALID_ADDRESS", "kind must be a non-empty string");
		}
		// 相对路径越界:如果 targetPath + 后续相对段会越出 scope 根,拒绝。
		// （相对越界主要发生在 resolve 阶段拼接 rest 段;register 阶段只校验
		//   targetPath 自身合法。）
	}
}

/**
 * 把相对段字符串拆成路径段数组。`a/b/c` → `["a", "b", "c"]`。
 * 空段被过滤。空字符串返回 `[]`（用于 `joinWikiPath(base)` 不加段）。
 */
function splitRest(rest: string): string[] {
	if (rest.length === 0) return [];
	return rest
		.split("/")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * 把 base canonical path 与多段 rest 拼成最终 canonical path。逐段 joinWikiPath
 * 校验每段 name,空段自动跳过。
 */
function joinPathSegments(base: string, rest: string): string {
	const segs = splitRest(rest);
	let current = base;
	for (const seg of segs) {
		current = joinWikiPath(current, seg);
	}
	return current;
}

// 重新导出 splitWikiPath / parentWikiPath 以便外部组装「相对路径」校验。
export { splitWikiPath, parentWikiPath };
