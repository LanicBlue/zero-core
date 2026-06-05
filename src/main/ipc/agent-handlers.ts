// Agent IPC 处理器
//
// # 文件说明书
//
// ## 核心功能
// Agent 相关的 IPC 处理器，处理 Agent CRUD 操作。
//
// ## 输入
// - IPC 通道调用
// - IpcContext - 上下文
//
// ## 输出
// - Agent 数据
// - CRUD 操作结果
//
// ## 定位
// IPC 处理器，被 core.ts 注册。
//
// ## 依赖
// - ./typed-ipc - 类型化 IPC
// - ../../shared/types - 共享类型
//
// ## 维护规则
// - 新增 Agent 字段时需同步更新
// - 保持与前端 API 一致
//
import { registerCrud } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import { refreshAgentTools } from "./core.js";
import type { AgentRecord, CreateAgentInput, UpdateAgentInput } from "../../shared/types.js";

export function registerAgentHandlers(ctx: IpcContext): void {
	registerCrud<AgentRecord, CreateAgentInput, UpdateAgentInput>({
		channel: "agents",
		store: () => ctx.agentStore as any,
		module: "agentStore",
		afterMutation: refreshAgentTools,
	});
}
