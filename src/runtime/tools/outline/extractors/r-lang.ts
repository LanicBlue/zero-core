import { OutlineNode, LangExtractor } from "../types.js";

/**
 * R extractor.
 * Extracts: library, function.
 */
export class RExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			// library / require
			const libMatch = trimmed.match(/^(?:library|require)\((\w+)/);
			if (libMatch) {
				nodes.push({ kind: "import", name: libMatch[1], line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				continue;
			}

			// function assignment
			const fnMatch = trimmed.match(/^(\w+)\s*(?:=|<-)\s*function\s*\(/);
			if (fnMatch) {
				const endLine = this.findEnd(lines, i);
				nodes.push({ kind: "function", name: fnMatch[1], line: i + 1, endLine, detail: trimmed.slice(0, 80), children: [] });
			}
		}

		return nodes;
	}

	private findEnd(lines: string[], startIdx: number): number {
		let depth = 0;
		for (let i = startIdx; i < lines.length; i++) {
			for (const ch of lines[i]) {
				if (ch === "(" || ch === "{") depth++;
				if (ch === ")" || ch === "}") depth--;
			}
			if (depth <= 0 && i > startIdx) return i + 1;
		}
		return lines.length;
	}
}
