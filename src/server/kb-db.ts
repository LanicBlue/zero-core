import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// KB Database — stores chunks + embeddings for knowledge bases
// ---------------------------------------------------------------------------

export interface KbChunk {
	id: number;
	kbId: string;
	filePath: string;
	chunkIndex: number;
	content: string;
	embedding: Float32Array | null;
	tokenCount: number;
	createdAt: string;
}

export class KbDB {
	private db: Database.Database;

	constructor(dbPath?: string) {
		const path = dbPath ?? join(homedir(), ".zero-core", "knowledge.db");
		const dir = join(path, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		this.db = new Database(path);
		this.db.pragma("journal_mode = WAL");
		this.initSchema();
	}

	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS kb_chunks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				kb_id TEXT NOT NULL,
				file_path TEXT NOT NULL,
				chunk_index INTEGER NOT NULL,
				content TEXT NOT NULL,
				embedding BLOB,
				token_count INTEGER,
				created_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON kb_chunks(kb_id);
			CREATE INDEX IF NOT EXISTS idx_kb_chunks_file ON kb_chunks(kb_id, file_path);
		`);
	}

	insertChunk(kbId: string, filePath: string, chunkIndex: number, content: string, embedding: Float32Array | null, tokenCount: number): number {
		const now = new Date().toISOString();
		const embBuf = embedding ? Buffer.from(new Uint8Array(embedding.buffer)) : null;
		const result = this.db.prepare(
			"INSERT INTO kb_chunks (kb_id, file_path, chunk_index, content, embedding, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(kbId, filePath, chunkIndex, content, embBuf, tokenCount, now);
		return Number(result.lastInsertRowid);
	}

	insertChunksBatch(chunks: { kbId: string; filePath: string; chunkIndex: number; content: string; embedding: Float32Array | null; tokenCount: number }[]): void {
		const now = new Date().toISOString();
		const tx = this.db.transaction(() => {
			const stmt = this.db.prepare(
				"INSERT INTO kb_chunks (kb_id, file_path, chunk_index, content, embedding, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			);
			for (const c of chunks) {
				const embBuf = c.embedding ? Buffer.from(new Uint8Array(c.embedding.buffer)) : null;
				stmt.run(c.kbId, c.filePath, c.chunkIndex, c.content, embBuf, c.tokenCount, now);
			}
		});
		tx();
	}

	deleteFileChunks(kbId: string, filePath: string): void {
		this.db.prepare("DELETE FROM kb_chunks WHERE kb_id = ? AND file_path = ?").run(kbId, filePath);
	}

	deleteKbChunks(kbId: string): void {
		this.db.prepare("DELETE FROM kb_chunks WHERE kb_id = ?").run(kbId);
	}

	getChunkCount(kbId: string): number {
		const row = this.db.prepare("SELECT COUNT(*) as cnt FROM kb_chunks WHERE kb_id = ?").get(kbId) as any;
		return row.cnt;
	}

	getFileChunkCount(kbId: string, filePath: string): number {
		const row = this.db.prepare("SELECT COUNT(*) as cnt FROM kb_chunks WHERE kb_id = ? AND file_path = ?").get(kbId, filePath) as any;
		return row.cnt;
	}

	getAllChunksForSearch(kbId: string): { id: number; content: string; embedding: Buffer | null; file_path: string }[] {
		return this.db.prepare(
			"SELECT id, content, embedding, file_path FROM kb_chunks WHERE kb_id = ? AND embedding IS NOT NULL",
		).all(kbId) as any[];
	}

	getFileList(kbId: string): { file_path: string; chunk_count: number }[] {
		return this.db.prepare(
			"SELECT file_path, COUNT(*) as chunk_count FROM kb_chunks WHERE kb_id = ? GROUP BY file_path",
		).all(kbId) as any[];
	}

	close(): void {
		this.db.close();
	}
}
