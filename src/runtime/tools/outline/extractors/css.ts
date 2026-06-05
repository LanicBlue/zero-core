// CSS/SCSS/SASS/Less 大纲提取器
//
// # 文件说明书
//
// ## 核心功能
// 从 CSS/SCSS/SASS/Less 中提取选择器、@media、@keyframes、变量等大纲节点
//
// ## 输入
// CSS/SCSS/SASS/Less 文本
//
// ## 输出
// OutlineNode 数组（选择器、媒体查询、关键帧、变量等）
//
// ## 定位
// src/runtime/tools/outline/extractors/ — 大纲模块语言提取器
//
// ## 依赖
// ../types.js
//
// ## 维护规则
// CSS 嵌套语法和容器查询需正确解析
//
import { OutlineNode, LangExtractor } from "../types.js";

/**
 * CSS/SCSS/SASS/Less extractor.
 * Extracts: selectors, @media, @keyframes, property names, variables.
 */
export class CssExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];
		let i = 0;

		while (i < lines.length) {
			const line = lines[i];
			const trimmed = line.trim();

			if (!trimmed || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("//")) {
				i++;
				continue;
			}

			// @rule: @media, @keyframes, @font-face, @import, @use, @forward
			const atMatch = trimmed.match(/^(@[\w-]+)\s+(.+?)(?:\s*\{)?$/);
			if (atMatch) {
				const kind = atMatch[1].replace("@", "");
				const name = atMatch[2].trim();
				const start = i + 1;
				const block = this.findBlock(lines, i);
				const children = kind === "media" || kind === "keyframes"
					? this.extractNestedRules(lines, i + 1, block.endIdx)
					: [];
				nodes.push({ kind, name, line: start, endLine: block.endLine, detail: trimmed.slice(0, 80), children });
				i = block.endIdx + 1;
				continue;
			}

			// Variable: $var or --var
			if (/^\$[\w-]+\s*:/.test(trimmed) || /^--[\w-]+\s*:/.test(trimmed)) {
				const name = trimmed.split(":")[0].trim();
				nodes.push({ kind: "variable", name, line: i + 1, endLine: i + 1, detail: trimmed.slice(0, 80), children: [] });
				i++; continue;
			}

			// Rule: selector {
			if (trimmed.includes("{")) {
				const start = i + 1;
				const block = this.findBlock(lines, i);
				const selector = trimmed.replace(/\s*\{.*$/, "").trim().slice(0, 80);
				nodes.push({ kind: "rule", name: selector, line: start, endLine: block.endLine, detail: selector, children: [] });
				i = block.endIdx + 1;
				continue;
			}

			i++;
		}

		return nodes;
	}

	private extractNestedRules(lines: string[], start: number, end: number): OutlineNode[] {
		const sub = lines.slice(start, end + 1);
		const nodes = this.extract(sub.join("\n"));
		const offset = start; // 0-based line index offset
		for (const n of nodes) {
			n.line += offset;
			n.endLine += offset;
		}
		return nodes;
	}

	private findBlock(lines: string[], startIdx: number): { endIdx: number; endLine: number } {
		let depth = 0;
		let foundOpen = false;
		for (let i = startIdx; i < lines.length; i++) {
			for (const ch of lines[i]) {
				if (ch === "{") { depth++; foundOpen = true; }
				if (ch === "}") depth--;
			}
			if (foundOpen && depth <= 0) return { endIdx: i, endLine: i + 1 };
		}
		return { endIdx: startIdx, endLine: startIdx + 1 };
	}
}
