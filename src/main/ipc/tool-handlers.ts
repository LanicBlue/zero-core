// 工具 IPC 处理器
//
// # 文件说明书
//
// ## 核心功能
// 工具相关的 IPC 处理器，处理工具列表、配置、测试等操作。
//
// ## 输入
// - IPC 通道调用
// - IpcContext - 上下文
//
// ## 输出
// - 工具列表
// - 工具配置
// - 测试结果
//
// ## 定位
// IPC 处理器，被 core.ts 注册。
//
// ## 依赖
// - ./typed-ipc - 类型化 IPC
// - ../../runtime/tools - 工具模块
//
// ## 维护规则
// - 新增工具操作时需同步更新
// - 保持与前端 API 一致
//
import { typedHandle } from "./typed-ipc.js";
import type { IpcContext } from "./types.js";
import type { ToolExecutionContext } from "../../runtime/types.js";
import { ALL_TOOLS } from "../../runtime/tools/index.js";
import { getToolExecute, getToolInputFields } from "../../runtime/tools/tool-factory.js";

export function registerToolHandlers(ctx: IpcContext): void {
	typedHandle("tools:list", "toolRegistry",
		(_ctx) => (_ctx.toolRegistry as any).getAll().map((d: any) => ({
			name: d.name,
			description: d.description,
			prompt: d.prompt,
			group: d.category,
			source: d.source,
			mcpServerName: d.mcpServerName,
			configSchema: d.configSchema,
			inputFields: getToolInputFields(ALL_TOOLS[d.name]),
			meta: d.meta,
		})),
	);

	typedHandle("tool-config:get", "toolRegistry",
		(_ctx) => (_ctx.toolRegistry as any).getToolConfig(),
	);

	typedHandle("tool-config:save", "toolRegistry",
		(_ctx, config) => { (_ctx.toolRegistry as any).saveToolConfig(config); },
	);

	typedHandle("tool:execute", ["toolRegistry", "workspaceConfig"],
		async (_ctx, { toolName, input }: { toolName: string; input: Record<string, any> }) => {
			const toolDef = ALL_TOOLS[toolName];
			if (!toolDef) return { ok: false as const, error: `Tool not found: ${toolName}`, elapsedMs: 0 };

			const execute = getToolExecute(toolDef);
			if (!execute) return { ok: false as const, error: `Tool not testable: ${toolName}`, elapsedMs: 0 };

			const config = (_ctx.toolRegistry as any).getToolConfig();
			const toolCtx: ToolExecutionContext = {
				workingDir: _ctx.workspaceConfig.workspaceDir,
				agentId: "__test__",
				emit: () => {},
				db: _ctx.sessionDb,
				readScope: _ctx.workspaceConfig.readScope ?? "filesystem",
				toolConfig: config,
			};

			const t0 = Date.now();
			try {
				const result = await execute(input, toolCtx);
				return { ok: true as const, result, elapsedMs: Date.now() - t0 };
			} catch (err: any) {
				return { ok: false as const, error: err.message, elapsedMs: Date.now() - t0 };
			}
		},
	);
}
