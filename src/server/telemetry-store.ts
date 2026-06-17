// 工具遥测存储 (v0.8 M5 — extractor B 的写入目的地)
//
// # 文件说明书
//
// ## 核心功能
// 独立的工具调用遥测表(非 wiki 树):按 (sessionId, toolName, kind, signature)
// 累积失败/无效工具调用的样本(错参数、幻觉工具名、重复重试)。是「zero-core
// 自管理项目」的数据源(RFC §4.6 / 决策 49)，**v1 不做自管理**，仅写入。
//
// 重要:这些数据是平台改进数据(怎么让工具更不容易被叫错)，**不是项目知识、
// 也不是角色记忆** —— 所以不进 wiki 树(决策 46 N2 反例 + 决策 49)。
//
// ## 输入
// - 构造时注入 better-sqlite3 Database
// - record 接收 { sessionId, agentId, toolName, kind, signature, sample, occurrenceCount? }
//
// ## 输出
// - 按 (sessionId, toolName, kind, signature) upsert:命中则 occurrenceCount++
// - 列表/查询/清理接口(供未来自管理 agent 读)
//
// ## 定位
// src/server/ 数据层。由 extractor B 通过 hooks/extraction-hooks.ts 写入。
//
// ## 依赖
// - better-sqlite3、uuid
//
// ## 维护规则
// - 新增列必须同步 db-migration.ts 的 *_COLUMNS
// - occurrenceCount 是写时累加，不在读时计算
//

import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";

export type ToolTelemetryKind =
	| "bad_arguments"        // extractor B 判定:参数错(类型/键名/语义)
	| "hallucinated_tool"    // 不存在的工具名
	| "repeated_retry"       // 同一调用重复重试 N 次仍未成功
	| "other_failure";       // 其他失败模式(分类不清)

export interface ToolTelemetryInput {
	sessionId: string;
	agentId?: string;
	toolName: string;
	kind: ToolTelemetryKind;
	/** Stable signature to dedupe on (e.g. `bash#missing-flag--recursive`). */
	signature: string;
	/** One representative transcript snippet (capped). */
	sample?: string;
	occurrenceCount?: number;
}

export interface ToolTelemetryRecord {
	id: string;
	sessionId: string;
	agentId: string | null;
	toolName: string;
	kind: ToolTelemetryKind;
	signature: string;
	sample: string | null;
	occurrenceCount: number;
	createdAt: string;
	updatedAt: string;
}

export class TelemetryStore {
	private db: Database.Database;
	private findByKeyStmt: Database.Statement;
	private insertStmt: Database.Statement;
	private bumpCountStmt: Database.Statement;
	private listBySessionStmt: Database.Statement;
	private listAllStmt: Database.Statement;

	constructor(db: Database.Database) {
		this.db = db;
		this.init();
		this.findByKeyStmt = this.db.prepare(
			"SELECT * FROM tool_telemetry WHERE session_id = ? AND tool_name = ? AND kind = ? AND signature = ? LIMIT 1",
		);
		this.insertStmt = this.db.prepare(
			`INSERT INTO tool_telemetry (id, session_id, agent_id, tool_name, kind, signature, sample, occurrence_count, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.bumpCountStmt = this.db.prepare(
			"UPDATE tool_telemetry SET occurrence_count = occurrence_count + ?, sample = COALESCE(?, sample), updated_at = ? WHERE id = ?",
		);
		this.listBySessionStmt = this.db.prepare(
			"SELECT * FROM tool_telemetry WHERE session_id = ? ORDER BY updated_at DESC",
		);
		this.listAllStmt = this.db.prepare(
			"SELECT * FROM tool_telemetry ORDER BY updated_at DESC LIMIT ?",
		);
	}

	private init(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS tool_telemetry (
				id               TEXT PRIMARY KEY,
				session_id       TEXT NOT NULL,
				agent_id         TEXT,
				tool_name        TEXT NOT NULL,
				kind             TEXT NOT NULL,
				signature        TEXT NOT NULL,
				sample           TEXT,
				occurrence_count INTEGER NOT NULL DEFAULT 1,
				created_at       TEXT NOT NULL,
				updated_at       TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_telemetry_session ON tool_telemetry(session_id);
			CREATE INDEX IF NOT EXISTS idx_telemetry_tool_kind ON tool_telemetry(tool_name, kind);
		`);
	}

	record(input: ToolTelemetryInput): ToolTelemetryRecord {
		const now = new Date().toISOString();
		const sample = input.sample ? input.sample.slice(0, 4000) : null;
		const bump = input.occurrenceCount ?? 1;
		const existing = this.findByKeyStmt.get(
			input.sessionId, input.toolName, input.kind, input.signature,
		) as any;
		if (existing) {
			this.bumpCountStmt.run(bump, sample, now, existing.id);
			return this.rowToRecord(this.findByKeyStmt.get(
				input.sessionId, input.toolName, input.kind, input.signature,
			) as any);
		}
		const id = uuid();
		this.insertStmt.run(
			id, input.sessionId, input.agentId ?? null,
			input.toolName, input.kind, input.signature,
			sample, bump, now, now,
		);
		return this.rowToRecord(this.findByKeyStmt.get(
			input.sessionId, input.toolName, input.kind, input.signature,
		) as any);
	}

	recordMany(inputs: ToolTelemetryInput[]): ToolTelemetryRecord[] {
		const out: ToolTelemetryRecord[] = [];
		const txn = this.db.transaction(() => {
			for (const i of inputs) out.push(this.record(i));
		});
		txn();
		return out;
	}

	listBySession(sessionId: string): ToolTelemetryRecord[] {
		return (this.listBySessionStmt.all(sessionId) as any[]).map(r => this.rowToRecord(r));
	}

	listAll(limit: number = 200): ToolTelemetryRecord[] {
		return (this.listAllStmt.all(limit) as any[]).map(r => this.rowToRecord(r));
	}

	private rowToRecord(r: any): ToolTelemetryRecord {
		return {
			id: r.id,
			sessionId: r.session_id,
			agentId: r.agent_id,
			toolName: r.tool_name,
			kind: r.kind,
			signature: r.signature,
			sample: r.sample,
			occurrenceCount: r.occurrence_count,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		};
	}
}
