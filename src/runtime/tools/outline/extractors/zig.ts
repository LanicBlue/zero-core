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
