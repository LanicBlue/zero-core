// C/C++ 代码大纲提取器
//
// # 文件说明书
//
// ## 核心功能
// 从 C/C++ 源码中提取 include、struct、class、function 等大纲节点
//
// ## 输入
// C/C++ 源代码文本
//
// ## 输出
// OutlineNode 数组（结构体、类、函数声明等）
//
// ## 定位
// src/runtime/tools/outline/extractors/ — 大纲模块语言提取器
//
// ## 依赖
// ../types.js、../stripper.js
//
// ## 维护规则
// C++ 新特性（如 concepts）需更新提取逻辑
//
import { OutlineNode, LangExtractor } from "../types.js";
import { stripComments } from "../stripper.js";

/**
 * C/C++ extractor. Also covers C++ extensions (.cpp, .hpp, .cc, .cxx).
 * Extracts: #include, #define, struct, enum, typedef, namespace, class,
 * template, function declarations, using declarations.
 */
export class CFamilyExtractor implements LangExtractor {
	constructor(private isCpp: boolean = false) {}

	extract(source: string): OutlineNode[] {
		const cleaned = stripComments(source, "c");
		const lines = cleaned.split("\n");
		const nodes: OutlineNode[] = [];
		let i = 0;

		while (i < lines.length) {
			const trimmed = lines[i].trim();
			if (!trimmed) { i++; continue; }

			// Preprocessor directive
			if (trimmed.startsWith("#")) {
				const start = i + 1;
				// Multi-line directive (backslash continuation)
				while (i < lines.length - 1 && lines[i].trimEnd().endsWith("\\")) i++;
				const detail = trimmed;
				let name = trimmed;
				if (trimmed.startsWith("#include")) name = trimmed.replace(/#.*/, "").trim().slice(0, 60);
				else if (trimmed.startsWith("#define")) name = trimmed.replace(/#\s*define\s+/, "").split(/\s/)[0];
				else name = trimmed.slice(0, 60);

				nodes.push({ kind: "preprocessor", name, line: start, endLine: i + 1, detail, children: [] });
				i++; continue;
			}

			// namespace (C++)
			if (this.isCpp) {
				const nsMatch = trimmed.match(/^namespace\s+(\w+)/);
				if (nsMatch) {
					const name = nsMatch[1];
					const start = i + 1;
					const block = this.findBlock(lines, i);
					const children = this.extractBlockDeclarations(lines, i + 1, block.endIdx);
					nodes.push({ kind: "namespace", name, line: start, endLine: block.endLine, detail: trimmed, children });
					i = block.endIdx + 1; continue;
				}
			}

			// struct / class / enum / union
			const typeMatch = trimmed.match(/^(?:typedef\s+)?(?:(?:struct|class|enum(?:\s+class)?)\s+)(\w+)/);
			if (typeMatch) {
				const name = typeMatch[1];
				const start = i + 1;
				const block = this.findBlock(lines, i);
				const kind = trimmed.includes("class") ? "class" : trimmed.includes("enum") ? "enum" : "struct";
				nodes.push({ kind, name, line: start, endLine: block.endLine, detail: trimmed.slice(0, 80), children: [] });
				i = block.endIdx + 1; continue;
			}

			// typedef (non-struct)
			if (/^typedef\s/.test(trimmed) && !trimmed.includes("struct") && !trimmed.includes("enum")) {
				const aliasMatch = trimmed.match(/(\w+)\s*;/);
				const name = aliasMatch ? aliasMatch[1] : trimmed.slice(0, 40);
				nodes.push({ kind: "typedef", name, line: i + 1, endLine: i + 1, detail: trimmed.slice(0, 80), children: [] });
				i++; continue;
			}

			// template (C++)
			if (this.isCpp && /^template\s*</.test(trimmed)) {
				// Find the actual declaration after template<...>
				let declLine = trimmed;
				let declIdx = i;
				if (!declLine.includes("{") && !declLine.includes(";")) {
					// Template on its own line, declaration on next
					declIdx = i + 1;
					declLine = lines[declIdx]?.trim() ?? "";
				}
				const fnMatch = declLine.match(/(\w+)\s*\(/);
				const classMatch = declLine.match(/(?:class|struct)\s+(\w+)/);
				if (classMatch || fnMatch) {
					const name = classMatch ? classMatch[1] : fnMatch![1];
					const start = i + 1;
					const block = this.findBlock(lines, i);
					const kind = classMatch ? "class" : "function";
					nodes.push({ kind, name, line: start, endLine: block.endLine, detail: trimmed.slice(0, 80), children: [] });
					i = block.endIdx + 1; continue;
				}
			}

			// using (C++)
			if (this.isCpp && /^using\s/.test(trimmed)) {
				const nameMatch = trimmed.match(/using\s+(?:namespace\s+)?(\w+)/);
				const name = nameMatch ? nameMatch[1] : trimmed.slice(0, 40);
				nodes.push({ kind: "using", name, line: i + 1, endLine: i + 1, detail: trimmed.slice(0, 80), children: [] });
				i++; continue;
			}

			// Top-level function
			const fnMatch = trimmed.match(/^(?:(?:static|inline|extern|virtual|const)\s+)*(?:\w[\w:*&<>,\s]*?)\s+(\w+)\s*\(/);
			if (fnMatch && !trimmed.startsWith("if") && !trimmed.startsWith("for") && !trimmed.startsWith("while") && !trimmed.startsWith("switch") && !trimmed.startsWith("return") && !trimmed.startsWith("case")) {
				const name = fnMatch[1];
				const start = i + 1;
				const block = this.findBlock(lines, i);
				nodes.push({ kind: "function", name, line: start, endLine: block.endLine, detail: trimmed.slice(0, 80), children: [] });
				i = block.endIdx + 1; continue;
			}

			i++;
		}

		return nodes;
	}

	private extractBlockDeclarations(lines: string[], start: number, end: number): OutlineNode[] {
		const sub = lines.slice(start, end + 1);
		const extractor = new CFamilyExtractor(this.isCpp);
		return extractor.extract(sub.join("\n"));
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
		// If no braces found, it's a single-line declaration
		return { endIdx: startIdx, endLine: startIdx + 1 };
	}
}
