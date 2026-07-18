// data-change-hub 单元测试 — UI 同步统一机制
//
// # 文件说明书
//
// ## 核心功能
// 验证 hub 的两个关键性质:
//   - **白名单**:非 UI collection(messages/tool_usage/turns 等)的写不广播,
//     避免高频表刷屏。
//   - **coalesce**:同一 tick 内对同一(或多个)collection 的多次 emit 合并成
//     一次 flush,批量写(archivist 扫描 / migrateFromJson)只触发一次刷新。
//
// ## 输入
// 直接调 emitDataChange / onDataChange(纯函数,无 DB)。
//
// ## 输出
// Vitest 用例。
//

import { describe, test, expect, beforeEach, vi } from "vitest";
import {
	emitDataChange,
	onDataChange,
	_resetDataChangeHubForTest,
} from "../../src/server/data-change-hub.js";

beforeEach(() => {
	_resetDataChangeHubForTest();
});

describe("data-change-hub", () => {
	test("whitelist: UI collections emit, non-UI tables are ignored", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		emitDataChange("agents", "a1", "create");
		emitDataChange("projects", "p1", "create");
		emitDataChange("crons", "c1", "create");
		// High-frequency tables must NOT broadcast.
		emitDataChange("messages", "m1", "create");
		emitDataChange("tool_usage", "t1", "create");
		emitDataChange("turns", "tu1", "create");
		// plan-08 §1: project_wiki was REMOVED from UI_COLLECTIONS — must NOT broadcast.
		emitDataChange("project_wiki", "w1", "create");

		// Flush is async (setTimeout 0).
		await new Promise((r) => setTimeout(r, 0));

		const collections = cb.mock.calls.map((c) => c[0].collection).sort();
		expect(collections).toEqual(["agents", "crons", "projects"]);
	});

	test("carries the pushed record so renderers patch without a GET", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		const rec = { id: "a1", name: "zero", createdAt: "t", updatedAt: "t" };
		emitDataChange("agents", "a1", "create", rec);
		await new Promise((r) => setTimeout(r, 0));

		expect(cb).toHaveBeenCalledTimes(1);
		const evt = cb.mock.calls[0][0];
		expect(evt.collection).toBe("agents");
		expect(evt.changes).toEqual([{ id: "a1", op: "create", record: rec }]);
	});

	test("delete carries no record", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		emitDataChange("agents", "a1", "delete");
		await new Promise((r) => setTimeout(r, 0));

		expect(cb.mock.calls[0][0].changes).toEqual([{ id: "a1", op: "delete" }]);
	});

	test("coalesce: many writes to one collection in a tick → one flush", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		// Simulate a bulk write (e.g. indexer scanning 50 requirements).
		for (let i = 0; i < 50; i++) emitDataChange("requirements", `r${i}`, "create", { id: `r${i}` });

		await new Promise((r) => setTimeout(r, 0));

		// All 50 collapse into a single flush for "requirements", carrying all ids.
		expect(cb).toHaveBeenCalledTimes(1);
		const evt = cb.mock.calls[0][0];
		expect(evt.collection).toBe("requirements");
		expect(evt.changes.length).toBe(50);
	});

	test("coalesce dedupes by id, keeping the latest op+record (delete drops record)", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		emitDataChange("agents", "a1", "create", { id: "a1", v: 1 });
		emitDataChange("agents", "a1", "update", { id: "a1", v: 2 }); // overwrites
		emitDataChange("agents", "a1", "delete");                     // latest wins, no record

		await new Promise((r) => setTimeout(r, 0));

		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb.mock.calls[0][0].changes).toEqual([{ id: "a1", op: "delete" }]);
	});

	test("coalesce: distinct collections in one tick each flush once", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		emitDataChange("agents", "a1", "create");
		emitDataChange("crons", "c1", "create");
		emitDataChange("requirements", "r1", "create");

		await new Promise((r) => setTimeout(r, 0));

		const collections = cb.mock.calls.map((c) => c[0].collection).sort();
		expect(collections).toEqual(["agents", "crons", "requirements"]);
		expect(cb).toHaveBeenCalledTimes(3);
	});

	test("onDataChange returns an unsubscribe that stops delivery", async () => {
		const cb = vi.fn();
		const unsub = onDataChange(cb);

		unsub();
		emitDataChange("agents", "a1", "create");
		await new Promise((r) => setTimeout(r, 0));

		expect(cb).not.toHaveBeenCalled();
	});
});
