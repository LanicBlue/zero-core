// 等待工具(通用 session 挂起)
//
// # 文件说明书(sub-5 重写)
//
// ## 核心功能
// 通用 session 挂起 —— 不绑 task。三个 wake 源任一触发即返回:
//   1. 到点(`until` 绝对 / `timeout` 相对)
//   2. 任意后台 task 完成(全局事件,非特定 task)
//   3. 用户输入打断(→ 起 turn+1)
//
// ## 输入
// - until:  ISO 绝对时间点(优先,天然 durable)
// - timeout: 相对秒数(1-3600);无 until 时用此
//
// ## 输出
// - 仅 wake 原因 + elapsed:`woke: timeout` / `woke: task finished` /
//   `woke: user input`。去摘要(completed task 详情走 TaskGet)。
//
// ## 定位
// Runtime 工具,被 Agent 调用。挂起期间 session 不算 running(见
// suspendUntilWake 的 busy 协调)。
//
// ## 依赖
// - zod - 数据验证
//
// ## 维护规则
// - 三个 wake 源的优先级(同时触发时取哪个)由 suspendUntilWake 决定,
//   Wait 工具本身只透传 input + 回填结果。
//
import { z } from "zod";
import { buildTool } from "./tool-factory.js";
import type { WakeReason, WaitWakeResult } from "../runtime/types.js";

export const waitTool = buildTool({
	name: "Wait",
	description: "Wait — suspend the session until an event wakes it.",
	prompt: "Wait — suspend THIS session until a wake event. Returns only the wake reason + elapsed time.\n\n" +
		"Three wake sources (any one wakes the wait):\n" +
		"- Time reached: `until` (absolute ISO point) or `timeout` (relative seconds) elapses.\n" +
		"- Any background task finishes: any delegated/background task reaching a terminal state.\n" +
		"- User input: the user sends a message while you're waiting (ends the current turn, starts a new one).\n\n" +
		"When to use Wait:\n" +
		"- After dispatching background tasks (TaskStart), to block until they complete or a deadline.\n" +
		"- To pause until a known future time.\n\n" +
		"Parameters (provide one):\n" +
		"- until: ISO 8601 absolute time point to wake at (e.g. \"2026-07-07T10:30:00Z\"). Durable across restarts.\n" +
		"- timeout: relative wait in seconds (1-3600). Used when `until` is omitted. Durable across restarts: on crash/restart the remaining time is computed from the persisted start timestamp and the wait is re-suspended for the remainder (already-elapsed → fills as timeout). Both `until` and `timeout` survive restarts.\n\n" +
		"Returns: `woke: timeout` / `woke: task finished` / `woke: user input` plus elapsed seconds. For task results use TaskGet — Wait no longer returns a task summary.",
	meta: { category: "runtime", isReadOnly: true, isConcurrencySafe: true, isDestructive: false },
	inputSchema: z.object({
		until: z.string().describe("ISO 8601 absolute time point to wake at. Durable across restarts."),
		timeout: z.number().min(1).max(3600).optional().describe("Relative wait in seconds (1-3600). Used when `until` is omitted."),
	}),
	execute: async (input, ctx) => {
		// Normalize: prefer absolute `until`; fall back to relative `timeout`.
		// If neither is provided, treat as an immediate wake (no-op wait).
		let untilIso: string | undefined = input.until;
		let timeoutSec: number | undefined = input.timeout;

		if (!untilIso && timeoutSec === undefined) {
			return "woke: timeout (no until/timeout provided; immediate wake) elapsed 0s";
		}
		// Validate until parses; if invalid, fall back to timeout (or 1s floor).
		if (untilIso) {
			const t = Date.parse(untilIso);
			if (Number.isNaN(t)) {
				untilIso = undefined;
			}
		}

		if (ctx.suspendUntilWake) {
			// sub-9 (durable relative-timeout): stamp the wall-clock start onto
			// the recorder's Wait tool block (sibling to `args`) so a crash
			// mid-wait can be resumed with remaining-timeout computation. Only
			// meaningful for a relative `timeout` (an absolute `until` is itself
			// durable); we stamp unconditionally so the persisted block carries
			// the metadata regardless of which time source was used.
			ctx.setWaitStartedAt?.(ctx.currentToolCallId ?? "", Date.now());
			// sub-5: announce suspend → release session "running" state, then
			// resume → reacquire. begin/endWait are best-effort no-ops when the
			// context doesn't wire them (test stubs).
			ctx.beginWait?.();
			let result: WaitWakeResult;
			try {
				result = await ctx.suspendUntilWake({ until: untilIso, timeoutSec });
			} catch (err) {
				ctx.endWait?.("timeout" as WakeReason);
				throw err;
			}
			ctx.endWait?.(result.reason);
			return `woke: ${result.reason} elapsed ${Math.max(0, Math.round(result.elapsedMs / 1000))}s`;
		}

		// Fallback (no suspendUntilWake wired — test stubs): simple sleep on
		// relative timeout; absolute until computed to a delay.
		const start = Date.now();
		let delayMs: number;
		if (untilIso) {
			delayMs = Math.max(0, Date.parse(untilIso) - start);
		} else {
			delayMs = Math.max(1, Math.min(timeoutSec ?? 1, 3600)) * 1000;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		return `woke: timeout elapsed ${Math.round((Date.now() - start) / 1000)}s`;
	},
});
