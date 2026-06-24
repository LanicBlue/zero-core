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

		emitDataChange("agents");
		emitDataChange("projects");
		emitDataChange("project_wiki");
		// High-frequency tables must NOT broadcast.
		emitDataChange("messages");
		emitDataChange("tool_usage");
		emitDataChange("turns");

		// Flush is async (setTimeout 0).
		await new Promise((r) => setTimeout(r, 0));

		const collections = cb.mock.calls.map((c) => c[0].collection).sort();
		expect(collections).toEqual(["agents", "project_wiki", "projects"]);
	});

	test("coalesce: many writes to one collection in a tick → one flush", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		// Simulate a bulk write (e.g. archivist scanning 50 wiki nodes).
		for (let i = 0; i < 50; i++) emitDataChange("project_wiki");

		await new Promise((r) => setTimeout(r, 0));

		// All 50 collapse into a single flush for "project_wiki".
		expect(cb).toHaveBeenCalledTimes(1);
		expect(cb.mock.calls[0][0].collection).toBe("project_wiki");
	});

	test("coalesce: distinct collections in one tick each flush once", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		emitDataChange("agents");
		emitDataChange("crons");
		emitDataChange("agents");
		emitDataChange("crons");
		emitDataChange("requirements");

		await new Promise((r) => setTimeout(r, 0));

		const collections = cb.mock.calls.map((c) => c[0].collection).sort();
		expect(collections).toEqual(["agents", "crons", "requirements"]);
		expect(cb).toHaveBeenCalledTimes(3);
	});

	test("separate ticks flush separately (no cross-tick coalescing)", async () => {
		const cb = vi.fn();
		onDataChange(cb);

		emitDataChange("agents");
		await new Promise((r) => setTimeout(r, 0));
		emitDataChange("agents");
		await new Promise((r) => setTimeout(r, 0));

		expect(cb).toHaveBeenCalledTimes(2);
	});

	test("onDataChange returns an unsubscribe that stops delivery", async () => {
		const cb = vi.fn();
		const unsub = onDataChange(cb);

		unsub();
		emitDataChange("agents");
		await new Promise((r) => setTimeout(r, 0));

		expect(cb).not.toHaveBeenCalled();
	});
});
