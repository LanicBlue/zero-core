// 用户输入预处理与命令扩展
//
// # 文件说明书
//
// ## 核心功能
// 预处理用户输入文本，支持自定义命令扩展和转换
//
// ## 输入
// 用户原始输入文本、ZeroCoreConfig 中的自定义命令配置
//
// ## 输出
// InputTransform 对象，包含转换后的文本和是否匹配标记
//
// ## 定位
// src/core/ — 核心层，在用户输入进入 agent-loop 前进行预处理
//
// ## 依赖
// config.ts
//
// ## 维护规则
// 新增输入转换规则时需在此文件添加
//
import type { ZeroCoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// User input preprocessing — custom command expansion
// ---------------------------------------------------------------------------

export interface InputTransform {
	text: string;
	matched?: boolean;
}

/**
 * Process user input through custom command templates.
 * Commands are defined in config.inputHandler.commands as { pattern: { template, description } }.
 * If the input starts with a command prefix (e.g. "/review"), expand it using the template.
 */
export function processInput(config: ZeroCoreConfig, input: string): InputTransform {
	const commands = config.inputHandler.commands;
	if (!commands) return { text: input };

	// Match against command prefixes (keys in commands)
	for (const [prefix, def] of Object.entries(commands)) {
		if (input === prefix || input.startsWith(prefix + " ")) {
			const args = input.slice(prefix.length).trim();
			const text = def.template.replace(/\{args\}/g, args);
			return { text, matched: true };
		}
	}

	return { text: input };
}
