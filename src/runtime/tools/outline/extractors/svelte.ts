// Svelte 组件大纲提取器
//
// # 文件说明书
//
// ## 核心功能
// 从 Svelte 组件中提取 script、style 和顶层标记元素结构
//
// ## 输入
// Svelte 组件文本
//
// ## 输出
// OutlineNode 数组（script 块、style 块、标记元素）
//
// ## 定位
// src/runtime/tools/outline/extractors/ — 大纲模块语言提取器
//
// ## 依赖
// ../types.js
//
// ## 维护规则
// Svelte 5 runes 语法需正确处理
//
import { OutlineNode, LangExtractor } from "../types.js";

/**
 * Svelte extractor.
 * Extracts: <script>, <style>, and top-level markup elements.
 */
export class SvelteExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];

		let i = 0;
		while (i < lines.length) {
			const trimmed = lines[i].trim();
			if (!trimmed) { i++; continue; }

			// <script> or <style> block
			const blockMatch = trimmed.match(/^<(script|style)(?:\s[^>]*)?>/i);
			if (blockMatch) {
				const name = blockMatch[1].toLowerCase();
				const startLine = i + 1;
				const endRe = new RegExp(`^<\\/${name}>$`, "i");
				let endLine = lines.length;
				for (let j = i + 1; j < lines.length; j++) {
					if (endRe.test(lines[j].trim())) {
						endLine = j + 1;
						break;
					}
				}
				nodes.push({ kind: "section", name, line: startLine, endLine, detail: `<${name}>`, children: [] });
				i = endLine; continue;
			}

			// Svelte control flow
			if (/^\{#(if|each|await|key)\s/.test(trimmed)) {
				const name = trimmed.replace(/^\{#/, "").split(/\s/)[0];
				const endLine = this.findSvelteBlockEnd(lines, i, name);
				nodes.push({ kind: "block", name: `#{name}`, line: i + 1, endLine, detail: trimmed.slice(0, 60), children: [] });
				i = endLine; continue;
			}

			i++;
		}

		return nodes;
	}

	private findSvelteBlockEnd(lines: string[], start: number, blockType: string): number {
		let depth = 1;
		for (let i = start + 1; i < lines.length; i++) {
			const t = lines[i].trim();
			if (t.match(new RegExp(`^\\{/#${blockType}`))) { depth--; if (depth <= 0) return i + 1; }
			if (t.match(new RegExp(`^\\{#${blockType}`))) depth++;
		}
		return lines.length;
	}
}
