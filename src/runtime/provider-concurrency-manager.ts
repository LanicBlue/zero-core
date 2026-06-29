// Provider 并发调用管理器
//
// # 文件说明书
//
// ## 核心功能
// 管理多个 LLM Provider 的并发请求队列，支持按 Provider 粒度配置并发上限和动态重配置
//
// ## 输入
// Provider 配置列表（名称、是否启用并发限制、最大并发数）
//
// ## 输出
// 按 Provider 名称获取 ConcurrencyQueue 实例，提供 getQueue/reconfigure/clear 方法
//
// ## 定位
// src/runtime/ — Agent 运行时并发控制层，被 agent-loop 在发起 LLM 调用前使用
//
// ## 依赖
// ./concurrency-queue、../core/logger
//
// ## 维护规则
// 并发数范围限制（1-10）在 clampConcurrency 中定义，修改需评估 Provider 限流策略
// 新增 Provider 需确保名称规范化规则一致
//
import { ConcurrencyQueue } from "./concurrency-queue.js";
import { log } from "../core/logger.js";

export interface ConcurrencyConfig {
	enableConcurrencyLimit: boolean;
	maxConcurrency: number;
}

export class ProviderConcurrencyManager {
	private queues = new Map<string, ConcurrencyQueue>();

	getQueue(providerName: string): ConcurrencyQueue | undefined {
		return this.queues.get(normalize(providerName));
	}

	reconfigure(configs: Array<{ name: string; enableConcurrencyLimit?: boolean; maxConcurrency?: number }>): void {
		const enabledKeys = new Set<string>();

		for (const cfg of configs) {
			const key = normalize(cfg.name);
			if (cfg.enableConcurrencyLimit) {
				enabledKeys.add(key);
				const maxConcurrency = clampConcurrency(cfg.maxConcurrency);
				const queue = this.queues.get(key);
				if (queue) {
					queue.setMax(maxConcurrency);
				} else {
					this.queues.set(key, new ConcurrencyQueue(maxConcurrency));
					log.debug("concurrency", `Created queue for ${key}, max=${maxConcurrency}`);
				}
			}
		}

		for (const [key] of this.queues) {
			if (!enabledKeys.has(key)) {
				this.queues.delete(key);
			}
		}
	}

	clear(): void {
		this.queues.clear();
	}
}

function normalize(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function clampConcurrency(n?: number | string): number {
	// 容忍字符串:TEXT 亲和列会把数字存成 REAL 文本("2"),reconfigure 拿到的
	// maxConcurrency 可能是字符串。先 Number 化再 clamp,否则 typeof !== "number"
	// 直接退回 1,用户设的并发数失效。
	const num = typeof n === "number" ? n : Number(n);
	if (!Number.isFinite(num) || num < 1) return 1;
	if (num > 10) return 10;
	return Math.floor(num);
}
