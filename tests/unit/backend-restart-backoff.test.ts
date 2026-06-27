// 后端子进程自愈重启的退避纯函数单测。
// 只测 computeBackoff —— exit handler 的真实 spawn/fork 由 E2E 覆盖（真实进程，不 mock）。

import { describe, expect, test } from "vitest";
import { computeBackoff } from "../../src/main/backend-spawn.js";

describe("backend restart backoff (computeBackoff)", () => {
	test("count=1 → 1000ms（首次重启，最短延迟）", () => {
		expect(computeBackoff(1)).toBe(1000);
	});

	test("count=2 → 2000ms（指数增长）", () => {
		expect(computeBackoff(2)).toBe(2000);
	});

	test("count=5 → 16000ms（仍在 RESTART_MAX 内，继续重试）", () => {
		expect(computeBackoff(5)).toBe(16000);
	});

	test("count=6 → null（超过 RESTART_MAX=5，停止自愈）", () => {
		expect(computeBackoff(6)).toBeNull();
	});

	test("count=7 → null（持续停止）", () => {
		expect(computeBackoff(7)).toBeNull();
	});

	test("窗口内所有合法 count 都受 30s 上限保护", () => {
		// RESTART_MAX=5 时最大 16000 < 30000，cap 暂不触发；
		// 但保证未来调高 RESTART_MAX 时延迟不会失控。
		for (let n = 1; n <= 5; n++) {
			expect(computeBackoff(n)).toBeLessThanOrEqual(30_000);
		}
	});
});
