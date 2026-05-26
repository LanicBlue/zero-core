import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { readFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// SqliteStore — generic CRUD over a single SQLite table
// ---------------------------------------------------------------------------

/**
 * Generic SQLite-backed store for records with `id`, `createdAt`, `updatedAt`.
 *
 * Complex sub-fields (objects, arrays) are stored as JSON TEXT columns.
 * The caller provides column definitions with optional JSON and column-name overrides.
 */
export class SqliteStore<T extends { id: string; createdAt: string; updatedAt: string }> {
	private db: Database.Database;
	private table: string;
	private jsonColumns: Set<string>;
	private boolColumns: Set<string>;
	private columnMap: Record<string, string>; // camelKey → snake_col
	private reverseMap: Record<string, string>; // snake_col → camelKey
	private allColumns: string[]; // snake_case column names

	// Prepared statements
	private _listStmt!: Database.Statement;
	private _getStmt!: Database.Statement;
	private _insertStmt!: Database.Statement;
	private _updateStmt!: Database.Statement;
	private _deleteStmt!: Database.Statement;

	constructor(
		db: Database.Database,
		table: string,
		columns: ColumnDef[],
	) {
		this.db = db;
		this.table = table;
		this.jsonColumns = new Set(columns.filter((c) => c.json).map((c) => c.key));
		this.boolColumns = new Set(columns.filter((c) => c.bool).map((c) => c.key));
		this.columnMap = {};
		this.reverseMap = {};
		this.allColumns = [];

		for (const col of columns) {
			const snake = col.column ?? camelToSnake(col.key);
			this.columnMap[col.key] = snake;
			this.reverseMap[snake] = col.key;
			this.allColumns.push(snake);
		}

		// Ensure id/createdAt/updatedAt always present
		if (!this.columnMap.id) {
			this.columnMap["id"] = "id";
			this.reverseMap["id"] = "id";
			this.allColumns.unshift("id");
		}
		if (!this.columnMap.createdAt) {
			this.columnMap["createdAt"] = "created_at";
			this.reverseMap["created_at"] = "createdAt";
			if (!this.allColumns.includes("created_at")) this.allColumns.push("created_at");
		}
		if (!this.columnMap.updatedAt) {
			this.columnMap["updatedAt"] = "updated_at";
			this.reverseMap["updated_at"] = "updatedAt";
			if (!this.allColumns.includes("updated_at")) this.allColumns.push("updated_at");
		}

		this.initStatements();
	}

	private initStatements(): void {
		const cols = this.allColumns;
		const nonIdCols = cols.filter((c) => c !== "id");

		this._listStmt = this.db.prepare(`SELECT ${cols.join(", ")} FROM ${this.table}`);
		this._getStmt = this.db.prepare(`SELECT ${cols.join(", ")} FROM ${this.table} WHERE id = ?`);
		this._deleteStmt = this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`);

		// INSERT — all columns
		const placeholders = cols.map(() => "?").join(", ");
		this._insertStmt = this.db.prepare(
			`INSERT INTO ${this.table} (${cols.join(", ")}) VALUES (${placeholders})`,
		);

		// UPDATE — SET non-id columns WHERE id = ?
		const setClauses = nonIdCols.map((c) => `${c} = ?`).join(", ");
		this._updateStmt = this.db.prepare(
			`UPDATE ${this.table} SET ${setClauses} WHERE id = ?`,
		);
	}

	// ─── CRUD ──────────────────────────────────────────────────

	list(): T[] {
		return (this._listStmt.all() as Record<string, any>[]).map((r) => this.rowToRecord(r));
	}

	get(id: string): T | undefined {
		const row = this._getStmt.get(id) as Record<string, any> | undefined;
		return row ? this.rowToRecord(row) : undefined;
	}

	create(input: Omit<T, "id" | "createdAt" | "updatedAt">): T {
		const now = new Date().toISOString();
		const record = { ...input, id: uuidv4(), createdAt: now, updatedAt: now } as unknown as T;
		this.insertRow(record);
		return record;
	}

	update(id: string, input: Partial<Omit<T, "id" | "createdAt">>): T {
		const existing = this.get(id);
		if (!existing) throw new Error(`${this.table} record not found: ${id}`);

		const merged = {
			...existing,
			...input,
			updatedAt: new Date().toISOString(),
		} as unknown as T;

		this.updateRow(id, merged);
		return merged;
	}

	delete(id: string): void {
		this._deleteStmt.run(id);
	}

	/**
	 * Bulk insert from a JSON file migration.
	 * Returns the count of migrated records.
	 */
	migrateFromJson(
		jsonPath: string,
		arrayKey: string,
		transform?: (raw: any) => any,
	): number {
		if (!existsSync(jsonPath)) return 0;

		let records: any[];
		try {
			const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
			records = data[arrayKey] ?? [];
		} catch {
			return 0;
		}

		if (records.length === 0) return 0;

		const tx = this.db.transaction(() => {
			for (const raw of records) {
				const record = transform ? transform(raw) : raw;
				this.insertRow(record);
			}
		});
		tx();

		// Backup the JSON file
		try {
			renameSync(jsonPath, jsonPath + ".migrated.bak");
		} catch { /* keep both */ }

		log.db(`Migrated ${records.length} records from ${jsonPath} → ${this.table}`);
		return records.length;
	}

	// ─── Helpers ───────────────────────────────────────────────

	private insertRow(record: T): void {
		const values = this.allColumns.map((snakeCol) => this.toColumnValue(record, snakeCol));
		this._insertStmt.run(...values);
	}

	private updateRow(id: string, record: T): void {
		const nonIdCols = this.allColumns.filter((c) => c !== "id");
		const values = nonIdCols.map((snakeCol) => this.toColumnValue(record, snakeCol));
		values.push(id); // WHERE id = ?
		this._updateStmt.run(...values);
	}

	private toColumnValue(record: T, snakeCol: string): any {
		const camelKey = this.reverseMap[snakeCol] ?? snakeCol;
		const val = (record as any)[camelKey];
		if (val === undefined) return null;
		if (this.boolColumns.has(camelKey)) return val ? 1 : 0;
		if (this.jsonColumns.has(camelKey) && typeof val === "object") {
			return JSON.stringify(val);
		}
		return val;
	}

	private rowToRecord(row: Record<string, any>): T {
		const record: Record<string, any> = {};
		for (const [snakeCol, val] of Object.entries(row)) {
			const camelKey = this.reverseMap[snakeCol] ?? snakeCol;
			if (this.jsonColumns.has(camelKey) && typeof val === "string") {
				try {
					record[camelKey] = JSON.parse(val);
				} catch {
					record[camelKey] = val;
				}
			} else if (this.boolColumns.has(camelKey)) {
				record[camelKey] = val === 1;
			} else {
				record[camelKey] = val;
			}
		}
		return record as T;
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColumnDef {
	/** camelCase property name on the TS type */
	key: string;
	/** Override column name (defaults to snake_case of key) */
	column?: string;
	/** If true, serialize/deserialize as JSON TEXT */
	json?: boolean;
	/** If true, convert boolean ↔ INTEGER 0/1 */
	bool?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function camelToSnake(s: string): string {
	return s.replace(/[A-Z]/g, (ch) => "_" + ch.toLowerCase());
}
