// Go 代码大纲提取器
//
// # 文件说明书
//
// ## 核心功能
// 从 Go 源码中提取 import、func、type、interface、struct 等大纲节点
//
// ## 输入
// Go 源代码文本
//
// ## 输出
// OutlineNode 数组（函数、类型、接口、结构体等）
//
// ## 定位
// src/runtime/tools/outline/extractors/ — 大纲模块语言提取器
//
// ## 依赖
// ../types.js、../stripper.js
//
// ## 维护规则
// Go 泛型语法需正确解析
//
import { OutlineNode, LangExtractor } from "../types.js";
import { stripComments } from "../stripper.js";

/**
 * Go extractor.
 * Extracts: package, import, func (with receiver), type struct/interface, const, var.
 */
export class GoExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const cleaned = stripComments(source, "c");
		const origLines = source.split("\n");
		const lines = cleaned.split("\n");
		const nodes: OutlineNode[] = [];
		let i = 0;

		while (i < lines.length) {
			const trimmed = lines[i].trim();
			if (!trimmed) { i++; continue; }

			// package
			if (/^package\s+/.test(trimmed)) {
				const name = trimmed.replace(/^package\s+/, "");
				nodes.push({ kind: "package", name, line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// import (single or group)
			if (/^import\s/.test(trimmed)) {
				const start = i + 1;
				if (trimmed.includes("(")) {
					while (i < lines.length - 1 && !lines[i].includes(")")) i++;
				}
				nodes.push({ kind: "import", name: "imports", line: start, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// func
			const funcMatch = trimmed.match(/^func\s+(?:\(([^)]*)\)\s+)?(\w+)/);
			if (funcMatch) {
				const receiver = funcMatch[1]?.trim();
				const name = funcMatch[2];
				const start = i + 1;
				const block = this.findBlock(lines, i);
				const detail = receiver ? `(${receiver}) ${name}` : name;
				nodes.push({ kind: "function", name, line: start, endLine: block.endLine, detail: this.summary(origLines[i].trim()), children: [] });
				i = block.endIdx + 1; continue;
			}

			// type struct / interface
			const typeMatch = trimmed.match(/^type\s+(\w+)\s+(struct|interface)/);
			if (typeMatch) {
				const name = typeMatch[1];
				const kind = typeMatch[2] === "struct" ? "struct" : "interface";
				const start = i + 1;
				const block = this.findBlock(lines, i);
				nodes.push({ kind, name, line: start, endLine: block.endLine, detail: this.summary(origLines[i].trim()), children: [] });
				i = block.endIdx + 1; continue;
			}

			// type alias
			const typeAliasMatch = trimmed.match(/^type\s+(\w+)\s+/);
			if (typeAliasMatch && !trimmed.includes("struct") && !trimmed.includes("interface")) {
				nodes.push({ kind: "type", name: typeAliasMatch[1], line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// const / var block
			if (/^(?:const|var)\s/.test(trimmed)) {
				const start = i + 1;
				if (trimmed.includes("(")) {
					while (i < lines.length - 1 && !lines[i].includes(")")) i++;
				}
				const name = trimmed.replace(/^(?:const|var)\s+/, "").split(/\s/)[0];
				nodes.push({ kind: "const", name: name || "block", line: start, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
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

	private summary(s: string): string {
		const d = s.replace(/\s+/g, " ").trim();
		return d.length > 90 ? d.slice(0, 87) + "..." : d;
	}
}
