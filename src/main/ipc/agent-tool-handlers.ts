// Agent 工具 IPC handlers
//
// # 文件说明书
//
// ## 核心功能
// 处理 Agent 自定义工具的 CRUD 操作 IPC 请求
//
// ## 输入
// AgentToolEntry、CreateAgentToolInput、UpdateAgentToolInput
//
// ## 输出
// 工具列表、创建/更新/删除结果
//
// ## 定位
// src/main/ipc/ — 主进程 IPC 层，管理 Agent 工具配置
//
// ## 依赖
// typed-ipc.ts、core.ts、shared/types.ts
//
// ## 维护规则
// 工具配置字段变更需同步更新 shared/types.ts
//
import { registerCrud, typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import { refreshAgentTools } from "./core.js";
import type { AgentToolEntry, CreateAgentToolInput, UpdateAgentToolInput } from "../../shared/types.js";

export function registerAgentToolHandlers(ctx: IpcContext): void {
	registerCrud<AgentToolEntry, CreateAgentToolInput, UpdateAgentToolInput>({
		channel: "agent-tools",
		store: () => ctx.agentToolStore as any,
		module: "agentToolStore",
		afterMutation: refreshAgentTools,
	});

	typedHandle("agent-tools:get-by-agent", "agentToolStore",
		(_ctx, agentId: string) => _ctx.agentToolStore.getByAgentId(agentId),
	);
}
