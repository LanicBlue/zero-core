// Dart 代码大纲提取器
//
// # 文件说明书
//
// ## 核心功能
// 从 Dart 源码中提取 import、class、mixin、enum、extension、function 等大纲节点
//
// ## 输入
// Dart 源代码文本
//
// ## 输出
// OutlineNode 数组（类、mixin、枚举、扩展、函数等）
//
// ## 定位
// src/runtime/tools/outline/extractors/ — 大纲模块语言提取器
//
// ## 依赖
// ../types.js
//
// ## 维护规则
// Dart 3 新特性（如 pattern、sealed class）需更新提取逻辑
//
import { OutlineNode, LangExtractor } from "../types.js";

/**
 * Dart extractor.
 * Extracts: import, class, abstract class, mixin, enum, extension, function, typedef.
 */
export class DartExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const cleaned: string[] = [];
		let inBlock = false;
		for (const line of lines) {
			if (inBlock) {
				if (line.includes("*/")) { inBlock = false; cleaned.push(line.slice(line.indexOf("*/") + 2)); }
				else cleaned.push("");
				continue;
			}
			if (line.includes("/*")) {
				if (!line.includes("*/")) { inBlock = true; cleaned.push(line.slice(0, line.indexOf("/*"))); }
				else cleaned.push(line.slice(0, line.indexOf("/*")) + line.slice(line.indexOf("*/") + 2));
				continue;
			}
			const idx = line.indexOf("//");
			cleaned.push(idx >= 0 ? line.slice(0, idx) : line);
		}

		const nodes: OutlineNode[] = [];
		let i = 0;
		while (i < cleaned.length) {
			const trimmed = cleaned[i].trim();
			if (!trimmed) { i++; continue; }
			if (trimmed.startsWith("@")) { i++; continue; }

			// import / part
			if (/^import\s+/.test(trimmed) || /^part\s+/.test(trimmed)) {
				const name = trimmed.replace(/^(?:import|part)\s+/, "").replace(/['";]/g, "").split("/").pop() || "";
				nodes.push({ kind: "import", name, line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// class / abstract class / mixin / enum / extension / typedef
			const typeMatch = trimmed.match(/^(?:abstract\s+)?(?:class|mixin|enum|extension|typedef)\s+(\w+)/);
			if (typeMatch) {
				const kind = trimmed.includes("mixin") ? "mixin" : trimmed.includes("enum") ? "enum" : trimmed.includes("extension") ? "extension" : trimmed.includes("typedef") ? "typedef" : "class";
				const name = typeMatch[1];
				const block = this.findBlock(cleaned, i);
				nodes.push({ kind, name, line: i + 1, endLine: block.endLine, detail: trimmed.slice(0, 80), children: [] });
				i = block.endIdx + 1; continue;
			}

			// function
			const fnMatch = trimmed.match(/^(?:(?:static|external|async|sync|\*)\s+)*(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/);
			if (fnMatch && !/^(if|for|while|switch|return|throw|new|assert|case|catch)\b/.test(trimmed)) {
				const block = this.findBlock(cleaned, i);
				nodes.push({ kind: "function", name: fnMatch[1], line: i + 1, endLine: block.endLine, detail: trimmed.slice(0, 80), children: [] });
				i = block.endIdx + 1; continue;
			}

			i++;
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
