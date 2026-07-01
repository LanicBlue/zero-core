// PreLLMCall 钩子：按 thinkingLevel 注入 Anthropic thinking budget 等 provider 选项。
//
// # 文件说明书
//
// ## 核心功能
// registerProviderOptionsHooks 在 PreLLMCall 注册处理器：若 config.thinkingLevel 非 none，
// 按低/中/高映射到 4096/16384/32768 budgetTokens，返回 { providerOptions: { anthropic: { thinking } } }。
//
// ## 输入
// - Hook 上下文：config.thinkingLevel（none | low | medium | high）
//
// ## 输出
// - 返回 providerOptions 供 LLM 调用合并；thinkingLevel=none 时不返回
//
// ## 定位
// runtime/hooks 层，集中管理 provider 专属开关；由 hooks/index.ts 统一注册。
//
// ## 依赖
// - core/hook-registry、core/logger
// - runtime/types（SessionConfig.thinkingLevel）
//
// ## 维护规则
// - 新增 provider 专属选项（如 OpenAI reasoning_effort）应作为独立分支在此扩展，不要散落到 agent-loop。
// - budgetTokens 数值调整需同步 docs 中关于 thinking 等级的说明。

import { HookRegistry } from "../../core/hook-registry.js";
import type { SessionConfig } from "../types.js";
import { log } from "../../core/logger.js";

export function registerProviderOptionsHooks(registry: HookRegistry = HookRegistry.getInstance()): void {
	registry.register("PreLLMCall", async (ctx) => {
		const config = ctx.config as SessionConfig;
		if (!config.thinkingLevel || config.thinkingLevel === "none") return;

		const budgetTokens = ({ low: 4096, medium: 16384, high: 32768 } as Record<string, number>)[config.thinkingLevel] ?? 16384;
		return { providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens } } } };
	});

	log.debug("hooks", "Provider options hook registered");
}
