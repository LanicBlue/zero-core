// WikiRepositoryStore — 仓库绑定 / source 映射 / 静态地址（wiki-system-redesign plan-01 §6）
//
// # 文件说明书
//
// ## 核心功能
// 三张管理面表的低层 CRUD(无授权 —— 管理面授权由 plan-07 UI / 管理服务处理):
//   - `wiki_repositories`:项目镜像仓库绑定(project_node_id 1:1 + project_id 软引用)。
//   - `wiki_source_bindings`:文件/目录节点的源码映射(node_id 1:1)。
//   - `wiki_addresses`:静态逻辑地址(`runtime://` 等管理者注册;动态 memory://
//     / project:// 不入此表)。
//
// ## FK 行为（design.md §5.3 / §5.4）
//   - wiki_repositories.project_node_id ON DELETE RESTRICT(被仓库绑定的项目根
//     不允许硬删)。
//   - wiki_source_bindings.node_id ON DELETE CASCADE(删节点级联删绑定);
//     repository_id ON DELETE CASCADE(删仓库级联删所有绑定)。
//   - wiki_addresses.target_id ON DELETE RESTRICT(被地址引用的节点不允许硬删)。
//
// ## 不做
//   - 不做 Git 索引(plan-03 WikiProjectIndexer 职责)。
//   - 不做地址解析(memory:// / project:// 动态 resolver 在 plan-02)。
//   - 不开自动 transaction(管理 service 组合时负责)。
//
// 参见:
//   - docs/archive/wiki-system-redesign/design.md §5.3 / §5.4
//   - docs/archive/wiki-system-redesign/plan-01-database-contracts.md §6

import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// wiki_repositories（design.md §5.4）
// ---------------------------------------------------------------------------

/**
 * 仓库绑定内部行(含 project_node_id 整数 ID —— 内部类型,不进 Agent view)。
 */
export interface WikiRepositoryRow {
	repository_id: string;
	project_node_id: number;
	project_id: string;
	source_root: string;
	default_branch: string;
	indexed_revision: string | null;
	sync_status: string;
	last_error: string | null;
	last_indexed_at: string | null;
}

export interface UpsertRepositoryInput {
	repository_id: string;
	project_node_id: number;
	project_id: string;
	source_root?: string;
	default_branch?: string;
}

/**
 * wiki_repositories CRUD。
 */
export class WikiRepositoryTable {
	private readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	/** 按 repository_id 查。不存在返回 undefined。 */
	getById(repositoryId: string): WikiRepositoryRow | undefined {
		return this.db
			.prepare(`SELECT * FROM wiki_repositories WHERE repository_id = ?`)
			.get(repositoryId) as WikiRepositoryRow | undefined;
	}

	/** 按 project_id 查(1:1)。不存在返回 undefined。 */
	getByProjectId(projectId: string): WikiRepositoryRow | undefined {
		return this.db
			.prepare(`SELECT * FROM wiki_repositories WHERE project_id = ?`)
			.get(projectId) as WikiRepositoryRow | undefined;
	}

	/** 按 project_node_id 查(1:1)。不存在返回 undefined。 */
	getByProjectNodeId(projectNodeId: number): WikiRepositoryRow | undefined {
		return this.db
			.prepare(`SELECT * FROM wiki_repositories WHERE project_node_id = ?`)
			.get(projectNodeId) as WikiRepositoryRow | undefined;
	}

	/**
	 * 插入或更新(UPSERT)。更新时不改 indexed_revision / sync_status / last_error
	 * / last_indexed_at(那些由 indexer 维护);只更新 source_root / default_branch
	 * / project_node_id / project_id。
	 */
	upsert(input: UpsertRepositoryInput): WikiRepositoryRow {
		const sourceRoot = input.source_root ?? "";
		const defaultBranch = input.default_branch ?? "main";
		this.db
			.prepare(
				`INSERT INTO wiki_repositories
				   (repository_id, project_node_id, project_id, source_root,
				    default_branch, indexed_revision, sync_status, last_error,
				    last_indexed_at)
				 VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL)
				 ON CONFLICT(repository_id) DO UPDATE SET
				   project_node_id = excluded.project_node_id,
				   project_id      = excluded.project_id,
				   source_root     = excluded.source_root,
				   default_branch  = excluded.default_branch`,
			)
			.run(
				input.repository_id,
				input.project_node_id,
				input.project_id,
				sourceRoot,
				defaultBranch,
			);
		const row = this.getById(input.repository_id);
		if (!row) {
			throw new Error(
				`WikiRepositoryTable.upsert: row vanished after upsert (repository_id=${input.repository_id})`,
			);
		}
		return row;
	}

	/**
	 * 更新同步状态(plan-03 indexer 调用)。`indexedRevision` / `lastIndexedAt`
	 * 同步推进;`lastError` 清空(成功)或写入(失败)。
	 */
	updateSyncState(input: {
		repository_id: string;
		indexed_revision?: string | null;
		sync_status?: string;
		last_error?: string | null;
		last_indexed_at?: string | null;
	}): void {
		const current = this.getById(input.repository_id);
		if (!current) {
			throw new Error(
				`WikiRepositoryTable.updateSyncState: repository not found (id=${input.repository_id})`,
			);
		}
		this.db
			.prepare(
				`UPDATE wiki_repositories
				 SET indexed_revision = ?, sync_status = ?, last_error = ?, last_indexed_at = ?
				 WHERE repository_id = ?`,
			)
			.run(
				input.indexed_revision !== undefined ? input.indexed_revision : current.indexed_revision,
				input.sync_status ?? current.sync_status,
				input.last_error !== undefined ? input.last_error : current.last_error,
				input.last_indexed_at !== undefined ? input.last_indexed_at : current.last_indexed_at,
				input.repository_id,
			);
	}

	/**
	 * 删除仓库。CASCADE 会同时删 wiki_source_bindings 中所有该仓库的绑定。
	 * project_node_id RESTRICT —— 若项目根节点仍存在,会 reject。
	 */
	delete(repositoryId: string): boolean {
		const result = this.db
			.prepare(`DELETE FROM wiki_repositories WHERE repository_id = ?`)
			.run(repositoryId);
		return result.changes > 0;
	}

	/** 列出所有仓库(plan-07 管理 UI 用)。 */
	list(): WikiRepositoryRow[] {
		return this.db
			.prepare(`SELECT * FROM wiki_repositories ORDER BY project_id ASC`)
			.all() as WikiRepositoryRow[];
	}
}

// ---------------------------------------------------------------------------
// wiki_source_bindings（design.md §5.4）
// ---------------------------------------------------------------------------

/**
 * source 绑定内部行。
 */
export interface WikiSourceBindingRow {
	node_id: number;
	repository_id: string;
	source_path: string;
	source_kind: string;
	indexed_revision: string;
	blob_oid: string | null;
}

export interface UpsertSourceBindingInput {
	node_id: number;
	repository_id: string;
	source_path: string;
	source_kind: string;
	indexed_revision: string;
	blob_oid?: string | null;
}

/**
 * wiki_source_bindings CRUD。
 */
export class WikiSourceBindingTable {
	private readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	/** 按 node_id 查(1:1)。不存在返回 undefined。 */
	getByNodeId(nodeId: number): WikiSourceBindingRow | undefined {
		return this.db
			.prepare(`SELECT * FROM wiki_source_bindings WHERE node_id = ?`)
			.get(nodeId) as WikiSourceBindingRow | undefined;
	}

	/** 按 (repository_id, source_path) 查。不存在返回 undefined。 */
	getBySourcePath(repositoryId: string, sourcePath: string): WikiSourceBindingRow | undefined {
		return this.db
			.prepare(
				`SELECT * FROM wiki_source_bindings
				 WHERE repository_id = ? AND source_path = ?`,
			)
			.get(repositoryId, sourcePath) as WikiSourceBindingRow | undefined;
	}

	/**
	 * 插入或更新(UPSERT;PK = node_id)。indexed_revision / blob_oid 总是覆盖
	 * (indexer 每次同步都推进)。
	 */
	upsert(input: UpsertSourceBindingInput): WikiSourceBindingRow {
		this.db
			.prepare(
				`INSERT INTO wiki_source_bindings
				   (node_id, repository_id, source_path, source_kind,
				    indexed_revision, blob_oid)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(node_id) DO UPDATE SET
				   repository_id   = excluded.repository_id,
				   source_path     = excluded.source_path,
				   source_kind     = excluded.source_kind,
				   indexed_revision = excluded.indexed_revision,
				   blob_oid        = excluded.blob_oid`,
			)
			.run(
				input.node_id,
				input.repository_id,
				input.source_path,
				input.source_kind,
				input.indexed_revision,
				input.blob_oid ?? null,
			);
		const row = this.getByNodeId(input.node_id);
		if (!row) {
			throw new Error(
				`WikiSourceBindingTable.upsert: row vanished after upsert (node_id=${input.node_id})`,
			);
		}
		return row;
	}

	/**
	 * 按 node_id 删除。CASCADE 也由 FK 保证(若直接删节点)。
	 */
	deleteByNodeId(nodeId: number): boolean {
		const result = this.db
			.prepare(`DELETE FROM wiki_source_bindings WHERE node_id = ?`)
			.run(nodeId);
		return result.changes > 0;
	}

	/** 列出仓库下所有绑定(plan-03 indexer / plan-07 管理 UI)。 */
	listByRepository(repositoryId: string): WikiSourceBindingRow[] {
		return this.db
			.prepare(
				`SELECT * FROM wiki_source_bindings
				 WHERE repository_id = ?
				 ORDER BY source_path ASC`,
			)
			.all(repositoryId) as WikiSourceBindingRow[];
	}
}

// ---------------------------------------------------------------------------
// wiki_addresses（design.md §5.3）
// ---------------------------------------------------------------------------

/**
 * 静态地址内部行(含 target_id 整数 ID —— 内部类型)。
 */
export interface WikiAddressRow {
	address: string;
	target_id: number | null;
	resolver: string | null;
	scope: string;
	kind: string;
	prompt_policy: string | null;
	revision: number;
	created_at: string;
	updated_at: string;
}

export interface UpsertAddressInput {
	address: string;
	target_id?: number | null;
	resolver?: string | null;
	scope: string;
	kind: string;
	prompt_policy?: string | null;
}

/**
 * wiki_addresses CRUD。**只服务静态地址** —— 动态 memory:// / project://
 * 不入此表(plan-02 resolver 按 CallerCtx 解析)。
 */
export class WikiAddressTable {
	private readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	/** 按 address 查(PK)。不存在返回 undefined。 */
	getByAddress(address: string): WikiAddressRow | undefined {
		return this.db
			.prepare(`SELECT * FROM wiki_addresses WHERE address = ?`)
			.get(address) as WikiAddressRow | undefined;
	}

	/** 按 target_id 查(列所有指向该节点的静态地址)。 */
	listByTargetId(targetId: number): WikiAddressRow[] {
		return this.db
			.prepare(`SELECT * FROM wiki_addresses WHERE target_id = ? ORDER BY address ASC`)
			.all(targetId) as WikiAddressRow[];
	}

	/**
	 * 插入或更新(UPSERT;PK = address)。revision 在 update 分支 +1。
	 */
	upsert(input: UpsertAddressInput): WikiAddressRow {
		const existing = this.getByAddress(input.address);
		const now = new Date().toISOString();
		if (existing) {
			this.db
				.prepare(
					`UPDATE wiki_addresses
					 SET target_id = ?, resolver = ?, scope = ?, kind = ?,
					     prompt_policy = ?, revision = revision + 1, updated_at = ?
					 WHERE address = ?`,
				)
				.run(
					input.target_id !== undefined ? input.target_id : existing.target_id,
					input.resolver !== undefined ? input.resolver : existing.resolver,
					input.scope,
					input.kind,
					input.prompt_policy !== undefined ? input.prompt_policy : existing.prompt_policy,
					now,
					input.address,
				);
		} else {
			this.db
				.prepare(
					`INSERT INTO wiki_addresses
					   (address, target_id, resolver, scope, kind, prompt_policy,
					    revision, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
				)
				.run(
					input.address,
					input.target_id ?? null,
					input.resolver ?? null,
					input.scope,
					input.kind,
					input.prompt_policy ?? null,
					now,
					now,
				);
		}
		const row = this.getByAddress(input.address);
		if (!row) {
			throw new Error(
				`WikiAddressTable.upsert: row vanished after upsert (address=${input.address})`,
			);
		}
		return row;
	}

	/**
	 * 删除地址。target_id RESTRICT —— 若 target 节点仍存在且被引用,delete
	 * 地址本身无 FK 问题(只有反向:删节点被地址 RESTRICT)。
	 */
	delete(address: string): boolean {
		const result = this.db
			.prepare(`DELETE FROM wiki_addresses WHERE address = ?`)
			.run(address);
		return result.changes > 0;
	}

	/** 列所有地址(plan-07 管理 UI)。 */
	list(): WikiAddressRow[] {
		return this.db
			.prepare(`SELECT * FROM wiki_addresses ORDER BY scope ASC, address ASC`)
			.all() as WikiAddressRow[];
	}
}

// ---------------------------------------------------------------------------
// 复合 store(便于 service 层一次性注入)
// ---------------------------------------------------------------------------

/**
 * 管理面三表复合 store。service 层(plan-03 indexer / plan-07 管理 service)
 * 通过此一次性持有 wiki_repositories / wiki_source_bindings / wiki_addresses
 * 的 CRUD 句柄。
 */
export class WikiRepositoryStore {
	readonly repositories: WikiRepositoryTable;
	readonly sourceBindings: WikiSourceBindingTable;
	readonly addresses: WikiAddressTable;

	constructor(db: Database.Database) {
		this.repositories = new WikiRepositoryTable(db);
		this.sourceBindings = new WikiSourceBindingTable(db);
		this.addresses = new WikiAddressTable(db);
	}
}
