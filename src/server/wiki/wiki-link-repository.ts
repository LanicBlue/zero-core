// WikiLinkRepository — 链接 CRUD + incoming/outgoing（wiki-system-redesign plan-01 §6）
//
// # 文件说明书
//
// ## 核心功能
// `wiki_links` 表的低层 CRUD(无方向:一条记录同时支持 outgoing/incoming,
// 不双写反向链接 —— design.md §5.2):
//   - insert(source_id, target_id, relation)
//   - delete(source_id, target_id, relation)
//   - outgoing(source_id):source = ? 的所有链接
//   - incoming(target_id):target = ? 的所有链接(backlink)
//   - 重复插入(同 source/target/relation)由 PRIMARY KEY 自然 reject。
//
// ## FK 行为（design.md §5.2）
//   - source_id ON DELETE CASCADE(删 source 节点级联删 link)。
//   - target_id ON DELETE RESTRICT(被引用的 target 节点不允许直接硬删;
//     需先 unlink 或归档)。
//
// ## 不做
//   - 不做业务校验(visibility 过滤 / Agent 授权在 plan-02 service 层)。
//   - 不开自动 transaction(调用方组合节点 + audit 写入时负责)。
//
// 参见:
//   - docs/archive/wiki-system-redesign/design.md §5.2（wiki_links DDL）
//   - docs/archive/wiki-system-redesign/plan-01-database-contracts.md §6（范围）

import type Database from "better-sqlite3";

/**
 * 链接内部行(repository 内部类型,含整数 source_id/target_id)。
 *
 * **严禁**直接出现在 Agent-facing view(plan-01 §4);service 层负责转换为
 * WikiLinkView(把 source_id/target_id 解析为 sourcePath/targetPath)。
 */
export interface WikiLinkRow {
	source_id: number;
	target_id: number;
	relation: string;
	created_at: string;
	created_by: string | null;
}

/**
 * 创建链接输入。
 */
export interface CreateLinkInput {
	source_id: number;
	target_id: number;
	relation: string;
	created_by: string | null;
}

/**
 * 链接低层 repository。
 */
export class WikiLinkRepository {
	private readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	/**
	 * 插入链接。重复(同 source/target/relation)由 PRIMARY KEY reject ——
	 * SQLite 抛 SQLITE_CONSTRAINT_PRIMARYKEY。调用方可选择吞掉(幂等)或抛
	 * ALREADY_EXISTS(service 层处理)。
	 */
	insert(input: CreateLinkInput): void {
		const now = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO wiki_links (source_id, target_id, relation, created_at, created_by)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(input.source_id, input.target_id, input.relation, now, input.created_by);
	}

	/**
	 * 幂等插入:`INSERT OR IGNORE`。返回是否真的插入了新行(true=新增,
	 * false=已存在,幂等)。
	 */
	insertOrIgnore(input: CreateLinkInput): boolean {
		const now = new Date().toISOString();
		const result = this.db
			.prepare(
				`INSERT OR IGNORE INTO wiki_links (source_id, target_id, relation, created_at, created_by)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(input.source_id, input.target_id, input.relation, now, input.created_by);
		return result.changes === 1;
	}

	/**
	 * 删除链接。不存在时 no-op(不报错)。返回是否真的删除了一行。
	 */
	delete(sourceId: number, targetId: number, relation: string): boolean {
		const result = this.db
			.prepare(
				`DELETE FROM wiki_links
				 WHERE source_id = ? AND target_id = ? AND relation = ?`,
			)
			.run(sourceId, targetId, relation);
		return result.changes > 0;
	}

	/**
	 * 查 outgoing 链接(source = ?)。返回所有 relation 的所有出链。
	 */
	outgoing(sourceId: number): WikiLinkRow[] {
		return this.db
			.prepare(
				`SELECT * FROM wiki_links
				 WHERE source_id = ?
				 ORDER BY relation ASC, target_id ASC`,
			)
			.all(sourceId) as WikiLinkRow[];
	}

	/**
	 * 查 incoming 链接(backlink;target = ?)。返回所有指向该节点的链接。
	 */
	incoming(targetId: number): WikiLinkRow[] {
		return this.db
			.prepare(
				`SELECT * FROM wiki_links
				 WHERE target_id = ?
				 ORDER BY relation ASC, source_id ASC`,
			)
			.all(targetId) as WikiLinkRow[];
	}

	/**
	 * 查特定节点的出链 + 入链(单次调用方便 service 层组装 read result)。
	 */
	both(nodeId: number): { outgoing: WikiLinkRow[]; incoming: WikiLinkRow[] } {
		return {
			outgoing: this.outgoing(nodeId),
			incoming: this.incoming(nodeId),
		};
	}

	/**
	 * 统计节点的 outgoing / incoming 数量(用于 WikiNodeView 的 relations 摘要;
	 * plan-02 service 层组装 view 时调用)。
	 */
	countBoth(nodeId: number): { outgoingCount: number; incomingCount: number } {
		const out = this.db
			.prepare(`SELECT COUNT(*) AS n FROM wiki_links WHERE source_id = ?`)
			.get(nodeId) as { n: number };
		const inc = this.db
			.prepare(`SELECT COUNT(*) AS n FROM wiki_links WHERE target_id = ?`)
			.get(nodeId) as { n: number };
		return { outgoingCount: out.n, incomingCount: inc.n };
	}

	/**
	 * 判断链接是否存在(同 source/target/relation)。
	 */
	exists(sourceId: number, targetId: number, relation: string): boolean {
		const row = this.db
			.prepare(
				`SELECT 1 FROM wiki_links
				 WHERE source_id = ? AND target_id = ? AND relation = ?
				 LIMIT 1`,
			)
			.get(sourceId, targetId, relation);
		return row !== undefined;
	}
}
