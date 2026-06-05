// Nim 代码大纲提取器
//
// # 文件说明书
//
// ## 核心功能
// 从 Nim 源码中提取 import、type、proc、func、method、template 等大纲节点
//
// ## 输入
// Nim 源代码文本
//
// ## 输出
// OutlineNode 数组（导入、类型、过程、函数、宏等）
//
// ## 定位
// src/runtime/tools/outline/extractors/ — 大纲模块语言提取器
//
// ## 依赖
// ../types.js
//
// ## 维护规则
// Nim 的缩进语法需正确跟踪嵌套层级
//
import { OutlineNode, LangExtractor } from "../types.js";

/**
 * Nim extractor.
 * Extracts: import, type, proc, func, method, template, macro, const, var.
 */
export class NimExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			// import
			const impMatch = trimmed.match(/^import\s+(.+)/);
			if (impMatch) {
				nodes.push({ kind: "import", name: impMatch[1].trim(), line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				continue;
			}

			// type
			if (/^type\b/.test(trimmed)) {
				const nameMatch = trimmed.match(/^type\s+(\w+)/);
				if (nameMatch) {
					nodes.push({ kind: "type", name: nameMatch[1], line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				} else {
					nodes.push({ kind: "type", name: "type block", line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				}
				continue;
			}

			// proc / func / method / template / macro
			const fnMatch = trimmed.match(/^(proc|func|method|template|macro)\s+(\w+)/);
			if (fnMatch) {
				const kind = fnMatch[1];
				const name = fnMatch[2];
				const endLine = this.findEnd(lines, i);
				nodes.push({ kind, name, line: i + 1, endLine, detail: trimmed.slice(0, 80), children: [] });
				continue;
			}

			// const / let / var
			const cvMatch = trimmed.match(/^(const|let|var)\s+(\w+)/);
			if (cvMatch) {
				nodes.push({ kind: cvMatch[1], name: cvMatch[2], line: i + 1, endLine: i + 1, detail: trimmed.slice(0, 60), children: [] });
			}
		}

		return nodes;
	}

	private findEnd(lines: string[], startIdx: number): number {
		let depth = 0;
		for (let i = startIdx; i < lines.length; i++) {
			for (const ch of lines[i]) {
				if (ch === "{" || ch === "(" || ch === "[") depth++;
				if (ch === "}" || ch === ")" || ch === "]") depth--;
			}
			if (depth <= 0 && i > startIdx) return i + 1;
		}
		return lines.length;
	}
}
