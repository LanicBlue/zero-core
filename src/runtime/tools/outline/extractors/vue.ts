// Vue 单文件组件大纲提取器
//
// # 文件说明书
//
// ## 核心功能
// 从 Vue SFC 中提取 template、script、style 块的结构大纲
//
// ## 输入
// Vue 单文件组件文本
//
// ## 输出
// OutlineNode 数组（template 标签、script 导入/导出、style 规则）
//
// ## 定位
// src/runtime/tools/outline/extractors/ — 大纲模块语言提取器
//
// ## 依赖
// ../types.js、typescript.js
//
// ## 维护规则
// Vue 3 Composition API 和 <script setup> 需正确处理
//
import { OutlineNode, LangExtractor } from "../types.js";
import { TypeScriptExtractor } from "./typescript.js";

/**
 * Vue Single File Component extractor.
 * Extracts: <template>, <script>, <style> sections.
 */
export class VueExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];

		// Find top-level sections
		const sectionRe = /^<(template|script|style)(?:\s[^>]*)?>(?:<\/\1>)?$/i;
		const sectionStartRe = /^<(template|script|style)(?:\s[^>]*)?>$/i;
		const sectionEndRe = /^<\/(template|script|style)>$/i;

		let i = 0;
		while (i < lines.length) {
			const trimmed = lines[i].trim();

			// Single-line section: <template>...</template>
			const singleLineMatch = trimmed.match(/^<(template|script|style)(?:\s[^>]*)?>(.*)<\/\1>$/i);
			if (singleLineMatch) {
				const name = singleLineMatch[1].toLowerCase();
				nodes.push({ kind: "section", name, line: i + 1, endLine: i + 1, detail: `<${name}>`, children: [] });
				i++; continue;
			}

			// Multi-line section start
			const startMatch = trimmed.match(sectionStartRe) || trimmed.match(/^<(script|style|template)(?:\s[^>]*)?>/i);
			if (startMatch) {
				const name = startMatch[1].toLowerCase();
				const startLine = i + 1;
				let endLine = startLine;

				// Find closing tag
				const endRe = new RegExp(`^<\\/${name}>$`, "i");
				for (let j = i + 1; j < lines.length; j++) {
					if (endRe.test(lines[j].trim())) {
						endLine = j + 1;
						break;
					}
				}

				// For script section, use TypeScript extractor on content
				let children: OutlineNode[] = [];
				if (name === "script") {
					const content = lines.slice(i + 1, endLine - 1).join("\n");
					const ts = new TypeScriptExtractor();
					children = ts.extract(content);
					// Adjust line numbers
					for (const child of children) {
						child.line += i + 1;
						child.endLine += i + 1;
					}
				}

				nodes.push({ kind: "section", name, line: startLine, endLine, detail: `<${name}>`, children });
				i = endLine; continue;
			}

			i++;
		}

		return nodes;
	}
}
