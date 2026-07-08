// Ruby 代码大纲提取器
//
// # 文件说明书
//
// ## 核心功能
// 从 Ruby 源码中提取 require、class、module、def、attr 等大纲节点
//
// ## 输入
// Ruby 源代码文本
//
// ## 输出
// OutlineNode 数组（类、模块、方法、属性等）
//
// ## 定位
// src/runtime/tools/outline/extractors/ — 大纲模块语言提取器
//
// ## 依赖
// ../types.js
//
// ## 维护规则
// Ruby 块语法和元编程需正确跳过
//
import { OutlineNode, LangExtractor } from "../types.js";

/**
 * Ruby extractor.
 * Extracts: require, class, module, def, attr_*, constant.
 */
export class RubyExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		return this.parseBlock(lines, 0, lines.length, -1);
	}

	private parseBlock(lines: string[], start: number, end: number, minIndent: number): OutlineNode[] {
		const nodes: OutlineNode[] = [];
		let i = start;

		while (i < end) {
			const line = lines[i];
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) { i++; continue; }

			const indent = this.getIndent(line);
			if (indent < minIndent) break;

			// require / require_relative
			if (/^require/.test(trimmed)) {
				const name = trimmed.replace(/^require(?:_relative)?\s+/, "").replace(/['"]/g, "");
				nodes.push({ kind: "import", name, line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// module
			const modMatch = trimmed.match(/^module\s+(\w+)/);
			if (modMatch) {
				const name = modMatch[1];
				const childEnd = this.findBlockEnd(lines, i + 1, end, indent);
				const children = this.parseBlock(lines, i + 1, childEnd, indent + 2);
				nodes.push({ kind: "module", name, line: i + 1, endLine: childEnd, detail: trimmed, children });
				i = childEnd; continue;
			}

			// class
			const classMatch = trimmed.match(/^class\s+(\w+)/);
			if (classMatch) {
				const name = classMatch[1];
				const childEnd = this.findBlockEnd(lines, i + 1, end, indent);
				const children = this.parseBlock(lines, i + 1, childEnd, indent + 2);
				nodes.push({ kind: "class", name, line: i + 1, endLine: childEnd, detail: trimmed, children });
				i = childEnd; continue;
			}

			// def
			const defMatch = trimmed.match(/^def\s+(\w+[?!]?)/);
			if (defMatch) {
				const name = defMatch[1];
				const childEnd = this.findBlockEnd(lines, i + 1, end, indent);
				nodes.push({ kind: "function", name, line: i + 1, endLine: childEnd, detail: trimmed, children: [] });
				i = childEnd; continue;
			}

			// attr_*
			const attrMatch = trimmed.match(/^(attr_accessor|attr_reader|attr_writer)\s+(.+)/);
			if (attrMatch) {
				const names = attrMatch[2].replace(/[:]/g, "").split(/,\s*/);
				for (const n of names) {
					nodes.push({ kind: "property", name: n.trim(), line: i + 1, endLine: i + 1, detail: attrMatch[1], children: [] });
				}
				i++; continue;
			}

			i++;
		}

		return nodes;
	}

	private findBlockEnd(lines: string[], start: number, parentEnd: number, parentIndent: number): number {
		for (let i = start; i < parentEnd; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed) continue;
			if (this.getIndent(lines[i]) <= parentIndent) return i;
		}
		return parentEnd;
	}

	private getIndent(line: string): number {
		let count = 0;
		for (const ch of line) {
			if (ch === " ") count++;
			else if (ch === "\t") count += 2;
			else break;
		}
		return count;
	}
}
