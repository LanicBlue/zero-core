// Cron IPC 处理器 (v0.8 M1)
//
// # 文件说明书
//
// ## 核心功能
// 注册 `crons:*` 系列 IPC 通道，落地到 ctx.cronStore：
//   - crons:list / crons:get / crons:create / crons:update / crons:delete
//   - crons:trigger —— 立即手动触发一次（调试用）
//
// 创建/更新/删除后调 ctx.cronManager.refreshCron(id) 同步调度定时器。
// 校验 agent + project 引用存在，workingScope 字段齐全。
//
// ## 输入
// - IpcContext：cronStore、可选 cronManager、agentStore、projectStore
//
// ## 输出
// - CronRecord / CRUD 结果；失败返回 { error }
//
// ## 定位
// src/main/ipc 下的领域 IPC 处理器；由 ipc 注册入口在初始化时调用
// registerCronHandlers(ctx)。
//
// ## 依赖
// - ./typed-ipc.js：typedHandle
// - ./types.js：IpcContext
// - ../../shared/types.js：CronRecord
//
// ## 维护规则
// - IPC 模式下不依赖 ManagementService（它只在 server 模式装配），直接走 store
// - 字段变更需同步 cron-store COLUMNS + db-migration CRON_COLUMNS
//

import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import type { CronRecord, CreateCronInput, UpdateCronInput } from "../../shared/types.js";

function err(e: unknown): { error: string } {
	return { error: e instanceof Error ? e.message : String(e) };
}

function validateScope(input: { workingScope?: CronRecord["workingScope"] }, ctx: IpcContext): string | null {
	const scope = input.workingScope;
	if (!scope || !scope.workspaceDir || !scope.wikiRootNodeId) {
		return "workingScope requires workspaceDir and wikiRootNodeId";
	}
	if (scope.projectId && !ctx.projectStore.get(scope.projectId)) {
		return `Project not found: ${scope.projectId}`;
	}
	return null;
}

export function registerCronHandlers(ctx: IpcContext): void {
	typedHandle("crons:list", "sessionDb", (_ctx, filter) => {
		const all = ctx.cronStore!.list() as CronRecord[];
		if (filter?.agentId) return all.filter((c) => c.agentId === filter.agentId);
		return all;
	});

	typedHandle("crons:get", "sessionDb", (_ctx, id) => {
		return ctx.cronStore!.get(id) as CronRecord | undefined;
	});

	typedHandle("crons:create", "sessionDb", (_ctx, input: CreateCronInput) => {
		try {
			if (!ctx.agentStore.get(input.agentId)) return err(`Agent not found: ${input.agentId}`);
			const scopeErr = validateScope(input, ctx);
			if (scopeErr) return err(scopeErr);
			const cron = ctx.cronStore!.create(input) as CronRecord;
			ctx.cronManager?.refreshCron(cron.id);
			return cron;
		} catch (e) {
			return err(e);
		}
	});

	typedHandle("crons:update", "sessionDb", (_ctx, id: string, input: UpdateCronInput) => {
		try {
			const existing = ctx.cronStore!.get(id) as CronRecord | undefined;
			if (!existing) return err(`Cron not found: ${id}`);
			if (input.workingScope) {
				const scopeErr = validateScope({ workingScope: input.workingScope }, ctx);
				if (scopeErr) return err(scopeErr);
			}
			const cron = ctx.cronStore!.update(id, input) as CronRecord;
			ctx.cronManager?.refreshCron(cron.id);
			return cron;
		} catch (e) {
			return err(e);
		}
	});

	typedHandle("crons:delete", "sessionDb", (_ctx, id: string) => {
		try {
			ctx.cronStore!.delete(id);
			ctx.cronManager?.refreshCron(id); // unschedules
			return { success: true as const };
		} catch (e) {
			return err(e) as any;
		}
	});

	typedHandle("crons:trigger", "sessionDb", async (_ctx, id: string) => {
		try {
			if (!ctx.cronManager) return err("Cron manager not available");
			await ctx.cronManager.triggerCron(id);
			return { success: true as const };
		} catch (e) {
			return err(e) as any;
		}
	});
}
