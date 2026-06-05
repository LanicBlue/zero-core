// 会话生命周期状态机定义
//
// # 文件说明书
//
// ## 核心功能
// 定义会话生命周期的状态枚举和合法状态转换规则
//
// ## 输入
// 无（纯类型和常量定义）
//
// ## 输出
// SessionLifecycleState 类型、VALID_TRANSITIONS 映射表
//
// ## 定位
// src/server/ — 服务层，为 session-manager 提供状态机基础
//
// ## 依赖
// 无外部依赖
//
// ## 维护规则
// 新增状态需同步更新 VALID_TRANSITIONS 映射
//
export type SessionLifecycleState =
	| "created"
	| "idle"
	| "queued"
	| "streaming"
	| "executing_tools"
	| "error"
	| "disposed";

export const VALID_TRANSITIONS: Record<SessionLifecycleState, SessionLifecycleState[]> = {
	created:         ["idle", "disposed"],
	idle:            ["queued", "streaming", "disposed"],
	queued:          ["streaming", "error", "disposed"],
	streaming:       ["executing_tools", "idle", "error", "disposed"],
	executing_tools: ["streaming", "idle", "error", "disposed"],
	error:           ["idle", "disposed"],
	disposed:        [],
};

export function isValidTransition(from: SessionLifecycleState, to: SessionLifecycleState): boolean {
	return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
