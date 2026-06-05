// R 语言大纲提取器
//
// # 文件说明书
//
// ## 核心功能
// 从 R 源码中提取 library、function 等大纲节点
//
// ## 输入
// R 源代码文本
//
// ## 输出
// OutlineNode 数组（库引用、函数定义等）
//
// ## 定位
// src/runtime/tools/outline/extractors/ — 大纲模块语言提取器
//
// ## 依赖
// ../types.js
//
// ## 维护规则
// R 的 <- 赋值函数定义需正确识别
//
import { OutlineNode, LangExtractor } from "../types.js";

/**
 * R extractor.
 * Extracts: library, function.
 */
export class RExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			// library / require
			const libMatch = trimmed.match(/^(?:library|require)\((\w+)/);
			if (libMatch) {
				nodes.push({ kind: "import", name: libMatch[1], line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				continue;
			}

			// function assignment
			const fnMatch = trimmed.match(/^(\w+)\s*(?:=|<-)\s*function\s*\(/);
			if (fnMatch) {
				const endLine = this.findEnd(lines, i);
				nodes.push({ kind: "function", name: fnMatch[1], line: i + 1, endLine, detail: trimmed.slice(0, 80), children: [] });
			}
		}

		return nodes;
	}

	private findEnd(lines: string[], startIdx: number): number {
		let depth = 0;
		for (let i = startIdx; i < lines.length; i++) {
			for (const ch of lines[i]) {
				if (ch === "(" || ch === "{") depth++;
				if (ch === ")" || ch === "}") depth--;
			}
			if (depth <= 0 && i > startIdx) return i + 1;
		}
		return lines.length;
	}
}
