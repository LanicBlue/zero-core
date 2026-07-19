// WikiAuditRepository — 审计日志 append + request_id 去重（wiki-system-redesign plan-01 §6）
//
// # 文件说明书
//
// ## 核心功能
// `wiki_audit_log` 表的低层 append + 查询(无删除 —— 审计是不可变历史):
//   - append(input):写入一条审计记录。
//   - **request_id 安全重试去重**(design.md §5.6 / acceptance-01 §A「request_id
//     重复不会产生两条记录」):同 request_id 的重复写入返回已存在的 audit_id,
//     不产生新记录,不报错。
//   - 查询 by audit_id / by node_path / by actor / 时间窗。
//
// ## 不变量（design.md §5.6 / plan-01 §6）
//   - 审计记录与对应的节点/FTS 写入应在**同一 transaction** 内完成(service
//     层负责组合;本 primitive 只 append)。
//   - `audit_id` 是公开 opaque operation receipt —— 可作为 WikiMutationResult.auditId
//     返回给 Agent/UI(plan-01 §4)。
//   - 不提供 UPDATE / DELETE(审计不可变;只追加)。
//
// ## 不做
//   - 不开自动 transaction(调用方组合节点写入 + FTS 同步 + audit 时负责)。
//   - 不做 actor 授权校验(管理面职责)。
//
// 参见:
//   - docs/archive/wiki-system-redesign/design.md §5.6（DDL + 幂等语义）
//   - docs/archive/wiki-system-redesign/plan-01-database-contracts.md §6

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

/**
 * 审计日志内部行(包含 audit_id 公开 receipt + old/new_revision 修订号)。
 * 转换为 WikiAuditView 时 detail_json 反序列化为 detail。
 */
export interface WikiAuditRow {
	audit_id: string;
	request_id: string | null;
	actor_agent_id: string | null;
	session_id: string | null;
	action: string;
	node_path: string | null;
	old_revision: number | null;
	new_revision: number | null;
	detail_json: string | null;
	created_at: string;
}

/**
 * 追加审计记录的输入。`requestId` 提供则做去重;`auditId` 不提供则生成。
 */
export interface AppendAuditInput {
	/** 公开 opaque receipt。不提供则生成 UUID v4。 */
	auditId?: string;
	/** 安全重试去重键。同 request_id 重复写入返回已存在的 audit_id。 */
	requestId?: string | null;
	/** 发起者 Agent ID。 */
	actorAgentId?: string | null;
	/** 会话 ID。 */
	sessionId?: string | null;
	/** 触发的 action(expand/read/create/update/...;管理面 action 也允许)。 */
	action: string;
	/** 受影响节点规范路径。 */
	nodePath?: string | null;
	/** 操作前修订号。 */
	oldRevision?: number | null;
	/** 操作后修订号。 */
	newRevision?: number | null;
	/** 操作详情(自由对象;repository 序列化为 JSON 字符串)。 */
	detail?: unknown;
}

/**
 * append 的返回:`deduped=true` 表示 request_id 命中已有记录(未插入新行,
 * 返回的 auditId 是已存在那条);`deduped=false` 表示新写入。
 */
export interface AppendAuditResult {
	/** 公开 opaque receipt(可能是新生成的,也可能是已存在的)。 */
	auditId: string;
	/** 是否命中 request_id 去重。 */
	deduped: boolean;
}

/**
 * 审计日志低层 repository。
 */
export class WikiAuditRepository {
	private readonly db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
	}

	/**
	 * 追加一条审计记录。
	 *
	 * **request_id 去重**(acceptance-01 §A 关键不变量):
	 *   - 若 input.requestId 非空且已存在 → 返回 `{ auditId: <existing>, deduped: true }`,
	 *     不插入新行,不报错。
	 *   - 若 input.requestId 为 null/undefined 或尚不存在 → 插入新行,
	 *     返回 `{ auditId: <new-or-existing>, deduped: false }`。
	 *
	 * detail 通过 JSON.stringify 序列化为 detail_json;json_valid CHECK 通过
	 * (序列化保证合法 JSON;null/undefined → NULL)。
	 */
	append(input: AppendAuditInput): AppendAuditResult {
		const requestId = input.requestId ?? null;

		// 去重查询:request_id 非空时先查。
		if (requestId !== null) {
			const existing = this.db
				.prepare(`SELECT audit_id FROM wiki_audit_log WHERE request_id = ? LIMIT 1`)
				.get(requestId) as { audit_id: string } | undefined;
			if (existing) {
				return { auditId: existing.audit_id, deduped: true };
			}
		}

		const auditId = input.auditId ?? randomUUID();
		const now = new Date().toISOString();
		const detailJson = input.detail === undefined ? null : JSON.stringify(input.detail);

		this.db
			.prepare(
				`INSERT INTO wiki_audit_log
				   (audit_id, request_id, actor_agent_id, session_id, action,
				    node_path, old_revision, new_revision, detail_json, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				auditId,
				requestId,
				input.actorAgentId ?? null,
				input.sessionId ?? null,
				input.action,
				input.nodePath ?? null,
				input.oldRevision ?? null,
				input.newRevision ?? null,
				detailJson,
				now,
			);

		return { auditId, deduped: false };
	}

	/**
	 * 按 audit_id 查(PK)。不存在返回 undefined。
	 */
	getByAuditId(auditId: string): WikiAuditRow | undefined {
		return this.db
			.prepare(`SELECT * FROM wiki_audit_log WHERE audit_id = ?`)
			.get(auditId) as WikiAuditRow | undefined;
	}

	/**
	 * 按 request_id 查(UNIQUE)。不存在返回 undefined。便于调用方自检幂等。
	 */
	getByRequestId(requestId: string): WikiAuditRow | undefined {
		return this.db
			.prepare(`SELECT * FROM wiki_audit_log WHERE request_id = ?`)
			.get(requestId) as WikiAuditRow | undefined;
	}

	/**
	 * 按节点路径查审计历史(时间倒序,limit 上限 500)。
	 */
	listByNodePath(nodePath: string, limit = 100): WikiAuditRow[] {
		const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
		return this.db
			.prepare(
				`SELECT * FROM wiki_audit_log
				 WHERE node_path = ?
				 ORDER BY created_at DESC, audit_id DESC
				 LIMIT ?`,
			)
			.all(nodePath, safeLimit) as WikiAuditRow[];
	}

	/**
	 * 按 actor 查审计历史(时间倒序)。
	 */
	listByActor(actorAgentId: string, limit = 100): WikiAuditRow[] {
		const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
		return this.db
			.prepare(
				`SELECT * FROM wiki_audit_log
				 WHERE actor_agent_id = ?
				 ORDER BY created_at DESC, audit_id DESC
				 LIMIT ?`,
			)
			.all(actorAgentId, safeLimit) as WikiAuditRow[];
	}

	/**
	 * 按时间窗查审计历史(since/until ISO 字符串,可选;时间倒序)。
	 */
	listByTimeWindow(options: {
		since?: string | null;
		until?: string | null;
		limit?: number;
	}): WikiAuditRow[] {
		const safeLimit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 500));
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (options.since) {
			conditions.push("created_at >= ?");
			params.push(options.since);
		}
		if (options.until) {
			conditions.push("created_at <= ?");
			params.push(options.until);
		}
		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		return this.db
			.prepare(
				`SELECT * FROM wiki_audit_log
				 ${where}
				 ORDER BY created_at DESC, audit_id DESC
				 LIMIT ?`,
			)
			.all(...params, safeLimit) as WikiAuditRow[];
	}

	/**
	 * 统计总记录数(管理面健康指标)。
	 */
	count(): number {
		const row = this.db.prepare(`SELECT COUNT(*) AS n FROM wiki_audit_log`).get() as { n: number };
		return row.n;
	}
}
