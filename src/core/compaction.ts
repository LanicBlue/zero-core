// 上下文压缩决策模块
//
// # 文件说明书
//
// ## 核心功能
// 根据配置策略判断是否需要对对话上下文进行压缩（compaction）
//
// ## 输入
// ZeroCoreConfig、当前 token 数量、上下文窗口大小
//
// ## 输出
// 布尔值表示是否需要压缩
//
// ## 定位
// src/core/ — 核心层，为 agent-loop 提供压缩决策
//
// ## 依赖
// config.ts
//
// ## 维护规则
// 新增压缩策略时需在此文件添加对应分支
//
import type { ZeroCoreConfig } from "./config.js";

export function shouldCompact(
	config: ZeroCoreConfig,
	tokensBefore: number,
	contextWindow: number,
): boolean {
	if (config.compaction.strategy === "auto") {
		// Auto compaction not yet implemented
		return false;
	}
	const reserve = config.compaction.reserveTokens ?? 16384;
	return tokensBefore > contextWindow - reserve;
}

export function buildCompactionInstructions(config: ZeroCoreConfig): string | undefined {
	if (config.compaction.strategy !== "custom") return undefined;
	return config.compaction.customInstructions;
}
