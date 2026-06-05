// Rust 代码大纲提取器
//
// # 文件说明书
//
// ## 核心功能
// 从 Rust 源码中提取 use、fn、struct、enum、impl、trait 等大纲节点
//
// ## 输入
// Rust 源代码文本
//
// ## 输出
// OutlineNode 数组（函数、结构体、枚举、trait 等）
//
// ## 定位
// src/runtime/tools/outline/extractors/ — 大纲模块语言提取器
//
// ## 依赖
// ../types.js、../stripper.js
//
// ## 维护规则
// Rust async/await 和宏规则需正确处理
//
import { OutlineNode, LangExtractor } from "../types.js";
import { stripComments } from "../stripper.js";

/**
 * Rust extractor.
 * Extracts: use, fn, struct, enum, impl, trait, mod, const, static, type alias.
 */
export class RustExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const cleaned = stripComments(source, "c");
		const origLines = source.split("\n");
		const lines = cleaned.split("\n");
		const nodes: OutlineNode[] = [];
		let i = 0;

		while (i < lines.length) {
			const trimmed = lines[i].trim();
			if (!trimmed) { i++; continue; }

			// Attribute / inner attribute
			if (trimmed.startsWith("#[") || trimmed.startsWith("#![")) {
				// Skip multi-line attributes
				while (i < lines.length - 1 && !lines[i].includes("]")) i++;
				i++; continue;
			}

			// use
			if (/^use\s/.test(trimmed)) {
				const start = i + 1;
				while (i < lines.length - 1 && !lines[i].includes(";")) i++;
				const name = trimmed.replace(/^use\s+/, "").replace(/;.*/, "").slice(0, 60);
				nodes.push({ kind: "import", name, line: start, endLine: i + 1, detail: this.summary(origLines[start - 1].trim()), children: [] });
				i++; continue;
			}

			// mod
			const modMatch = trimmed.match(/^mod\s+(\w+)/);
			if (modMatch) {
				const name = modMatch[1];
				const start = i + 1;
				if (trimmed.includes(";")) {
					nodes.push({ kind: "module", name, line: start, endLine: start, detail: trimmed, children: [] });
					i++; continue;
				}
				const block = this.findBlock(lines, i);
				nodes.push({ kind: "module", name, line: start, endLine: block.endLine, detail: trimmed, children: [] });
				i = block.endIdx + 1; continue;
			}

			// struct
			if (/^(?:pub\s+)?struct\s+/.test(trimmed)) {
				const nameMatch = trimmed.match(/struct\s+(\w+)/);
				if (nameMatch) {
					const start = i + 1;
					const block = this.findBlock(lines, i);
					nodes.push({ kind: "struct", name: nameMatch[1], line: start, endLine: block.endLine, detail: this.summary(origLines[i].trim()), children: [] });
					i = block.endIdx + 1; continue;
				}
			}

			// enum
			if (/^(?:pub\s+)?enum\s+/.test(trimmed)) {
				const nameMatch = trimmed.match(/enum\s+(\w+)/);
				if (nameMatch) {
					const start = i + 1;
					const block = this.findBlock(lines, i);
					nodes.push({ kind: "enum", name: nameMatch[1], line: start, endLine: block.endLine, detail: this.summary(origLines[i].trim()), children: [] });
					i = block.endIdx + 1; continue;
				}
			}

			// impl
			const implMatch = trimmed.match(/^impl\s+(?:<[^>]+>\s+)?(.+?)(?:\s+for\s+.+)?\s*\{?$/);
			if (implMatch) {
				const name = implMatch[1].trim().slice(0, 60);
				const start = i + 1;
				const block = this.findBlock(lines, i);
				nodes.push({ kind: "impl", name, line: start, endLine: block.endLine, detail: this.summary(origLines[i].trim()), children: [] });
				i = block.endIdx + 1; continue;
			}

			// trait
			if (/^(?:pub\s+)?trait\s+/.test(trimmed)) {
				const nameMatch = trimmed.match(/trait\s+(\w+)/);
				if (nameMatch) {
					const start = i + 1;
					const block = this.findBlock(lines, i);
					nodes.push({ kind: "trait", name: nameMatch[1], line: start, endLine: block.endLine, detail: this.summary(origLines[i].trim()), children: [] });
					i = block.endIdx + 1; continue;
				}
			}

			// fn
			const fnMatch = trimmed.match(/^(?:(?:pub|async|const|unsafe|extern)\s+)*fn\s+(\w+)/);
			if (fnMatch) {
				const start = i + 1;
				const block = this.findBlock(lines, i);
				nodes.push({ kind: "function", name: fnMatch[1], line: start, endLine: block.endLine, detail: this.summary(origLines[i].trim()), children: [] });
				i = block.endIdx + 1; continue;
			}

			// const / static
			const constMatch = trimmed.match(/^(?:(?:pub)\s+)?(?:const|static)\s+(\w+)/);
			if (constMatch) {
				nodes.push({ kind: "const", name: constMatch[1], line: i + 1, endLine: i + 1, detail: this.summary(origLines[i].trim()), children: [] });
				i++; continue;
			}

			// type alias
			const typeMatch = trimmed.match(/^(?:pub\s+)?type\s+(\w+)/);
			if (typeMatch) {
				nodes.push({ kind: "type", name: typeMatch[1], line: i + 1, endLine: i + 1, detail: this.summary(origLines[i].trim()), children: [] });
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
