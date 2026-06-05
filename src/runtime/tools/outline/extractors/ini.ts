// INI/配置文件大纲提取器
//
// # 文件说明书
//
// ## 核心功能
// 从 INI/dotenv/Properties 配置文件中提取 section 和键值对
//
// ## 输入
// INI/dotenv/Properties 文本
//
// ## 输出
// OutlineNode 数组（section、键值对）
//
// ## 定位
// src/runtime/tools/outline/extractors/ — 大纲模块语言提取器
//
// ## 依赖
// ../types.js
//
// ## 维护规则
// 注释行和空行需正确跳过
//
import { OutlineNode, LangExtractor } from "../types.js";

/**
 * INI / Config / dotenv / Properties extractor.
 * Extracts: sections + key-value pairs.
 */
export class IniExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";") || trimmed.startsWith("//")) continue;

			// Section: [name]
			const secMatch = trimmed.match(/^\[([^\]]+)\]/);
			if (secMatch) {
				const endLine = this.findSectionEnd(lines, i + 1);
				nodes.push({ kind: "section", name: secMatch[1], line: i + 1, endLine, detail: "", children: [] });
				continue;
			}

			// Key = Value or Key: Value
			const kvMatch = trimmed.match(/^([\w.-]+)\s*[=:]\s*(.*)/);
			if (kvMatch) {
				const name = kvMatch[1];
				const value = kvMatch[2].trim();
				nodes.push({ kind: "key", name, line: i + 1, endLine: i + 1, detail: value.length > 60 ? value.slice(0, 57) + "..." : value, children: [] });
			}
		}

		return nodes;
	}

	private findSectionEnd(lines: string[], start: number): number {
		for (let i = start; i < lines.length; i++) {
			if (/^\[([^\]]+)\]/.test(lines[i].trim())) return i;
		}
		return lines.length;
	}
}
