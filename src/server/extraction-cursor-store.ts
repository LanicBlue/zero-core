// 提取 cursor 持久化 (v0.8 M5)
//
// # 文件说明书
//
// ## 核心功能
// 跟踪每个 session 的「已提取到哪个 step」(extraction cursor) 与「已经触发
// 过的低 checkpoint 阈值下标」。机制 2(低 checkpoint 增量提取)每次触发都
// 只处理 cursor 之后的 delta，而不是重新过整段 transcript；本表是这一
// 「增量」语义的物理载体(RFC §2.18 / 决策 53)。
//
// 重要:这是「提取 cursor」，**不是活 checkpoint**(决策 54 / acceptance-M5
// 末尾的回归检查)。当前工作态节点、transition 检测器都不存在；这里只记录
// 「内容记忆提取抽到哪里了」+「哪些 token-budget 阈值已 fire 过」，是机制 2
// 增量提取的副产品。
//
// ## steps-overhaul sub-10 — RETIRED (kept as inert CRUD utility)
// sub-7 retired 机制 2/3(wiki 抽取现在由 compressSession 的 Extractor A 多步
// agent 承担 — design.md「wiki memory」/ 决策 53 修订)。`extraction-hooks`
// 的 StepEnd 阈值触发器 + closeFlushSession 都已是 no-op stub。本 store 的
// **生产消费路径**(server/index.ts:145 → extractionDeps.cursorStore →
// registerExtractionHooks no-op)已 dead-end,无活 caller。
//
// **为什么不删**:本 store 是一个自包含的、有单测覆盖(m5-extractors.test.ts)
// 的 CRUD 持久化工具。删除它需要同步拆 m5-extractors.test.ts 的覆盖段 + 担心
// 老 DB 里残留的 extraction_cursors 表(CREATE TABLE IF NOT EXISTS,老库会有)。
// 收益(少几行 dead code)< 风险(破一个不相关的大测试文件 + 老 DB 兼容)。
// 故保留为 inert 工具 + 标注退役;未来若要彻底清理,删 store + session-db 的
// getExtractionCursorStore 访问器 + server/index.ts:145 的 cursorStore 字段 +
// m5-extractors.test.ts 的 ExtractionCursorStore 段。
//
// ## 输入
// - 构造时注入 better-sqlite3 Database(由 SessionDB 提供)
// - upsertCursor 接收 { sessionId, lastExtractedSeq, lastThresholdIdx, lastExtractedAt }
//
// ## 输出
// - getCursor 返回 ExtractionCursorRow | undefined
//
// ## 定位
// src/server/ 数据层，由 hooks/extraction-hooks.ts 在 PostTurnComplete +
// SessionEnd 调用，与 WikiStore(全局 memory 节点写入方)分离。
//
// ## 依赖
// - better-sqlite3
//
// ## 维护规则
// - 新增列必须同步 db-migration.ts 的 *_COLUMNS 数组
// - 表本身是 (sessionId) UNIQUE 的单行 per session
//

import type Database from "better-sqlite3";

export interface ExtractionCursorRow {
	sessionId: string;
	/** Step seq up to which extractor A has already processed (inclusive). */
	lastExtractedSeq: number;
	/**
	 * Index into the (RETIRED sub-7/sub-10) checkpointThresholds[] of the last
	 * threshold that fired an extraction. -1 = no threshold fired. The threshold
	 * list + its trigger are gone (see file header); this column is preserved
	 * on existing rows but never advanced going forward.
	 */
	lastThresholdIdx: number;
	/** ISO timestamp of last successful extraction. */
	lastExtractedAt: string;
	createdAt: string;
	updatedAt: string;
}

export class ExtractionCursorStore {
	private db: Database.Database;
	private upsertStmt: Database.Statement;
	private getStmt: Database.Statement;
	private deleteStmt: Database.Statement;

	constructor(db: Database.Database) {
		this.db = db;
		this.init();
		this.getStmt = this.db.prepare("SELECT * FROM extraction_cursors WHERE session_id = ?");
		this.upsertStmt = this.db.prepare(
			`INSERT INTO extraction_cursors (session_id, last_extracted_seq, last_threshold_idx, last_extracted_at, created_at, updated_at)
			 VALUES (@sessionId, @lastExtractedSeq, @lastThresholdIdx, @lastExtractedAt, @createdAt, @updatedAt)
			 ON CONFLICT(session_id) DO UPDATE SET
			   last_extracted_seq = excluded.last_extracted_seq,
			   last_threshold_idx = excluded.last_threshold_idx,
			   last_extracted_at  = excluded.last_extracted_at,
			   updated_at         = excluded.updated_at`,
		);
		this.deleteStmt = this.db.prepare("DELETE FROM extraction_cursors WHERE session_id = ?");
	}

	private init(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS extraction_cursors (
				session_id           TEXT PRIMARY KEY,
				last_extracted_seq   INTEGER NOT NULL DEFAULT -1,
				last_threshold_idx   INTEGER NOT NULL DEFAULT -1,
				last_extracted_at    TEXT,
				created_at           TEXT NOT NULL,
				updated_at           TEXT NOT NULL
			);
		`);
	}

	get(sessionId: string): ExtractionCursorRow | undefined {
		const row = this.getStmt.get(sessionId) as any;
		if (!row) return undefined;
		return {
			sessionId: row.session_id,
			lastExtractedSeq: row.last_extracted_seq,
			lastThresholdIdx: row.last_threshold_idx,
			lastExtractedAt: row.last_extracted_at,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	upsert(input: {
		sessionId: string;
		lastExtractedSeq: number;
		lastThresholdIdx: number;
		lastExtractedAt?: string;
	}): void {
		const now = new Date().toISOString();
		const existing = this.get(input.sessionId);
		const createdAt = existing?.createdAt ?? now;
		this.upsertStmt.run({
			sessionId: input.sessionId,
			lastExtractedSeq: input.lastExtractedSeq,
			lastThresholdIdx: input.lastThresholdIdx,
			lastExtractedAt: input.lastExtractedAt ?? now,
			createdAt,
			updatedAt: now,
		});
	}

	delete(sessionId: string): void {
		this.deleteStmt.run(sessionId);
	}
}
