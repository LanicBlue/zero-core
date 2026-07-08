// Java 代码大纲提取器
//
// # 文件说明书
//
// ## 核心功能
// 从 Java 源码中提取 import、class、interface、method 等大纲节点
//
// ## 输入
// Java 源代码文本
//
// ## 输出
// OutlineNode 数组（类、接口、方法、字段等）
//
// ## 定位
// src/runtime/tools/outline/extractors/ — 大纲模块语言提取器
//
// ## 依赖
// ../types.js、../stripper.js
//
// ## 维护规则
// Java 新特性（如 record、sealed class）需更新提取逻辑
//
import { OutlineNode, LangExtractor } from "../types.js";
import { stripComments } from "../stripper.js";

/**
 * Java extractor.
 * Extracts: package, import, class, interface, enum, method, field.
 */
export class JavaExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const cleaned = stripComments(source, "c");
		const origLines = source.split("\n");
		const lines = cleaned.split("\n");
		const nodes: OutlineNode[] = [];
		let i = 0;

		while (i < lines.length) {
			const trimmed = lines[i].trim();
			if (!trimmed) { i++; continue; }

			// Skip annotations
			if (trimmed.startsWith("@")) { i++; continue; }

			// package
			if (/^package\s+/.test(trimmed)) {
				const name = trimmed.replace(/^package\s+/, "").replace(/;.*/, "");
				nodes.push({ kind: "package", name, line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// import
			if (/^import\s+(?:static\s+)?/.test(trimmed)) {
				const name = trimmed.replace(/^import\s+(?:static\s+)?/, "").replace(/;.*/, "");
				nodes.push({ kind: "import", name, line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// class / interface / enum
			const typeMatch = trimmed.match(/(?:(?:public|protected|private|abstract|final|static)\s+)*(class|interface|enum)\s+(\w+)/);
			if (typeMatch) {
				const kind = typeMatch[1] as string;
				const name = typeMatch[2];
				const start = i + 1;
				const block = this.findBlock(lines, i);
				const children = this.extractMembers(lines, origLines, i + 1, block.endIdx);
				nodes.push({ kind, name, line: start, endLine: block.endLine, detail: this.summary(origLines[i].trim()), children });
				i = block.endIdx + 1; continue;
			}

			i++;
		}

		return nodes;
	}

	private extractMembers(lines: string[], origLines: string[], startIdx: number, endIdx: number): OutlineNode[] {
		const members: OutlineNode[] = [];
		// Start at depth 1 — the class opening brace has already been opened
		let depth = 1;

		for (let i = startIdx; i <= endIdx; i++) {
			const trimmed = lines[i].trim();
			const depthBefore = depth;

			for (const ch of lines[i]) {
				if (ch === "{") depth++;
				if (ch === "}") depth--;
			}

			if (!trimmed || trimmed.startsWith("@") || trimmed.startsWith("//")) continue;
			if (depthBefore !== 1) continue;

			// Method: has parentheses
			const methodMatch = trimmed.match(/(?:(?:public|protected|private|static|abstract|final|synchronized|native|strictfp)\s+)*(?:<[^>]+>\s+)?(?:\w+(?:<[^>]+>)?(?:\[\])*)\s+(\w+)\s*\(/);
			const ctorMatch = trimmed.match(/(?:(?:public|protected|private)\s+)*(\w+)\s*\(/);

			if (methodMatch && !trimmed.startsWith("if") && !trimmed.startsWith("for") && !trimmed.startsWith("while") && !trimmed.startsWith("switch") && !trimmed.startsWith("return") && !trimmed.startsWith("throw") && !trimmed.startsWith("new") && !trimmed.startsWith("assert")) {
				const block = this.findBlock(lines, i);
				members.push({
					kind: "method",
					name: methodMatch[1],
					line: i + 1,
					endLine: block.endLine,
					detail: this.summary(origLines[i].trim()),
					children: [],
				});
				// Recalculate depth (include class opening brace at startIdx-1)
				depth = 0;
				for (let j = startIdx - 1; j <= block.endIdx; j++) {
					for (const ch of lines[j]) { if (ch === "{") depth++; if (ch === "}") depth--; }
				}
				i = block.endIdx;
				continue;
			}

			// Constructor
			if (ctorMatch) {
				const block = this.findBlock(lines, i);
				members.push({
					kind: "method",
					name: ctorMatch[1],
					line: i + 1,
					endLine: block.endLine,
					detail: this.summary(origLines[i].trim()),
					children: [],
				});
				depth = 0;
				for (let j = startIdx - 1; j <= block.endIdx; j++) {
					for (const ch of lines[j]) { if (ch === "{") depth++; if (ch === "}") depth--; }
				}
				i = block.endIdx;
				continue;
			}

			// Field
			const fieldMatch = trimmed.match(/(?:(?:public|protected|private|static|final|transient|volatile)\s+)+(?:\w+(?:<[^>]+>)?(?:\[\])*)\s+(\w+)/);
			if (fieldMatch) {
				members.push({
					kind: "field",
					name: fieldMatch[1],
					line: i + 1,
					endLine: i + 1,
					detail: this.summary(origLines[i].trim()),
					children: [],
				});
			}
		}

		return members;
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
