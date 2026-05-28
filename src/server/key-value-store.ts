import type Database from "better-sqlite3";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// KeyValueStore — simple key-value persistence over SQLite
// Used to replace scattered JSON config files with a single table.
// ---------------------------------------------------------------------------

export class KeyValueStore {
	private db: Database.Database;
	private getStmt: Database.Statement;
	private setStmt: Database.Statement;
	private deleteStmt: Database.Statement;
	private listStmt: Database.Statement;

	constructor(db: Database.Database) {
		this.db = db;
		this.init();

		this.getStmt = this.db.prepare("SELECT value FROM kv_store WHERE key = ?");
		this.setStmt = this.db.prepare(
			"INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
		);
		this.deleteStmt = this.db.prepare("DELETE FROM kv_store WHERE key = ?");
		this.listStmt = this.db.prepare("SELECT key, value FROM kv_store ORDER BY key");
	}

	private init(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS kv_store (
				key   TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
	}

	get(key: string): string | null {
		const row = this.getStmt.get(key) as { value: string } | undefined;
		return row?.value ?? null;
	}

	getJson<T>(key: string): T | null {
		const raw = this.get(key);
		if (raw === null) return null;
		try {
			return JSON.parse(raw) as T;
		} catch {
			return null;
		}
	}

	set(key: string, value: string): void {
		const now = new Date().toISOString();
		this.setStmt.run(key, value, now);
	}

	setJson(key: string, value: unknown): void {
		this.set(key, JSON.stringify(value, null, 2));
	}

	delete(key: string): void {
		this.deleteStmt.run(key);
	}

	list(): Array<{ key: string; value: string }> {
		return this.listStmt.all() as Array<{ key: string; value: string }>;
	}

	/**
	 * Migrate from a JSON file. If the key already exists in SQLite, skip.
	 * On success, renames the JSON file to `.migrated.bak`.
	 */
	migrateFromJsonFile(key: string, jsonPath: string): boolean {
		// Skip if already migrated
		if (this.get(key) !== null) return false;

		if (!existsSync(jsonPath)) return false;

		try {
			const raw = readFileSync(jsonPath, "utf-8");
			JSON.parse(raw); // validate
			this.set(key, raw);

			try { renameSync(jsonPath, jsonPath + ".migrated.bak"); } catch { /* keep both */ }

			log.db(`Migrated JSON → kv_store[${key}] from ${jsonPath}`);
			return true;
		} catch {
			return false;
		}
	}
}
