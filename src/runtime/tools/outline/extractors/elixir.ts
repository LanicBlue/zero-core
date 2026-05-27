import { OutlineNode, LangExtractor } from "../types.js";

/**
 * Elixir extractor.
 * Extracts: defmodule, def, defp.
 */
export class ElixirExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		return this.parseBlock(lines, 0, lines.length, 0);
	}

	private parseBlock(lines: string[], start: number, end: number, minIndent: number): OutlineNode[] {
		const nodes: OutlineNode[] = [];
		let i = start;

		while (i < end) {
			const line = lines[i];
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) { i++; continue; }

			const indent = this.getIndent(line);

			// defmodule
			const modMatch = trimmed.match(/^defmodule\s+([\w.]+)/);
			if (modMatch) {
				const name = modMatch[1];
				const childEnd = this.findBlockEnd(lines, i + 1, end, indent);
				const children = this.parseBlock(lines, i + 1, childEnd, indent + 2);
				nodes.push({ kind: "module", name, line: i + 1, endLine: childEnd, detail: trimmed, children });
				i = childEnd; continue;
			}

			// def / defp
			const defMatch = trimmed.match(/^def(p?)\s+(\w+)/);
			if (defMatch) {
				const name = defMatch[2];
				const childEnd = this.findBlockEnd(lines, i + 1, end, indent);
				nodes.push({ kind: defMatch[1] === "p" ? "function" : "function", name, line: i + 1, endLine: childEnd, detail: trimmed, children: [] });
				i = childEnd; continue;
			}

			i++;
		}

		return nodes;
	}

	private findBlockEnd(lines: string[], start: number, parentEnd: number, parentIndent: number): number {
		for (let i = start; i < parentEnd; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed) continue;
			if (this.getIndent(lines[i]) <= parentIndent) return i;
		}
		return parentEnd;
	}

	private getIndent(line: string): number {
		let count = 0;
		for (const ch of line) {
			if (ch === " ") count++;
			else break;
		}
		return count;
	}
}
