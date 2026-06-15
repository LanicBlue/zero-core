// PreLLMCall 钩子：自动从 memory wiki 召回相关节点并注入 context。
//
// # 文件说明书
//
// ## 核心功能
// registerMemoryHooks 在 PreLLMCall 注册处理器：取最近一条 user 消息文本，用 MemoryRecall 做
// FTS5 召回，把命中节点格式化为 memoryContext 返回，供 context-message 注入到 ## Recalled Memories。
// config.memory.enabled=false 或 autoRecall=false 时跳过；召回失败视为非致命。
//
// ## 输入
// - Hook 上下文：config.memory（enabled、autoRecall、recallLimit）、session、db
// - 最近一条 user 消息文本
//
// ## 输出
// - 返回 { memoryContext } 供 PreLLMCall 合并到当前上下文；无命中则不返回
//
// ## 定位
// runtime/hooks 层，桥接 memory-recall 与 agent-loop 的上下文构建；由 hooks/index.ts 统一注册。
//
// ## 依赖
// - core/hook-registry、core/logger
// - runtime/memory-recall、runtime/types、runtime/session
// - server/memory-node-store（通过 db.getMemoryNodeStore）
//
// ## 维护规则
// - 召回文本格式变化时同步更新 context-message 的 ## Recalled Memories 渲染约定。
// - 关闭开关（enabled / autoRecall）的语义若调整，需在 types.ts SessionConfig.memory 中同步注释。

import { HookRegistry } from "../../core/hook-registry.js";
import { MemoryRecall } from "../memory-recall.js";
import type { SessionConfig } from "../types.js";
import type { AgentSession } from "../session.js";
import type { MemoryNodeStore } from "../../server/memory-node-store.js";
import { log } from "../../core/logger.js";

export function registerMemoryHooks(): void {
	const registry = HookRegistry.getInstance();

	registry.register("PreLLMCall", async (ctx) => {
		const config = ctx.config as SessionConfig;
		if (!config.memory?.enabled || config.memory.autoRecall === false) return;
		if (!config.db) return;

		const session = ctx.session as AgentSession;
		const nodeStore = (config.db as any).getMemoryNodeStore?.() as MemoryNodeStore | undefined;
		if (!nodeStore) return;

		const userMsgs = session.getMessages().filter((m: any) => m.role === "user");
		const lastUser = userMsgs[userMsgs.length - 1];
		if (!lastUser) return;

		const text = typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
		try {
			const recall = new MemoryRecall(nodeStore);
			const result = await recall.recall(text, config.memory?.recallLimit);
			if (result) {
				return { memoryContext: recall.formatForContext(result) ?? undefined };
			}
		} catch {
			// recall failure is non-fatal
		}
	});

	log.debug("hooks", "Memory hooks registered");
}
