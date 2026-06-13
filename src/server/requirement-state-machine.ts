// 需求状态机
//
// # 文件说明书
//
// ## 核心功能
// 纯函数模块，定义需求状态的合法流转规则。
//
// ## 输入
// - 当前状态、目标状态、触发者角色
//
// ## 输出
// - 校验结果、可流转状态列表
//
// ## 定位
// 服务层状态机，被 requirement-store 使用。
//
// ## 依赖
// - ../shared/types - RequirementStatus 类型
//
// ## 维护规则
// - 新增状态流转时需更新 VALID_TRANSITIONS
//
import type { RequirementStatus } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StateMachineResult {
	valid: boolean;
	error?: string;
	validTargets?: RequirementStatus[];
}

// ---------------------------------------------------------------------------
// Valid transitions — (from, to, triggeredBy)
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Array<{
	from: RequirementStatus | undefined;
	to: RequirementStatus;
	triggeredBy: string;
}> = [
	// Initial creation
	{ from: undefined, to: "found", triggeredBy: "analyst" },
	{ from: undefined, to: "found", triggeredBy: "user" },

	// found → discuss
	{ from: "found", to: "discuss", triggeredBy: "user" },
	{ from: "found", to: "discuss", triggeredBy: "analyst" },

	// discuss → ready / found
	{ from: "discuss", to: "ready", triggeredBy: "user" },
	{ from: "discuss", to: "found", triggeredBy: "user" },

	// ready → plan
	{ from: "ready", to: "plan", triggeredBy: "lead" },

	// plan → build / ready
	{ from: "plan", to: "build", triggeredBy: "lead" },
	{ from: "plan", to: "ready", triggeredBy: "lead" },

	// build → verify / build (continue)
	{ from: "build", to: "verify", triggeredBy: "system" },
	{ from: "build", to: "build", triggeredBy: "lead" },

	// verify → closed / build
	{ from: "verify", to: "closed", triggeredBy: "analyst" },
	{ from: "verify", to: "closed", triggeredBy: "user" },
	{ from: "verify", to: "build", triggeredBy: "lead" },

	// closed → found (re-analyze)
	{ from: "closed", to: "found", triggeredBy: "user" },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a status transition is valid.
 * Special rule: any status → cancelled by user is always allowed.
 */
export function isValidTransition(
	from: RequirementStatus | undefined,
	to: RequirementStatus,
	triggeredBy: string,
): StateMachineResult {
	// Special rule: any status → cancelled by user
	if (to === "cancelled" && triggeredBy === "user") {
		return { valid: true };
	}

	const match = VALID_TRANSITIONS.find(
		(t) => t.from === from && t.to === to && t.triggeredBy === triggeredBy,
	);

	if (match) {
		return { valid: true };
	}

	const validTargets = getNextStatuses(from, triggeredBy);
	return {
		valid: false,
		error: `Invalid transition: ${from ?? "(new)"} -> ${to} (triggeredBy: ${triggeredBy})`,
		validTargets,
	};
}

/**
 * Get all valid next statuses from the current state for a given trigger.
 */
export function getNextStatuses(
	current: RequirementStatus | undefined,
	triggeredBy: string,
): RequirementStatus[] {
	const results: RequirementStatus[] = [];

	// Check cancelled (always valid for user)
	if (triggeredBy === "user" && current !== "cancelled" && current !== undefined) {
		results.push("cancelled");
	}

	for (const t of VALID_TRANSITIONS) {
		if (t.from === current && t.triggeredBy === triggeredBy && !results.includes(t.to)) {
			results.push(t.to);
		}
	}

	return results;
}
