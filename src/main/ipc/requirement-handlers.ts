// 需求 IPC 处理器
//
// # 文件说明书
//
// ## 核心功能
// Requirement 相关的 IPC 处理器，处理需求 CRUD + 状态流转 + 消息操作。
//
// ## 输入
// - IPC 通道调用
// - IpcContext - 上下文
//
// ## 输出
// - Requirement 数据
// - 状态流转结果
// - 消息数据
//
// ## 定位
// IPC 处理器，被 ipc.ts 注册。
//
// ## 依赖
// - ./typed-ipc - 类型化 IPC
// - ../../shared/types - 共享类型
//
import { registerCrud, typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import type {
	RequirementRecord, CreateRequirementInput, UpdateRequirementInput,
	RequirementStatusHistory, RequirementMessage, TaskStepRecord,
} from "../../shared/types.js";

export function registerRequirementHandlers(ctx: IpcContext): void {
	// CRUD channels
	registerCrud<RequirementRecord, CreateRequirementInput, UpdateRequirementInput>({
		channel: "requirements",
		store: () => ctx.requirementStore as any,
		module: "sessionDb",
	});

	// Status transition
	typedHandle("requirements:transition", "sessionDb", (ctx, id, toStatus, triggeredBy, comment?) => {
		try {
			return ctx.requirementStore.transitionStatus(id, toStatus as any, triggeredBy, comment);
		} catch (e) {
			return { error: (e as Error).message };
		}
	});

	// Status history
	typedHandle("requirements:history", "sessionDb", (ctx, id) => {
		return ctx.requirementStore.getStatusHistory(id);
	});

	// Messages
	typedHandle("requirements:messages", "sessionDb", (ctx, id) => {
		return ctx.requirementStore.getMessages(id);
	});

	// Add message
	typedHandle("requirements:addMessage", "sessionDb", (ctx, id, sender, content, messageType?) => {
		return ctx.requirementStore.addMessage(id, sender as any, content, messageType as any);
	});

	// Steps
	typedHandle("requirements:steps", "sessionDb", (ctx, id) => {
		return ctx.taskStepStore.listByRequirement(id);
	});
}
