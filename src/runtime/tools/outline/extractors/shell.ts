import { OutlineNode, LangExtractor } from "../types.js";

/**
 * Shell extractor (bash, zsh, sh).
 * Extracts: function, source.
 */
export class ShellExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			// function keyword
			const fnMatch = trimmed.match(/^(?:function\s+)?(\w+)\s*\(\)/);
			if (fnMatch) {
				const name = fnMatch[1];
				const endLine = this.findEnd(lines, i);
				nodes.push({ kind: "function", name, line: i + 1, endLine, detail: trimmed, children: [] });
				continue;
			}

			// source / .
			const srcMatch = trimmed.match(/^(?:source|\.)\s+(.+)/);
			if (srcMatch) {
				nodes.push({ kind: "import", name: srcMatch[1].trim(), line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
			}
		}

		return nodes;
	}

	private findEnd(lines: string[], startIdx: number): number {
		let depth = 0;
		for (let i = startIdx; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (/\b(if|case|for|while|until|select)\b/.test(trimmed) && !trimmed.startsWith("#")) depth++;
			if (trimmed === "fi" || trimmed === "esac" || trimmed === "done") depth--;
			if (trimmed === "}" || (trimmed === "done" && depth <= 0)) return i + 1;
		}
		return lines.length;
	}
}
