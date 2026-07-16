// WikiNodeRepository — 节点低层 CRUD + FTS 同步（wiki-system-redesign plan-01 §6）
//
// # 文件说明书
//
// ## 核心功能
// 节点的低层数据访问(无授权 —— 业务校验/地址解析/Agent 授权是 plan-02):
//   - 按 path / id / parent 查节点。
//   - 直接 children 分页(cursor-based)。
//   - 节点 insert / update / archive(归档)/ restore(恢复)/ hard-delete。
//   - FTS 同步(insert/update/delete 在**同一显式 transaction** 内;无 trigger)。
//   - FTS rebuild(全量重建)。
//
// ## 关键不变量（plan-01 §6 / acceptance-01 §A/§E）
//   - DDL/读写都通过裸 SQL,INTEGER 列保持 INTEGER affinity(本文件只读写,
//     不创建/迁移 schema —— schema 由 wiki-schema.ts 负责)。
//   - FTS 同步(external-content,无 trigger):update() / hardDelete() 在内部
//     同一显式 transaction 内完成 OLD-capture + FTS5 'delete' + UPDATE +
//     insert。insert() 不自动同步(让 acceptance-01 §A.11 rebuild 测试能
//     构造 FTS 缺失状态),调用方必须显式调 syncFtsInsert。本文件不开自动
//     transaction —— service 层组合多表写入时负责 wikiDb.transaction(...)。
//   - 返回的内部行类型含 `id` / `parent_id`(repository 内部类型,允许);
//     转换为 Agent-facing view 由 service 层(plan-02)负责。
//   - 归档后同路径重建:archive 置 archived_at;active partial unique index
//     自动允许同 path 的 active 节点。restore 必须先检查冲突。
//   - move(plan-02+ 实现):子树 materialized path 更新 + links/地址不变,
//     仅根节点 revision+1。本 plan-01 只提供 path-update primitive。
//
// ## 不做
//   - 不做业务校验(name 合法性已在 wiki-path;scope/grant 校验在 plan-02)。
//   - 不实现 address resolver / Agent grants。
//   - 不开 trigger(已禁用)。
//
// 参见:
//   - docs/plan/wiki-system-redesign/design.md §5.1（wiki_nodes / FTS）
//   - docs/plan/wiki-system-redesign/plan-01-database-contracts.md §6（范围）

import type Database from "better-sqlite3";
import type { WikiNodeKind } from "../../shared/wiki-types.js";

/**
 * 节点内部行(repository 内部类型,含 DB 整数 ID)。
 *
 * **严禁**直接出现在 Agent-facing view(plan-01 §4 / acceptance-01 §E 拒绝条件)。
 * service 层负责转换为 WikiNodeView(去除 id/parent_id)。
 */
export interface WikiNodeRow {
	id: number;
	parent_id: number | null;
	name: string;
	path: string;
	kind: string;
	summary: string;
	content: string;
	attributes_json: string | null;
	revision: number;
	created_at: string;
	updated_at: string;
	archived_at: string | null;
}

/**
 * 创建节点输入(repository 层,内部使用)。
 */
export interface CreateNodeInput {
	parent_id: number | null;
	name: string;
	path: string;
	kind: WikiNodeKind;
	summary: string;
	content: string;
	attributes_json: string | null;
}

/**
 * 更新节点输入(整段写;局部编辑由 plan-02 service 层组合)。
 */
export interface UpdateNodeInput {
	summary?: string;
	content?: string;
	attributes_json?: string | null;
	/** 新 parent_id(move 场景);不传则不动。 */
	parent_id?: number | null;
	/** 新 path(move 场景);不传则不动。 */
	path?: string;
	/** 新 name(rename 场景);不传则不动。 */
	name?: string;
	/** 新 kind(source-bound 重分类场景);不传则不动。 */
	kind?: WikiNodeKind;
}

/**
 * 分页游标内部结构(opaque base64 由调用方序列化;repository 只接受已解码)。
 * 这里用 `{ path, id }` 做稳定排序键 —— path 单调递增 + id tiebreaker。
 */
export interface WikiChildCursor {
	path: string;
	id: number;
}

/**
 * 把 WikiNodeRow 的 kind 字段强制断言为 WikiNodeKind(数据库存的是 TEXT)。
 * 调用方应在写入前用 wiki-schema 闭集校验。
 */
export function rowKindAsKind(row: WikiNodeRow): WikiNodeKind {
	return row.kind as WikiNodeKind;
}

/**
 * 节点低层 repository。所有方法都不开自动 transaction(除显式注明的 FTS
 * rebuild);调用方组合多表写入时负责 `wikiDb.transaction(() => { ... })`。
 */
export class WikiNodeRepository {
	private readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	// -----------------------------------------------------------------------
	// Read primitives
	// -----------------------------------------------------------------------

	/** 按 path 查 active 节点(归档节点不返回)。不存在返回 undefined。 */
	getActiveByPath(path: string): WikiNodeRow | undefined {
		return this.db
			.prepare(
				`SELECT * FROM wiki_nodes
				 WHERE path = ? AND archived_at IS NULL
				 LIMIT 1`,
			)
			.get(path) as WikiNodeRow | undefined;
	}

	/** 按 path 查任意节点(含归档)。不存在返回 undefined。 */
	getByPath(path: string): WikiNodeRow | undefined {
		return this.db
			.prepare(`SELECT * FROM wiki_nodes WHERE path = ? LIMIT 1`)
			.get(path) as WikiNodeRow | undefined;
	}

	/** 按整数 id 查节点。不存在返回 undefined。 */
	getById(id: number): WikiNodeRow | undefined {
		return this.db
			.prepare(`SELECT * FROM wiki_nodes WHERE id = ? LIMIT 1`)
			.get(id) as WikiNodeRow | undefined;
	}

	/** 按 parent_id 查所有 active 直接 children(不分页)。 */
	getActiveChildren(parentId: number): WikiNodeRow[] {
		return this.db
			.prepare(
				`SELECT * FROM wiki_nodes
				 WHERE parent_id = ? AND archived_at IS NULL
				 ORDER BY path ASC`,
			)
			.all(parentId) as WikiNodeRow[];
	}

	/**
	 * 按 parent_id 分页查 active 直接 children。
	 *
	 * 排序键:path ASC + id ASC(稳定)。cursor 用上一页最后一行的 `{path, id}`。
	 * 不存在 parent 时返回空(items=[], cursor=null, hasMore=false)。
	 */
	getActiveChildrenPaged(
		parentId: number,
		limit: number,
		cursor: WikiChildCursor | null,
	): { items: WikiNodeRow[]; cursor: WikiChildCursor | null; hasMore: boolean } {
		const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
		if (cursor === null) {
			const items = this.db
				.prepare(
					`SELECT * FROM wiki_nodes
					 WHERE parent_id = ? AND archived_at IS NULL
					 ORDER BY path ASC, id ASC
					 LIMIT ?`,
				)
				.all(parentId, safeLimit) as WikiNodeRow[];
			return this.packPage(items, safeLimit);
		}
		const items = this.db
			.prepare(
				`SELECT * FROM wiki_nodes
				 WHERE parent_id = ? AND archived_at IS NULL
				   AND (path > ? OR (path = ? AND id > ?))
				 ORDER BY path ASC, id ASC
				 LIMIT ?`,
			)
			.all(parentId, cursor.path, cursor.path, cursor.id, safeLimit) as WikiNodeRow[];
		return this.packPage(items, safeLimit);
	}

	private packPage(items: WikiNodeRow[], limit: number): {
		items: WikiNodeRow[];
		cursor: WikiChildCursor | null;
		hasMore: boolean;
	} {
		if (items.length < limit) {
			return { items, cursor: null, hasMore: false };
		}
		const last = items[items.length - 1];
		return {
			items,
			cursor: { path: last.path, id: last.id },
			hasMore: true,
		};
	}

	// -----------------------------------------------------------------------
	// Mutations — 调用方必须在显式 transaction 内调用(+ 同步 FTS + audit)
	// -----------------------------------------------------------------------

	/**
	 * 插入新节点。返回新行(含生成的 id)。revision 默认 1。
	 *
	 * **不**自动同步 FTS 或写 audit —— 调用方在 transaction 内组合:
	 *   wikiDb.transaction(() => {
	 *     const row = nodeRepo.insert(input);
	 *     nodeRepo.syncFtsInsert(row.id, row.name, row.summary, row.content);
	 *     auditRepo.append(...);
	 *   });
	 */
	insert(input: CreateNodeInput): WikiNodeRow {
		const now = new Date().toISOString();
		const result = this.db
			.prepare(
				`INSERT INTO wiki_nodes
				   (id, parent_id, name, path, kind, summary, content,
				    attributes_json, revision, created_at, updated_at, archived_at)
				 VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
			)
			.run(
				input.parent_id,
				input.name,
				input.path,
				input.kind,
				input.summary,
				input.content,
				input.attributes_json,
				now,
				now,
			);
		const row = this.getById(Number(result.lastInsertRowid));
		if (!row) {
			throw new Error(
				`WikiNodeRepository.insert: row vanished after insert (path=${input.path})`,
			);
		}
		return row;
	}

	/**
	 * 整段更新节点(summary/content/attributes/...)。revision 自动 +1。
	 *
	 * **FTS 同步**:本方法在内部、同一显式 transaction 内完成 OLD-capture +
	 * FTS5 'delete' + UPDATE wiki_nodes + FTS insert(design.md §5.5 /
	 * acceptance-01 §A.11)。调用方**无需**再手动调 syncFtsUpdate;若仍然
	 * 调用,得到的是幂等 re-sync,不会 corrupt。
	 *
	 * @param id 节点 id
	 * @param expectedRevision 乐观并发控制:不匹配抛 { code: 'WRITE_CONFLICT' }
	 * @param input 字段 patch
	 * @returns 更新后的行
	 */
	update(id: number, expectedRevision: number, input: UpdateNodeInput): WikiNodeRow {
		const current = this.getById(id);
		if (!current) {
			const err = new Error(`WikiNodeRepository.update: node not found (id=${id})`);
			(err as Error & { code?: string }).code = "NOT_FOUND";
			throw err;
		}
		if (current.revision !== expectedRevision) {
			const err = new Error(
				`WRITE_CONFLICT: node id=${id} expected revision ${expectedRevision} but got ${current.revision}`,
			);
			(err as Error & { code?: string }).code = "WRITE_CONFLICT";
			throw err;
		}
		const now = new Date().toISOString();
		const nextSummary = input.summary ?? current.summary;
		const nextContent = input.content ?? current.content;
		const nextAttributes = input.attributes_json !== undefined
			? input.attributes_json
			: current.attributes_json;
		const nextParentId = input.parent_id !== undefined ? input.parent_id : current.parent_id;
		const nextPath = input.path ?? current.path;
		const nextName = input.name ?? current.name;
		const nextKind = input.kind ?? current.kind;
		const nextRevision = current.revision + 1;

		// FTS 同步 (design.md §5.5 / acceptance-01 §A.11):必须在 UPDATE
		// wiki_nodes **之前**用 OLD 值执行 FTS5 'delete' 命令。OLD-capture
		// 必须内部完成 —— 调用方无法可靠地在外部捕获 OLD(等 update() 返回
		// 时 wiki_nodes 已经是新值)。centralized 在此方法内后,即使调用方
		// 之后再调 syncFtsUpdate(...) 也是幂等 re-sync,不会 corrupt。
		this.ftsDeleteCommand(id, current.name, current.summary, current.content);

		this.db
			.prepare(
				`UPDATE wiki_nodes
				 SET parent_id = ?, name = ?, path = ?, kind = ?,
				     summary = ?, content = ?, attributes_json = ?,
				     revision = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(
				nextParentId,
				nextName,
				nextPath,
				nextKind,
				nextSummary,
				nextContent,
				nextAttributes,
				nextRevision,
				now,
				id,
			);

		// FTS insert NEW —— 与 UPDATE 在同一 transaction 内(design.md §5.5)。
		this.syncFtsInsert(id, nextName, nextSummary, nextContent);

		const row = this.getById(id);
		if (!row) {
			throw new Error(`WikiNodeRepository.update: row vanished after update (id=${id})`);
		}
		return row;
	}

	/**
	 * 归档节点(置 archived_at;不清 content/links)。revision 不变(归档不视为
	 * 内容修改)。归档后 active partial unique index 自动释放 path/sibling 槽位,
	 * 允许同路径 active 重建。
	 *
	 * **FTS 不受影响**:archive 只写 archived_at,name/summary/content 未变,
	 * 索引项无需更新。归档节点仍可被 searchFts 命中(设计上 archived rows
	 * 保留在 wiki_nodes + FTS 索引中,visibility 由 service 层过滤)。
	 *
	 * 注意:子树归档由 service 层(plan-02)编排,本 primitive 只处理单行。
	 */
	archive(id: number): void {
		const now = new Date().toISOString();
		this.db
			.prepare(`UPDATE wiki_nodes SET archived_at = ?, updated_at = ? WHERE id = ?`)
			.run(now, now, id);
	}

	/**
	 * 恢复归档节点(清 archived_at)。调用前必须由 service 层检查 active
	 * path/sibling 冲突 —— 否则 partial unique index 会直接 reject。
	 * 这里只做清字段。
	 */
	unarchive(id: number): void {
		this.db
			.prepare(`UPDATE wiki_nodes SET archived_at = NULL, updated_at = ? WHERE id = ?`)
			.run(new Date().toISOString(), id);
	}

	/**
	 * 硬删除节点。FK 约束会阻止被 link target / address / repository 引用的
	 * 节点删除(RESTRICT);被 source 引用的 wiki_links 和 wiki_source_bindings
	 * 会 CASCADE。
	 *
	 * 本 primitive 不检查业务规则(service 层负责 HARD_DELETE_BLOCKED 判定)。
	 */
	hardDelete(id: number): void {
		// 顺序敏感 (acceptance-01 §A.11):必须先 syncFtsDelete(读 wiki_nodes
		// 当前行作为 FTS5 'delete' 命令的列值),再 DELETE FROM wiki_nodes ——
		// 'delete' 命令依赖 content row 仍存在。
		this.syncFtsDelete(id);
		this.db.prepare(`DELETE FROM wiki_nodes WHERE id = ?`).run(id);
	}

	// -----------------------------------------------------------------------
	// FTS synchronization — external-content, no triggers (plan-01 §2/§6,
	// acceptance-01 §A.11).
	//
	// **External-content FTS5 invariant (design.md §5.5):** the content table
	// (wiki_nodes) MUST hold the values that were last indexed for any given
	// rowid. The FTS5 'delete' command reads the content table at delete time
	// (or the caller passes the values explicitly), and the values must match
	// the tokens currently in the index — otherwise the next MATCH query
	// throws `SqliteError: database disk image is malformed` (SQLITE_CORRUPT_VTAB).
	//
	// Implication: NEVER use `DELETE FROM wiki_nodes_fts WHERE rowid = ?` and
	// NEVER issue the 'delete' command with values that differ from the
	// content row's current columns. Always pair wiki_nodes writes with FTS
	// sync in the same transaction, capturing OLD values BEFORE the UPDATE.
	// -----------------------------------------------------------------------

	/**
	 * 同步 FTS 索引(新增节点)。调用方必须在同一 transaction 内。
	 * external-content 模式:`INSERT INTO wiki_nodes_fts(rowid, name, summary, content)`。
	 *
	 * 注:`insert()` **不**自动调本方法 —— 调用方必须显式调用。这是为了让
	 * acceptance-01 §A.11 "rebuildFts 重建未同步行" 用例可以构造 FTS 缺失状态。
	 */
	syncFtsInsert(rowid: number, name: string, summary: string, content: string): void {
		this.db
			.prepare(
				`INSERT INTO wiki_nodes_fts(rowid, name, summary, content)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(rowid, name, summary, content);
	}

	/**
	 * 同步 FTS 索引到传入的值(external-content 安全更新,acceptance-01 §A.11)。
	 *
	 * 实现要点(必须按序):
	 *  1. 读 wiki_nodes **当前**(OLD)name/summary/content。
	 *  2. 用 OLD 值执行 FTS5 'delete' 命令 —— 这是 external-content 表唯一
	 *     合法的 row 移除方式(SQLite 文档明文要求 'delete' 命令带 content
	 *     table 当前的列值,否则下次 MATCH 抛 SQLITE_CORRUPT_VTAB)。
	 *  3. **UPDATE wiki_nodes 的 name/summary/content 到传入值** —— external-content
	 *     模式下 content table 必须与索引一致,否则后续 syncFtsDelete 读到的
	 *     content 与已索引 token 不匹配,同样 corrupt。
	 *  4. 用传入值 INSERT INTO wiki_nodes_fts。
	 *
	 * 本方法**幂等**:传入与当前 content 相同的值时,'delete' 移除再 insert
	 * 等效为 no-op。`update()` 已在内部完整执行 OLD-capture + FTS 'delete' +
	 * UPDATE + FTS insert —— 调用 update() 后再调 syncFtsUpdate(...) 是冗余但
	 * 合法的 re-sync,不会 corrupt。保留为 public 是为了 acceptance-01 §A.11
	 * 单元测试与"显式 transaction 内手工组合"的演示。
	 *
	 * 调用方必须在同一 transaction 内。
	 */
	syncFtsUpdate(rowid: number, name: string, summary: string, content: string): void {
		const oldRow = this.readIndexedColumns(rowid);
		if (oldRow) {
			this.ftsDeleteCommand(rowid, oldRow.name, oldRow.summary, oldRow.content);
		}
		// external-content FTS5 要求 content table 与索引一致:写入新值到 wiki_nodes,
		// 这样后续 syncFtsDelete(hardDelete) 读到的 content 就是已被索引的值。
		this.db
			.prepare(`UPDATE wiki_nodes SET name = ?, summary = ?, content = ? WHERE id = ?`)
			.run(name, summary, content, rowid);
		this.syncFtsInsert(rowid, name, summary, content);
	}

	/**
	 * 同步 FTS 索引(删除节点)。读 wiki_nodes **当前** name/summary/content,
	 * 用这些值执行 FTS5 'delete' 命令(external-content 表唯一合法的 row 移除)。
	 *
	 * **调用顺序不变式**:必须在 DELETE FROM wiki_nodes **之前**调用 ——
	 * 'delete' 命令需要 content table 当前的列值,content row 必须还在。
	 * `hardDelete()` 已遵守此顺序。调用方手动组合时也必须遵守。
	 *
	 * 调用方必须在同一 transaction 内。
	 */
	syncFtsDelete(rowid: number): void {
		const row = this.readIndexedColumns(rowid);
		if (row) {
			this.ftsDeleteCommand(rowid, row.name, row.summary, row.content);
		} else {
			// Content row 已不存在 —— 防御性 'delete' with empty strings。
			// FTS5 'delete' 命令在 content row 缺失时只 tokenizes 传入值
			// (空字符串 = 0 token),不会读 content table,无副作用。
			this.ftsDeleteCommand(rowid, "", "", "");
		}
	}

	/**
	 * 读 wiki_nodes 的 FTS-indexed 列(name/summary/content)。供 FTS 'delete'
	 * 命令使用 —— external-content 表 'delete' 必须带 content table 当前列值。
	 * 行不存在时返回 undefined。
	 */
	private readIndexedColumns(
		rowid: number,
	): { name: string; summary: string; content: string } | undefined {
		return this.db
			.prepare(`SELECT name, summary, content FROM wiki_nodes WHERE id = ?`)
			.get(rowid) as { name: string; summary: string; content: string } | undefined;
	}

	/**
	 * FTS5 'delete' 命令(external-content 安全的 row 移除原语,acceptance-01 §A.11)。
	 *
	 * **前置条件**:调用方必须保证传入的 name/summary/content 与 wiki_nodes
	 * 当前行的同名列**完全一致** —— 否则下次 MATCH 查询会抛
	 * `SqliteError: database disk image is malformed` (SQLITE_CORRUPT_VTAB)。
	 * 通常通过先调用 `readIndexedColumns(rowid)` 来获取这些值。
	 */
	private ftsDeleteCommand(rowid: number, name: string, summary: string, content: string): void {
		this.db
			.prepare(
				`INSERT INTO wiki_nodes_fts(wiki_nodes_fts, rowid, name, summary, content)
				 VALUES('delete', ?, ?, ?, ?)`,
			)
			.run(rowid, name, summary, content);
	}

	/**
	 * 全量重建 FTS 索引。使用 FTS5 `rebuild` 命令 —— 它会扫描 content table
	 * (wiki_nodes)重建所有行。归档节点也会被索引(它们仍在 wiki_nodes 表里;
	 * 如果只索引 active 节点,需用 syncFtsDelete(rowid) 移除归档 row ——
	 * 本 v1 默认全量,由调用方决定是否在 rebuild 后逐个 syncFtsDelete 归档 row)。
	 *
	 * 本方法**自己开 transaction**(rebuild 是单语句但语义上是全表写)。
	 */
	rebuildFts(): void {
		this.db.transaction(() => {
			// 清空 + rebuild。`INSERT INTO fts(fts) VALUES('rebuild')` 会清空索引
			// 后从 content table 全量读取重建。对 external-content 表,它读取
			// wiki_nodes 的所有 rowid + name/summary/content 列。
			this.db.prepare(`INSERT INTO wiki_nodes_fts(wiki_nodes_fts) VALUES('rebuild')`).run();
		})();
	}

	// -----------------------------------------------------------------------
	// FTS query（基本 fulltext 匹配;高级 mode 由 plan-04 实现）
	// -----------------------------------------------------------------------

	/**
	 * 基本 FTS5 全文查询。返回匹配的节点行(含内部 id;service 层负责转 view)。
	 *
	 * @param ftsQuery FTS5 query string（如 `"agent memory"` 或 `agent OR memory`）
	 * @param limit 返回上限
	 */
	searchFts(ftsQuery: string, limit: number): WikiNodeRow[] {
		const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
		// 用子查询把 FTS rowid join 回 wiki_nodes(external-content 模式下,
		// 直接 SELECT wiki_nodes_fts.* 也能取列,但 join 显式更安全)。
		return this.db
			.prepare(
				`SELECT n.* FROM wiki_nodes_fts f
				 JOIN wiki_nodes n ON n.id = f.rowid
				 WHERE wiki_nodes_fts MATCH ?
				 ORDER BY rank
				 LIMIT ?`,
			)
			.all(ftsQuery, safeLimit) as WikiNodeRow[];
	}

	// -----------------------------------------------------------------------
	// Subtree primitives（plan-02 service 层用 —— 不开 transaction,由调用方包装）
	// -----------------------------------------------------------------------

	/**
	 * 取所有严格后代（path LIKE `<escapedPrefix>/%` ESCAPE '\'）,含归档行。
	 *
	 * @param escapedPrefix **已 escape** 的 path 前缀。调用方必须先 escape `%` / `_`
	 *   和确保 `'\\'` 作为 escape char:见 wiki-service.ts collectSubtreeRows 的用法。
	 *   本方法不做 escape,避免双重 escape。
	 */
	getAllByPathPrefix(escapedPrefix: string): WikiNodeRow[] {
		// 用 LIKE 的 ESCAPE 子句:把传入前缀视为字面量,后跟 `/%` 匹配子路径。
		// 调用方已 escape `%` 和 `_` 为 `\%` / `\_`,本方法加 `/%` 后缀 + ESCAPE `'\'`。
		return this.db
			.prepare(
				`SELECT * FROM wiki_nodes
				 WHERE path LIKE ? || '/%' ESCAPE '\\'
				 ORDER BY path ASC, id ASC`,
			)
			.all(escapedPrefix) as WikiNodeRow[];
	}

	/**
	 * 只更新 path（move 后代专用;不 bump revision,不改 updated_at）。
	 *
	 * 设计（plan-02 §4「仅被移动根节点 revision +1;后代 path 是派生更新,
	 * 后代 revision/updated_at 不变」）:materialized path 是结构性派生数据,
	 * 更新它不算内容修改 —— 后代节点的 revision/updated_at 必须保持不变。
	 *
	 * 调用方必须在显式 transaction 内。
	 */
	updateChildPathOnly(id: number, newPath: string): void {
		this.db
			.prepare(`UPDATE wiki_nodes SET path = ? WHERE id = ?`)
			.run(newPath, id);
	}
}
