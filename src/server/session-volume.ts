// steps-overhaul sub-9: content-volume window logic for the chat UI.
//
// # 文件说明书
//
// ## 核心功能
// 纯函数:给定 session 的总 step 数 / 总 turn 数 / token usage,计算 UI 应展示
// 的"内容量确认"窗口 —— 最近 max(100 step, 5 turn) 的内容(取多的:100 step
// 和 5 turn 谁覆盖更多 step 取谁)。
//
// ## 为什么是纯函数 / 独立模块
// - max(100 step, 5 turn) 是 design.md 决策 #5 + acceptance-9 的硬不变量,
//   单独抽出便于 vitest 直接覆盖边界(>100 step / >5 turn / 两者都不满 / 0)。
// - 无 DB / 无副作用,agent-service 调用,测试无 mock。
//
// ## 关键不变量(acceptance-9)
// - 取多的:比较"最后 100 step 覆盖多少 turn" vs "最后 5 turn 覆盖多少 step",
//   取 coveredSteps 更大的那个 basis。两者相等时取 step basis(更细粒度,边界稳定)。
//
// ## 定位
// src/server/ 服务层纯逻辑,被 agent-service.getSessionVolume 调用。

import type { SessionVolumeInfo } from "../shared/types.js";

/** UI 展示的 step 窗口大小(design 决策 #5:最近 100 step)。 */
export const STEP_WINDOW = 100;
/** UI 展示的 turn 窗口大小(design 决策 #5:最近 5 turn)。 */
export const TURN_WINDOW = 5;

/**
 * 计算 UI 展示窗口(max(100 step, 5 turn),取多的)。
 *
 * "取多的"语义:比较两个候选窗口各自覆盖的 step 数,取覆盖更多 step 的那个。
 * 一个 session 里 step 是细粒度真相源,turn 是粗粒度(一个 turn 含若干 step),
 * 所以"覆盖更多 step" ≈ "覆盖更多内容"。
 *
 * 两个候选:
 *  - step-basis 窗口 = 最后 min(100, totalStepCount) 个 step。它跨越的 turn 数
 *    无法从 (totalStepCount, totalTurnCount) 精确得知(turn 内 step 分布不均),
 *    但其 coveredSteps = min(100, totalStepCount) 是确定的。
 *  - turn-basis 窗口 = 最后 min(5, totalTurnCount) 个 turn。它覆盖的 step 数
 *    上界 = totalStepCount(若全部 turn 都落在最后 5 个 turn_group 内)但要保守
 *    估计:假设 step 在 turn 间均匀分布,最后 k 个 turn 约覆盖
 *    ceil(totalStepCount * k / totalTurnCount) 个 step。
 *
 * 取 coveredSteps(保守估计)更大的 basis;相等时取 step basis(边界由 step 数
 * 决定,不受 turn 内 step 分布抖动影响,更稳定)。
 *
 * 边界:
 *  - totalStepCount = 0 → 空 session,basis="steps",covered 全 0。
 *  - totalStepCount ≤ 100 → step 窗口已覆盖全部,直接 step basis。
 *  - totalTurnCount = 0(只有孤儿 step,turn_group=-1)→ 只能 step basis。
 */
export function computeDisplayWindow(
	totalStepCount: number,
	totalTurnCount: number,
	tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
): SessionVolumeInfo {
	const safeSteps = Math.max(0, Math.floor(totalStepCount));
	const safeTurns = Math.max(0, Math.floor(totalTurnCount));

	// step-basis 窗口覆盖的 step 数(确定值)。
	const stepBasisCoveredSteps = Math.min(STEP_WINDOW, safeSteps);

	// turn-basis 窗口覆盖的 turn 数(确定值)。
	const turnWindowTurns = Math.min(TURN_WINDOW, safeTurns);

	// turn-basis 窗口覆盖的 step 数(保守估计:均匀分布)。
	// ceil(steps * turnsInWindow / totalTurns);totalTurns=0 时无定义,记 0。
	const turnBasisCoveredSteps = safeTurns > 0 && turnWindowTurns > 0
		? Math.ceil((safeSteps * turnWindowTurns) / safeTurns)
		: 0;

	let basis: "steps" | "turns";
	let coveredSteps: number;
	let coveredTurns: number;
	if (turnBasisCoveredSteps > stepBasisCoveredSteps) {
		// turn 窗口覆盖更多 step(典型:session 已有很多 turn,5 turn 跨越 >100 step)。
		basis = "turns";
		coveredSteps = turnBasisCoveredSteps;
		coveredTurns = turnWindowTurns;
	} else {
		// step 窗口胜出或并列 —— 取 step basis(边界稳定,不受 turn 内 step 分布抖动)。
		basis = "steps";
		coveredSteps = stepBasisCoveredSteps;
		// step 窗口跨越的 turn 数:无法精确,但若全部 step 都落在最后 5 turn 内
		// (turnWindowTurns < totalTurns 不成立即总 turn ≤5),则 covered = 全部 turn;
		// 否则给一个上界估计(同均匀分布假设),仅供 UI 展示,不影响 basis 判定。
		coveredTurns = safeTurns <= TURN_WINDOW
			? safeTurns
			: Math.min(safeTurns, Math.ceil((STEP_WINDOW * safeTurns) / Math.max(1, safeSteps)));
	}

	return {
		totalStepCount: safeSteps,
		totalTurnCount: safeTurns,
		tokenUsage,
		displayWindow: { basis, coveredSteps, coveredTurns },
	};
}
