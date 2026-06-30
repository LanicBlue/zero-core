// SQLite 通用存储
//
// # 文件说明书
//
// ## 核心功能
// 通用 SQLite CRUD 操作，提供表级别的增删改查。
//
// ## 输入
// - Database 实例
// - 表名
//
// ## 输出
// - CRUD 操作结果
//
// ## 定位
// 服务层数据访问，被各种 Store 使用。
//
// ## 依赖
// - better-sqlite3 - SQLite 驱动
// - uuid - ID 生成
//
// ## 维护规则
// - 新增列时需同步更新 COLUMNS 数组
// - 保持查询性能
//
import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { readFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../core/logger.js";
import { emitDataChange } from "./data-change-hub.js";

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
	private numberColumns: Set<string>;
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
		this.numberColumns = new Set(columns.filter((c) => c.number).map((c) => c.key));
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

		this.ensureTable();
		this.initStatements();
	}

	private columnDef(snakeCol: string): string {
		if (snakeCol === "id") return "id TEXT PRIMARY KEY";
		if (snakeCol === "created_at" || snakeCol === "updated_at") return `${snakeCol} TEXT NOT NULL`;
		if (snakeCol === "is_main") return `${snakeCol} INTEGER NOT NULL DEFAULT 0`;
		if (snakeCol === "enabled" || snakeCol === "is_system" || snakeCol === "is_built_in") return `${snakeCol} INTEGER DEFAULT 0`;
		return `${snakeCol} TEXT`;
	}

	private ensureTable(): void {
		const colDefs = this.allColumns.map((c) => this.columnDef(c));
		this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (${colDefs.join(", ")})`);

		// Self-heal: add any declared columns missing from the actual table.
		// This protects against the dual-source bug where db-migration.ts's
		// *_COLUMNS arrays drift out of sync with a store's COLUMNS.
		const actualCols = new Set(
			(this.db.pragma(`table_info(${this.table})`) as Array<{ name: string }>).map((r) => r.name),
		);
		for (const col of this.allColumns) {
			if (!actualCols.has(col)) {
				this.db.exec(`ALTER TABLE ${this.table} ADD COLUMN ${this.columnDef(col)}`);
			}
		}
	}

	/** Safely add a column if it doesn't exist yet (for progressive schema migration). */
	ensureColumn(columnName: string, columnDef: string): void {
		try {
			const cols = (this.db.pragma(`table_info(${this.table})`) as Array<{ name: string }>).map((r) => r.name);
			if (!cols.includes(columnName)) {
				this.db.exec(`ALTER TABLE ${this.table} ADD COLUMN ${columnName} ${columnDef}`);
			}
		} catch { /* column may already exist */ }
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

	/**
	 * Find a single record by an equality filter on one or more columns, using
	 * an indexed SELECT (not a full-table `list().find()`). Callers pass record
	 * KEYS (camelCase); they map to snake_case columns. Use this on indexed
	 * column combos (e.g. parent_id + path) to avoid the O(N) scan that
	 * `list().find()` would do per call — critical for hot paths like the
	 * archivist scan, which upserts thousands of nodes and previously spent
	 * minutes re-scanning the whole table on each upsert.
	 */
	findByColumns(filter: Partial<Record<string, string | undefined>>): T | undefined {
		const entries = Object.entries(filter).filter(([, v]) => v !== undefined);
		if (entries.length === 0) return undefined;
		const where = entries
			.map(([key]) => `${this.columnMap[key] ?? key} = ?`)
			.join(" AND ");
		const row = this.db
			.prepare(`SELECT ${this.allColumns.join(", ")} FROM ${this.table} WHERE ${where}`)
			.get(...entries.map(([, v]) => v)) as Record<string, any> | undefined;
		return row ? this.rowToRecord(row) : undefined;
	}

	/**
	 * Find ALL records matching an equality filter, via an indexed SELECT
	 * (counterpart to findByColumns for multi-row results). Use this instead of
	 * `list().filter(...)` on hot paths — e.g. getChildren(parentId) is called
	 * once per wiki-node insert and must hit idx_wiki_parent, not scan the table.
	 */
	findAllByColumns(filter: Partial<Record<string, string | undefined>>): T[] {
		const entries = Object.entries(filter).filter(([, v]) => v !== undefined);
		if (entries.length === 0) return this.list();
		const where = entries
			.map(([key]) => `${this.columnMap[key] ?? key} = ?`)
			.join(" AND ");
		const rows = this.db
			.prepare(`SELECT ${this.allColumns.join(", ")} FROM ${this.table} WHERE ${where}`)
			.all(...entries.map(([, v]) => v)) as Record<string, any>[];
		return rows.map((r) => this.rowToRecord(r));
	}

	create(input: Omit<T, "id" | "createdAt" | "updatedAt">): T {
		const now = new Date().toISOString();
		const record = { ...input, id: uuidv4(), createdAt: now, updatedAt: now } as unknown as T;
		this.insertRow(record);
		return record;
	}

	/**
	 * Create a record with a **caller-supplied id** (instead of an auto-generated
	 * uuid). Used by TemplateStore to seed built-in templates with stable ids so
	 * they can be referenced deterministically (e.g. `instantiateTemplate("zero")`).
	 * Callers must ensure the id is unique within the table.
	 */
	createWithId(id: string, input: Omit<T, "id" | "createdAt" | "updatedAt">): T {
		const now = new Date().toISOString();
		const record = { ...input, id, createdAt: now, updatedAt: now } as unknown as T;
		this.insertRow(record);
		return record;
	}

	update(id: string, input: Partial<Omit<T, "id" | "createdAt">>): T {
		const existing = this.get(id);
		if (!existing) throw new Error(`${this.table} record not found: ${id}`);

		// No-op detection: if every field in the patch already equals the
		// existing value, there's nothing to change — skip the write AND the
		// change notification. This prevents spurious UI refreshes (and
		// updatedAt churn) from updates that change nothing.
		//
		// Scalars are stored as TEXT and read back as strings, and a JS number
		// round-trips as its REAL text form (2 → "2.0"). So a naive JSON/String
		// compare wrongly flags 1 ≠ "1.0" as a change. JSON columns compare
		// structurally; scalars compare numerically when both sides are numeric
		// (so 2 and "2.0" match), else as strings.
		const patchKeys = Object.keys(input as object);
		const isNoOp = patchKeys.every((k) => {
			const v = (input as any)[k];
			if (v === undefined) return true;
			const cur = (existing as any)[k];
			if (this.jsonColumns.has(k)) {
				try { return JSON.stringify(cur) === JSON.stringify(v); } catch { return false; }
			}
			return scalarEqual(cur, v);
		});
		if (isNoOp) return existing;

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
		emitDataChange(this.table, id, "delete");
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
		emitDataChange(this.table, record.id, "create", record);
	}

	private updateRow(id: string, record: T): void {
		const nonIdCols = this.allColumns.filter((c) => c !== "id");
		const values = nonIdCols.map((snakeCol) => this.toColumnValue(record, snakeCol));
		values.push(id); // WHERE id = ?
		this._updateStmt.run(...values);
		emitDataChange(this.table, id, "update", record);
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
			} else if (this.numberColumns.has(camelKey)) {
				// 数字列:TEXT 亲和会把数字存成 REAL 文本("2.0"),集中在这里强转成
				// JS number,下游再不必各自 Number() 兜底(过去 maxConcurrency 漏转就出 bug)。
				record[camelKey] = val == null ? val : Number(val);
			} else if (this.boolColumns.has(camelKey)) {
				// bool 列写的是 1/0,但列若是 TEXT 亲和(未特判为 INTEGER 的列,
				// 如 enable_concurrency_limit),SQLite 会把 1 存成 REAL 文本 "1.0"。
				// 严格 === 1 会让 "1.0" 读成 false → checkbox 保存后重置。按数值判定:
				// 1 / 1.0 / "1" / "1.0" / true → true;0 / "0" / "0.0" / null → false。
				record[camelKey] = Number(val) === 1;
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
	/** If true, coerce read value through Number() → JS number (for numeric TEXT columns whose stored form is "2.0") */
	number?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function camelToSnake(s: string): string {
	return s.replace(/[A-Z]/g, (ch) => "_" + ch.toLowerCase());
}

/**
 * Compare two scalar values for the SqliteStore no-op check. Numbers compare
 * numerically (a JS 2 and its stored TEXT form "2.0" are equal — SQLite stores
 * numbers as their REAL text representation in TEXT-affinity columns); empty
 * string is NOT treated as 0; everything else compares as strings.
 */
function scalarEqual(a: unknown, b: unknown): boolean {
	const na = Number(a);
	const nb = Number(b);
	if (
		a !== "" && b !== "" &&
		!Number.isNaN(na) && !Number.isNaN(nb) &&
		Number.isFinite(na) && Number.isFinite(nb)
	) {
		return na === nb;
	}
	return String(a) === String(b);
}
