import { OutlineNode, LangExtractor } from "../types.js";

export class PythonExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		return this.parseBlock(lines, 0, lines.length, -1);
	}

	private parseBlock(lines: string[], start: number, end: number, parentIndent: number): OutlineNode[] {
		const nodes: OutlineNode[] = [];
		let i = start;

		while (i < end) {
			const line = lines[i];
			const trimmed = line.trim();

			// Skip blank lines and comments
			if (!trimmed || trimmed.startsWith("#")) { i++; continue; }

			const indent = this.getIndent(line);
			if (indent <= parentIndent) break;
			if (indent > parentIndent + 8) { i++; continue; } // safety: skip deeply nested noise

			// Skip decorators (they precede the actual declaration)
			if (trimmed.startsWith("@")) { i++; continue; }

			// import / from...import
			if (/^import\s+/.test(trimmed) || /^from\s+[\w.]+\s+import/.test(trimmed)) {
				const lineNum = i + 1;
				let endLine = i + 1;
				// Multi-line import: from X import (
				if (trimmed.endsWith("(")) {
					while (endLine < end && !lines[endLine - 1].includes(")")) endLine++;
				}
				nodes.push({
					kind: "import",
					name: trimmed.slice(0, 60),
					line: lineNum,
					endLine,
					detail: trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed,
					children: [],
				});
				i = endLine;
				continue;
			}

			// class
			const classMatch = trimmed.match(/^class\s+(\w+)/);
			if (classMatch) {
				const name = classMatch[1];
				const lineNum = i + 1;
				const childEnd = this.findBlockEnd(lines, i + 1, end, indent);
				const children = this.parseBlock(lines, i + 1, childEnd, indent);
				nodes.push({
					kind: "class",
					name,
					line: lineNum,
					endLine: childEnd,
					detail: trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed,
					children,
				});
				i = childEnd;
				continue;
			}

			// def / async def
			const defMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
			if (defMatch) {
				const name = defMatch[1];
				const lineNum = i + 1;
				const childEnd = this.findBlockEnd(lines, i + 1, end, indent);
				const children = this.parseBlock(lines, i + 1, childEnd, indent);
				nodes.push({
					kind: "function",
					name,
					line: lineNum,
					endLine: childEnd,
					detail: trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed,
					children,
				});
				i = childEnd;
				continue;
			}

			// Top-level assignment
			const assignMatch = trimmed.match(/^(\w+)\s*[:=]/);
			if (assignMatch && parentIndent < 0) {
				nodes.push({
					kind: "const",
					name: assignMatch[1],
					line: i + 1,
					endLine: i + 1,
					children: [],
				});
				i++;
				continue;
			}

			i++;
		}

		return nodes;
	}

	private findBlockEnd(lines: string[], start: number, parentEnd: number, parentIndent: number): number {
		for (let i = start; i < parentEnd; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed) continue;
			const indent = this.getIndent(lines[i]);
			if (indent <= parentIndent) return i;
		}
		return parentEnd;
	}

	private getIndent(line: string): number {
		let count = 0;
		for (const ch of line) {
			if (ch === " ") count++;
			else if (ch === "\t") count += 4;
			else break;
		}
		return count;
	}
}
