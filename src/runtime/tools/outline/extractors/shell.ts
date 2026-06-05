// Shell 脚本大纲提取器
//
// # 文件说明书
//
// ## 核心功能
// 从 Shell 脚本（bash/zsh/sh）中提取 function、source 等大纲节点
//
// ## 输入
// Shell 脚本文本
//
// ## 输出
// OutlineNode 数组（函数、source 引用等）
//
// ## 定位
// src/runtime/tools/outline/extractors/ — 大纲模块语言提取器
//
// ## 依赖
// ../types.js
//
// ## 维护规则
// 不同 shell 方言（bash vs zsh）需兼容处理
//
import { OutlineNode, LangExtractor } from "../types.js";

/**
 * Shell extractor (bash, zsh, sh).
 * Extracts: function, source.
 */
export class ShellExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			// function keyword
			const fnMatch = trimmed.match(/^(?:function\s+)?(\w+)\s*\(\)/);
			if (fnMatch) {
				const name = fnMatch[1];
				const endLine = this.findEnd(lines, i);
				nodes.push({ kind: "function", name, line: i + 1, endLine, detail: trimmed, children: [] });
				continue;
			}

			// source / .
			const srcMatch = trimmed.match(/^(?:source|\.)\s+(.+)/);
			if (srcMatch) {
				nodes.push({ kind: "import", name: srcMatch[1].trim(), line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
			}
		}

		return nodes;
	}

	private findEnd(lines: string[], startIdx: number): number {
		let depth = 0;
		for (let i = startIdx; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (/\b(if|case|for|while|until|select)\b/.test(trimmed) && !trimmed.startsWith("#")) depth++;
			if (trimmed === "fi" || trimmed === "esac" || trimmed === "done") depth--;
			if (trimmed === "}" || (trimmed === "done" && depth <= 0)) return i + 1;
		}
		return lines.length;
	}
}
