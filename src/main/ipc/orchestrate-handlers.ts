// Orchestrate 计划确认门 IPC 处理器 (v0.8 M3)
//
// # 文件说明书
//
// ## 核心功能
// 注册 `orchestrate:*` 系列 IPC 通道,把看板的 plan-gate pending 入口与后端
// OrchestratePlanStore + ConfirmRegistry 接通(决策 11)。
//   - orchestrate:pending — 看板列出 pending 计划(可按 projectId 过滤);
//   - orchestrate:plan    — 单个计划详情;
//   - orchestrate:confirm — 确认 pending 计划 → resolve 挂起的 Orchestrate 工具;
//   - orchestrate:reject  — 驳回 pending 计划 → 工具返回 false: <reason>。
//
// ## 输入
// - IpcContext.orchestratePlanStore + 内嵌 ConfirmRegistry(由 planStore 持有)。
// - 通道参数:planId、reason、filter。
//
// ## 输出
// - pending 列表 / plan 记录 / 确认 / 驳回的统一结果对象。
// - 失败路径返回 { error } 或 { success: false, reason }。
//
// ## 定位
// src/main/ipc 下领域 IPC 处理器;由 ipc 注册入口调用
// registerOrchestrateHandlers(ctx)。镜像 server/orchestrate-router.ts 的 REST
// 表面,供前端 IPC(看板 KanbanPage)使用。
//
// ## 依赖
// - ./typed-ipc.js、./types.js
// - ../../shared/types.js
// - 间接:ctx.orchestratePlanStore、ConfirmRegistry(orchestrate-store 单例)
//
// ## 维护规则
// - confirm/reject 不抛错,plan 不存在或不在 pending 状态返回 success:false。
// - 驳回需带 reason 存进 plan.rejectionReason。
// - 与 server/orchestrate-router.ts 行为保持一致(同一份 planStore 同一份 registry)。
//

import { typedHandle } from "./typed-ipc.js";
import { ConfirmRegistry } from "../../server/orchestrate-store.js";

export function registerOrchestrateHandlers(): void {
	// List pending plans, optional filter: projectId.
	typedHandle("orchestrate:pending", "sessionDb", (ctx, filter?) => {
		const store = ctx.orchestratePlanStore;
		if (!store) return [];
		return store.list({ state: "pending", ...(filter?.projectId ? { projectId: filter.projectId } : {}) });
	});

	// Get a single plan by id.
	typedHandle("orchestrate:plan", "sessionDb", (ctx, planId) => {
		const store = ctx.orchestratePlanStore;
		if (!store) return { error: "orchestrate store not available" };
		const plan = store.get(planId);
		if (!plan) return { error: "plan not found" };
		return plan;
	});

	// Confirm a pending plan → resolves the awaiting Orchestrate tool promise.
	typedHandle("orchestrate:confirm", "sessionDb", (ctx, planId) => {
		const store = ctx.orchestratePlanStore;
		if (!store) return { success: false, planId, reason: "orchestrate store not available" };
		const plan = store.get(planId);
		if (!plan) return { success: false, planId, reason: "plan not found" };
		if (plan.state !== "pending") {
			return { success: false, planId, reason: `plan not pending (state=${plan.state})` };
		}
		store.setState(planId, "confirmed");
		const ok = ConfirmRegistry.getInstance().confirm(planId);
		if (!ok) {
			// No active awaiter — engine died / server restarted. cron fallback
			// or the lead loop is gone; cron will re-surface.
			return { success: false, planId, reason: "no active awaiter (lead loop gone? cron will retry)" };
		}
		return { success: true, planId };
	});

	// Reject a pending plan with a reason → tool returns false: <reason>.
	typedHandle("orchestrate:reject", "sessionDb", (ctx, planId, reason) => {
		const store = ctx.orchestratePlanStore;
		const why = (reason && reason.trim()) || "(no reason given)";
		if (!store) return { success: false, planId, reason: "orchestrate store not available" };
		const plan = store.get(planId);
		if (!plan) return { success: false, planId, reason: "plan not found" };
		if (plan.state !== "pending") {
			return { success: false, planId, reason: `plan not pending (state=${plan.state})` };
		}
		store.setState(planId, "rejected", { rejectionReason: why });
		const ok = ConfirmRegistry.getInstance().reject(planId);
		if (!ok) {
			return { success: false, planId, reason: "no active awaiter (lead loop gone?)" };
		}
		return { success: true, planId, reason: why };
	});
}
