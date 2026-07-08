// Zig 代码大纲提取器
//
// # 文件说明书
//
// ## 核心功能
// 从 Zig 源码中提取 const、fn、struct、enum 等大纲节点
//
// ## 输入
// Zig 源代码文本
//
// ## 输出
// OutlineNode 数组（常量、函数、结构体、枚举等）
//
// ## 定位
// src/runtime/tools/outline/extractors/ — 大纲模块语言提取器
//
// ## 依赖
// ../types.js
//
// ## 维护规则
// Zig 的 comptime 和错误集需正确处理
//
import { OutlineNode, LangExtractor } from "../types.js";

/**
 * Zig extractor.
 * Extracts: const, fn, struct, enum, usingnamespace.
 */
export class ZigExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];
		let i = 0;

		while (i < lines.length) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed.startsWith("//")) { i++; continue; }

			// pub fn / fn
			const fnMatch = trimmed.match(/^(?:pub\s+)?fn\s+(\w+)/);
			if (fnMatch) {
				const name = fnMatch[1];
				const endLine = this.findEnd(lines, i);
				nodes.push({ kind: "function", name, line: i + 1, endLine, detail: trimmed.slice(0, 80), children: [] });
				i = endLine; continue;
			}

			// pub const type = struct/enum/opaque
			const typeMatch = trimmed.match(/^(?:pub\s+)?const\s+(\w+)\s*=\s*(?:struct|enum|opaque|union)/);
			if (typeMatch) {
				const name = typeMatch[1];
				const endLine = this.findEnd(lines, i);
				nodes.push({ kind: "struct", name, line: i + 1, endLine, detail: trimmed.slice(0, 80), children: [] });
				i = endLine; continue;
			}

			// pub const
			const constMatch = trimmed.match(/^(?:pub\s+)?const\s+(\w+)/);
			if (constMatch) {
				nodes.push({ kind: "const", name: constMatch[1], line: i + 1, endLine: i + 1, detail: trimmed.slice(0, 80), children: [] });
				i++; continue;
			}

			// usingnamespace
			if (/^usingnamespace/.test(trimmed)) {
				nodes.push({ kind: "using", name: "usingnamespace", line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			i++;
		}

		return nodes;
	}

	private findEnd(lines: string[], startIdx: number): number {
		let depth = 0;
		let foundOpen = false;
		for (let i = startIdx; i < lines.length; i++) {
			for (const ch of lines[i]) {
				if (ch === "{") { depth++; foundOpen = true; }
				if (ch === "}") depth--;
			}
			if (foundOpen && depth <= 0) return i + 1;
		}
		return lines.length;
	}
}
