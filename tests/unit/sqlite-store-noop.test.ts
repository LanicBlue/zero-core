// SqliteStore no-op update 检测 — 配合 data-change-hub 避免无变化也刷新 UI
//
// # 文件说明书
//
// ## 核心功能
// 验证 update 在 patch 字段全部等于现值时:
//   - 不写库(updatedAt 不变)
//   - 不发 data-change 通知(hub 监听者收不到事件)
// 任一字段变化时正常写 + 通知。
//

import { describe, test, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { SqliteStore, type ColumnDef } from "../../src/server/sqlite-store.js";
import { onDataChange, _resetDataChangeHubForTest } from "../../src/server/data-change-hub.js";

interface Row { id: string; createdAt: string; updatedAt: string; name: string; count: number }

let tmpDir: string;
let sessionDB: SessionDB;
let store: SqliteStore<Row>;

const COLUMNS: ColumnDef[] = [
	{ key: "name" },
	{ key: "count" },
];

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "zero-sqlite-noop-"));
	sessionDB = new SessionDB(join(tmpDir, "sessions.db"));
	store = new SqliteStore<Row>(sessionDB.getDb(), "noop_test", COLUMNS);
	_resetDataChangeHubForTest();
});

describe("SqliteStore.update no-op detection", () => {
	test("identical patch → no write, no notification", async () => {
		const created = store.create({ name: "foo", count: 1 });
		const updatedAtBefore = created.updatedAt;
		// Ensure a real write would produce a DIFFERENT ms-precision timestamp
		// (so the updatedAt assertions reliably discriminate no-op vs write).
		await new Promise((r) => setTimeout(r, 5));

		let gotEvent = false;
		onDataChange(() => { gotEvent = true; });

		// Patch with the SAME values.
		const returned = store.update(created.id, { name: "foo", count: 1 });
		await new Promise((r) => setTimeout(r, 0));

		// Returned record is unchanged (updatedAt not bumped).
		expect(returned.updatedAt).toBe(updatedAtBefore);
		// No data-change event fired.
		expect(gotEvent).toBe(false);
		// Row on disk unchanged.
		expect(store.get(created.id)?.updatedAt).toBe(updatedAtBefore);
	});

	test("empty patch → no write, no notification", async () => {
		const created = store.create({ name: "foo", count: 1 });
		const updatedAtBefore = created.updatedAt;
		await new Promise((r) => setTimeout(r, 5));

		let gotEvent = false;
		onDataChange(() => { gotEvent = true; });

		store.update(created.id, {});
		await new Promise((r) => setTimeout(r, 0));

		expect(gotEvent).toBe(false);
		expect(store.get(created.id)?.updatedAt).toBe(updatedAtBefore);
	});

	test("changed field → writes (updatedAt bumps)", async () => {
		const created = store.create({ name: "foo", count: 1 });

		store.update(created.id, { count: 2 });
		await new Promise((r) => setTimeout(r, 0));

		// Scalars are stored as TEXT and a JS number round-trips as its REAL
		// text form (1 → "1.0", 2 → "2.0"). The value changing from "1.0" to
		// "2.0" proves the no-op path was NOT taken. (Don't assert updatedAt
		// here — create + update land in the same millisecond, so the ISO
		// timestamps can be identical even though the write happened.)
		expect(String(store.get(created.id)?.count)).toBe("2.0");
	});

	test("object/array field compared structurally (deep-equal = no-op)", async () => {
		const store2 = new SqliteStore<any>(sessionDB.getDb(), "noop_obj_test", [
			{ key: "name" },
			{ key: "tags", json: true },
		]);
		const created = store2.create({ name: "x", tags: ["a", "b"] });
		const updatedAtBefore = created.updatedAt;

		let gotEvent = false;
		onDataChange(() => { gotEvent = true; });

		// Same array content, new instance → structural equal → no-op.
		store2.update(created.id, { tags: ["a", "b"] });
		await new Promise((r) => setTimeout(r, 0));

		expect(gotEvent).toBe(false);
		expect(store2.get(created.id)?.updatedAt).toBe(updatedAtBefore);
		// Different content → not a no-op. Sleep first so the bumped updatedAt
		// (ms-precision ISO) is guaranteed to differ from the create timestamp —
		// without this, create + update can land in the same millisecond and the
		// `not.toBe` assertion flakes.
		await new Promise((r) => setTimeout(r, 5));
		store2.update(created.id, { tags: ["a", "b", "c"] });
		expect(store2.get(created.id)?.updatedAt).not.toBe(updatedAtBefore);
	});
});
