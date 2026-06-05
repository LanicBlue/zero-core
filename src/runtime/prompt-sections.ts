// 系统提示词分段组装器
//
// # 文件说明书
//
// ## 核心功能
// 将系统提示词按 section 分段组装，支持静态缓存和动态刷新
//
// ## 输入
// PromptSection 数组（含缓存标记）
//
// ## 输出
// 组装完成的系统提示词文本
//
// ## 定位
// src/runtime/ — 运行时层，为 agent-loop 提供高效的提示词管理
//
// ## 依赖
// 无外部依赖
//
// ## 维护规则
// 新增 section 时需考虑是否需要 cacheBreak 标记
//
/**
 * System prompt section-based assembly with caching.
 *
 * Inspired by claude-code's `systemPromptSection` pattern:
 * - Stable sections are computed once and cached across turns
 * - Dynamic sections (cacheBreak: true) are recomputed every turn
 * - Supports targeted invalidation for future dynamic config changes
 */

export interface PromptSection {
	name: string;
	compute: () => string | Promise<string>;
	/** true = recompute every turn; false = cache until invalidate() */
	cacheBreak: boolean;
}

export interface ResolvedSection {
	text: string;
	cacheBreak: boolean;
}

export class SystemPromptAssembler {
	private cache = new Map<string, string | null>();

	constructor(private sections: PromptSection[]) {}

	async assemble(): Promise<ResolvedSection[]> {
		const results: ResolvedSection[] = [];
		for (const section of this.sections) {
			if (!section.cacheBreak && this.cache.has(section.name)) {
				const cached = this.cache.get(section.name)!;
				if (cached) results.push({ text: cached, cacheBreak: false });
				continue;
			}
			const value = await section.compute();
			this.cache.set(section.name, value || null);
			if (value) results.push({ text: value, cacheBreak: section.cacheBreak });
		}
		return results;
	}

	invalidate(name?: string): void {
		if (name) {
			this.cache.delete(name);
		} else {
			this.cache.clear();
		}
	}
}
