// PreLLMCall 钩子：把知识库 RAG 召回文本注入临时 context message。
//
// # 文件说明书
//
// ## 核心功能
// registerRagHooks 在 PreLLMCall 调用 config.getRagContext(agentId, "")，若返回非空则把
// ragContext 返回，供 context-message 渲染到 ## Knowledge Base。RAG 失败视为非致命。
//
// ## 输入
// - Hook 上下文：config.getRagContext（异步函数）、config.agentId
//
// ## 输出
// - 返回 { ragContext } 供 PreLLMCall 合并；无召回则不返回
//
// ## 定位
// runtime/hooks 层，桥接 RAG 召回实现（由 SessionConfig 注入）与 agent-loop 上下文构建；
// 由 hooks/index.ts 统一注册。
//
// ## 依赖
// - core/hook-registry、core/logger
// - runtime/types（SessionConfig.getRagContext 回调）
//
// ## 维护规则
// - getRagContext 签名变更时同步更新本调用与上游注入点。
// - RAG 文本格式约定与 context-message 的 ## Knowledge Base 段保持一致。

import { HookRegistry } from "../../core/hook-registry.js";
import type { SessionConfig } from "../types.js";
import { log } from "../../core/logger.js";

export function registerRagHooks(registry: HookRegistry = HookRegistry.getInstance()): void {

	registry.register("PreLLMCall", async (ctx) => {
		const config = ctx.config as SessionConfig;
		if (!config.getRagContext) return;

		try {
			const ragContext = await config.getRagContext(config.agentId, "");
			if (ragContext) {
				return { ragContext };
			}
		} catch {
			// RAG failure is non-fatal
		}
	});

	log.debug("hooks", "RAG hooks registered");
}
