// Requirement（多 agent 工作流中的需求实体）IPC 处理器。
//
// # 文件说明书
//
// ## 核心功能
// 注册 `requirements:*`、`lead:*` 系列 IPC 通道，覆盖需求全生命周期：
//   - CRUD（落地到 ctx.requirementStore）；
//   - 状态流转 transition / 历史 getStatusHistory / 消息列表与追加 / 步骤查询；
//   - Lead 接管：lead:pickup 调 leadService.pickupRequirement、lead:progress 取进度；
//   - M5 完结闭环：requirements:verify（analystService.verifyRequirement）、
//     requirements:archive（archivist 归档）、requirements:report（从 status_change
//     消息里抽取 markdown 报告）。
//
// ## 输入
// - IpcContext：requirementStore、taskStepStore、leadService、analystService
// - 通道参数：requirementId、toStatus、triggeredBy、comment、sender、content 等
//
// ## 输出
// - RequirementRecord、状态历史、消息、步骤、进度、报告
// - 失败路径统一返回 `{error: message}` 而非抛出
//
// ## 定位
// src/main/ipc 下领域 IPC 处理器；由 ipc 注册入口调用
// registerRequirementHandlers(ctx)。串联 PM/Lead/Architect/Archivist 多个 service。
//
// ## 依赖
// - ./typed-ipc.js、./types.js
// - ../../shared/types.js：Requirement/StatusHistory/Message/TaskStep 等类型
// - 间接：ctx.requirementStore、ctx.taskStepStore、ctx.leadService、ctx.analystService
//
// ## 维护规则
// - 状态机新增状态需同步 transition 校验与文档
// - Lead / Analyst / Archivist service 接口签名变更必须同步本文件调用
// - 错误统一以 `{error}` 返回，不要让异常冒泡到 IPC 边界
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

	// Lead: pickup requirement
	typedHandle("lead:pickup", "sessionDb", async (ctx, requirementId) => {
		try {
			const sessionId = await ctx.leadService.pickupRequirement(requirementId);
			return { sessionId };
		} catch (e) {
			return { error: (e as Error).message };
		}
	});

	// Lead: get progress
	typedHandle("lead:progress", "sessionDb", (ctx, requirementId) => {
		try {
			return ctx.leadService.getProgress(requirementId);
		} catch (e) {
			return { error: (e as Error).message };
		}
	});

	// M5: Verify requirement
	typedHandle("requirements:verify", "sessionDb", async (ctx, id) => {
		try {
			return await ctx.analystService.verifyRequirement(id);
		} catch (e) {
			return { error: (e as Error).message };
		}
	});

	// M5: Archive requirement
	typedHandle("requirements:archive", "sessionDb", async (ctx, id) => {
		try {
			await ctx.analystService.archiveRequirement(id);
			return { success: true as const };
		} catch (e) {
			return { error: (e as Error).message };
		}
	});

	// M5: Get completion report
	typedHandle("requirements:report", "sessionDb", (ctx, id) => {
		const messages = ctx.requirementStore.getMessages(id);
		const report = messages.find((m: any) =>
			m.messageType === "status_change" && m.content.startsWith("##"),
		);
		return { report: report?.content || null };
	});
}
