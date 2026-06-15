// 记忆节点持久化存储
//
// Wiki 风格的记忆节点系统，所有 agent 共享全局 memory wiki。
// 包含记忆节点（memory_nodes）、主体节点（memory_subjects）、主体关系（memory_edges）
// 和 FTS5 全文搜索虚拟表。
//
// # 文件说明书
//
// ## 核心功能
// 在 better-sqlite3 上维护全局记忆 wiki:节点按 (subject, type) 唯一演化(evolved_from)、主体(MOC)的计数与摘要、主体间关系边、以及基于 FTS5 的全文检索;同主体同类型节点再次写入会演化为更新而非新增。
//
// ## 输入
// - 构造时注入 better-sqlite3 Database(由 SessionDB 提供)
// - upsertNode / upsertNodes 接收 { subject, type: event|decision|discovery|status_change|preference, content } 与可选 sessionId / sourceSeq
// - searchNodes 接收查询字符串
// - createEdge / getRelatedSubjects 接收 subject 名称与 relation
//
// ## 输出
// - 节点 CRUD 返回 MemoryNode;getSubject 返回 MemorySubject;searchNodes 返回 { node, subject }[]
//
// ## 定位
// src/server/ 数据层,被 SessionDB 持有并暴露给 memory-node-router 与 agent 运行时 hook。
//
// ## 依赖
// - better-sqlite3、uuid
// - ../core/logger(log)
// - 数据库表 memory_nodes / memory_subjects / memory_edges / memory_nodes_fts 由 init() 自建
//
// ## 维护规则
// - 新增数据库列必须同步更新 db-migration.ts 的列清单(否则 fresh DB 会缺列)。
// - FTS5 表无法 ALTER,init() 在检测到旧 FTS 表时会 DROP 重建;schema 变更时复用此模式。
// - 搜索失败时回退到 LIKE,不要让 FTS 不可用直接报错给上层。
// - 节点类型集合 MEMORY_NODE_TYPES 是契约,新增类型需同步 agent 写入端与前端展示。
//

import type Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryNodeInput {
	subject: string;
	type: "event" | "decision" | "discovery" | "status_change" | "preference";
	content: string;
}

export interface MemoryNode extends MemoryNodeInput {
	id: string;
	sessionId: string | null;
	sourceSeq: number | null;
	evolvedFrom: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface MemorySubject {
	subject: string;
	kind: string | null;
	nodeCount: number;
	summary: string | null;
	createdAt: string;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// MemoryNodeStore
// ---------------------------------------------------------------------------

const MEMORY_NODE_TYPES = new Set(["event", "decision", "discovery", "status_change", "preference"]);

export class MemoryNodeStore {
	private db: Database.Database;

	private upsertNodeStmt: Database.Statement;
	private findNodeBySubjectTypeStmt: Database.Statement;
	private getNodeStmt: Database.Statement;
	private getNodesForSubjectStmt: Database.Statement;
	private getRecentNodesStmt: Database.Statement;
	private deleteNodeStmt: Database.Statement;
	private ensureSubjectStmt: Database.Statement;
	private getSubjectStmt: Database.Statement;
	private updateSubjectCountStmt: Database.Statement;
	private insertEdgeStmt: Database.Statement;
	private getEdgesStmt: Database.Statement;
	private searchFtsStmt: Database.Statement;
	private insertFtsStmt: Database.Statement;
	private deleteFtsStmt: Database.Statement;

	constructor(db: Database.Database) {
		this.db = db;
		this.init();

		this.findNodeBySubjectTypeStmt = this.db.prepare(
			"SELECT * FROM memory_nodes WHERE subject = ? AND type = ? ORDER BY updated_at DESC LIMIT 1",
		);
		this.getNodeStmt = this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?");
		this.getNodesForSubjectStmt = this.db.prepare(
			"SELECT * FROM memory_nodes WHERE subject = ? ORDER BY updated_at DESC",
		);
		this.getRecentNodesStmt = this.db.prepare(
			"SELECT * FROM memory_nodes ORDER BY updated_at DESC LIMIT ?",
		);
		this.deleteNodeStmt = this.db.prepare("DELETE FROM memory_nodes WHERE id = ?");
		this.upsertNodeStmt = this.db.prepare(
			`INSERT INTO memory_nodes (id, session_id, subject, type, content, source_seq, evolved_from, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.ensureSubjectStmt = this.db.prepare(
			`INSERT INTO memory_subjects (subject, kind, node_count, summary, created_at, updated_at)
			 VALUES (?, ?, 0, NULL, ?, ?)
			 ON CONFLICT(subject) DO UPDATE SET updated_at = excluded.updated_at`,
		);
		this.getSubjectStmt = this.db.prepare("SELECT * FROM memory_subjects WHERE subject = ?");
		this.updateSubjectCountStmt = this.db.prepare(
			"UPDATE memory_subjects SET node_count = (SELECT COUNT(*) FROM memory_nodes WHERE subject = memory_subjects.subject), updated_at = ? WHERE subject = ?",
		);
		this.insertEdgeStmt = this.db.prepare(
			`INSERT INTO memory_edges (id, from_subject, to_subject, relation, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
		);
		this.getEdgesStmt = this.db.prepare(
			"SELECT from_subject, to_subject, relation FROM memory_edges WHERE from_subject = ? OR to_subject = ?",
		);
		this.searchFtsStmt = this.db.prepare(
			"SELECT rowid, subject, content FROM memory_nodes_fts WHERE memory_nodes_fts MATCH ? ORDER BY rank LIMIT ?",
		);
		this.insertFtsStmt = this.db.prepare(
			"INSERT INTO memory_nodes_fts (rowid, subject, content) VALUES (?, ?, ?)",
		);
		this.deleteFtsStmt = this.db.prepare(
			"DELETE FROM memory_nodes_fts WHERE rowid = ?",
		);
	}

	private init(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS memory_nodes (
				id           TEXT PRIMARY KEY,
				session_id   TEXT,
				subject      TEXT NOT NULL,
				type         TEXT NOT NULL,
				content      TEXT NOT NULL,
				source_seq   INTEGER,
				evolved_from TEXT,
				created_at   TEXT NOT NULL,
				updated_at   TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_nodes_subject ON memory_nodes(subject);
			CREATE INDEX IF NOT EXISTS idx_memory_nodes_subject_type ON memory_nodes(subject, type);

			CREATE TABLE IF NOT EXISTS memory_subjects (
				subject    TEXT PRIMARY KEY,
				kind       TEXT,
				node_count INTEGER NOT NULL DEFAULT 0,
				summary    TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS memory_edges (
				id           TEXT PRIMARY KEY,
				from_subject TEXT NOT NULL,
				to_subject   TEXT NOT NULL,
				relation     TEXT NOT NULL,
				created_at   TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(from_subject);
		`);

		// FTS5 — rebuild if schema changed (FTS5 tables cannot be ALTERed)
		try {
			const ftsCols = (this.db.pragma("table_info(memory_nodes_fts)") as Array<{ name: string }>).map(r => r.name);
			if (ftsCols.length > 0) {
				// Old FTS table exists — drop and recreate to ensure correct schema
				this.db.exec("DROP TABLE IF EXISTS memory_nodes_fts");
			}
			this.db.exec(`
				CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(
					subject,
					content,
					content='memory_nodes',
					content_rowid='rowid',
					tokenize='unicode61'
				);
			`);
		} catch {
			log.warn("memory", "FTS5 virtual table creation skipped (may already exist or unsupported)");
		}
	}

	// ─── Node CRUD ──────────────────────────────────────

	upsertNode(sessionId: string | null, input: MemoryNodeInput, sourceSeq?: number): MemoryNode {
		if (!MEMORY_NODE_TYPES.has(input.type)) {
			throw new Error(`Invalid memory node type: ${input.type}`);
		}

		const now = new Date().toISOString();

		// Check for existing node with same subject + type
		const existing = this.findNodeBySubjectTypeStmt.get(input.subject, input.type) as any;

		if (existing) {
			// Evolve: update existing node
			const id = existing.id;
			this.db.prepare(
				"UPDATE memory_nodes SET content = ?, evolved_from = ?, updated_at = ? WHERE id = ?",
			).run(input.content, id, now, id);

			// Update FTS
			try { this.deleteFtsStmt.run(existing.rowid); } catch { /* fts may not exist */ }
			try { this.insertFtsStmt.run(existing.rowid, input.subject, input.content); } catch { /* fts may not exist */ }

			this.refreshSubject(input.subject);
			return this.getNode(id)!;
		}

		// Create new node
		const id = uuid();
		this.upsertNodeStmt.run(id, sessionId, input.subject, input.type, input.content, sourceSeq ?? null, null, now, now);

		// Get rowid for FTS
		const row = this.db.prepare("SELECT rowid FROM memory_nodes WHERE id = ?").get(id) as any;
		if (row) {
			try { this.insertFtsStmt.run(row.rowid, input.subject, input.content); } catch { /* fts may not exist */ }
		}

		this.ensureSubject(input.subject);
		this.refreshSubject(input.subject);
		return this.getNode(id)!;
	}

	upsertNodes(sessionId: string | null, inputs: MemoryNodeInput[]): MemoryNode[] {
		const results: MemoryNode[] = [];
		const txn = this.db.transaction(() => {
			for (const input of inputs) {
				results.push(this.upsertNode(sessionId, input));
			}
		});
		txn();
		return results;
	}

	getNode(id: string): MemoryNode | undefined {
		const row = this.getNodeStmt.get(id) as any;
		return row ? this.rowToNode(row) : undefined;
	}

	getNodesForSubject(subject: string): MemoryNode[] {
		return (this.getNodesForSubjectStmt.all(subject) as any[]).map(r => this.rowToNode(r));
	}

	getRecentNodes(limit: number = 20): MemoryNode[] {
		return (this.getRecentNodesStmt.all(limit) as any[]).map(r => this.rowToNode(r));
	}

	deleteNode(id: string): void {
		const row = this.db.prepare("SELECT rowid, subject FROM memory_nodes WHERE id = ?").get(id) as any;
		if (!row) return;
		this.deleteNodeStmt.run(id);
		try { this.deleteFtsStmt.run(row.rowid); } catch { /* fts */ }
		this.refreshSubject(row.subject);
	}

	// ─── Search (FTS5) ─────────────────────────────────

	searchNodes(query: string, limit: number = 10): Array<{ node: MemoryNode; subject: MemorySubject | null }> {
		// Escape FTS5 special characters
		const safeQuery = query.replace(/["'*:+-]/g, " ").trim().split(/\s+/).filter(Boolean).join(" OR ");
		if (!safeQuery) return [];

		let rows: any[];
		try {
			rows = this.searchFtsStmt.all(safeQuery, limit) as any[];
		} catch {
			// FTS fallback to LIKE
			rows = this.db.prepare(
				"SELECT id, subject, type, content FROM memory_nodes WHERE subject LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT ?",
			).all(`%${query}%`, `%${query}%`, limit) as any[];
		}

		return rows.map(r => {
			const nodeId = r.id || r.rowid;
			const node = this.getNode(nodeId);
			if (!node) return null;
			return { node, subject: this.getSubject(node.subject) };
		}).filter(Boolean) as Array<{ node: MemoryNode; subject: MemorySubject | null }>;
	}

	// ─── Subject (MOC) ─────────────────────────────────

	ensureSubject(subject: string, kind?: string): void {
		const now = new Date().toISOString();
		this.ensureSubjectStmt.run(subject, kind ?? null, now, now);
	}

	getSubject(subject: string): MemorySubject | null {
		const row = this.getSubjectStmt.get(subject) as any;
		return row ? this.rowToSubject(row) : null;
	}

	refreshSubject(subject: string): void {
		const now = new Date().toISOString();
		this.ensureSubject(subject);
		this.updateSubjectCountStmt.run(now, subject);
	}

	// ─── Edges ──────────────────────────────────────────

	createEdge(fromSubject: string, toSubject: string, relation: string): void {
		this.ensureSubject(fromSubject);
		this.ensureSubject(toSubject);
		this.insertEdgeStmt.run(uuid(), fromSubject, toSubject, relation, new Date().toISOString());
	}

	getRelatedSubjects(subject: string): Array<{ subject: string; relation: string }> {
		return (this.getEdgesStmt.all(subject, subject) as any[]).map(r => ({
			subject: r.from_subject === subject ? r.to_subject : r.from_subject,
			relation: r.relation,
		}));
	}

	// ─── Helpers ────────────────────────────────────────

	private rowToNode(r: any): MemoryNode {
		return {
			id: r.id,
			subject: r.subject,
			type: r.type,
			content: r.content,
			sessionId: r.session_id,
			sourceSeq: r.source_seq,
			evolvedFrom: r.evolved_from,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		};
	}

	private rowToSubject(r: any): MemorySubject {
		return {
			subject: r.subject,
			kind: r.kind,
			nodeCount: r.node_count,
			summary: r.summary,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		};
	}
}
