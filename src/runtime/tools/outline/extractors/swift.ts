import { OutlineNode, LangExtractor } from "../types.js";

/**
 * Swift extractor.
 * Extracts: import, class, struct, enum, protocol, func, var/let (top-level).
 */
export class SwiftExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const cleaned: string[] = [];
		let inBlock = false;
		for (const line of lines) {
			if (inBlock) {
				if (line.includes("*/")) { inBlock = false; cleaned.push(line.slice(line.indexOf("*/") + 2)); }
				else cleaned.push("");
				continue;
			}
			if (line.includes("/*")) {
				if (!line.includes("*/")) { inBlock = true; cleaned.push(line.slice(0, line.indexOf("/*"))); }
				else cleaned.push(line.slice(0, line.indexOf("/*")) + line.slice(line.indexOf("*/") + 2));
				continue;
			}
			const idx = line.indexOf("//");
			cleaned.push(idx >= 0 ? line.slice(0, idx) : line);
		}

		const nodes: OutlineNode[] = [];
		let i = 0;
		while (i < cleaned.length) {
			const trimmed = cleaned[i].trim();
			if (!trimmed) { i++; continue; }

			if (trimmed.startsWith("@")) { i++; continue; } // attributes

			// import
			if (/^import\s+/.test(trimmed)) {
				const name = trimmed.replace(/^import\s+/, "");
				nodes.push({ kind: "import", name, line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// class / struct / enum / protocol / extension / actor
			const typeMatch = trimmed.match(/^(?:(?:public|private|internal|open|fileprivate|final|abstract|override)\s+)*(class|struct|enum|protocol|extension|actor)\s+(\w+)/);
			if (typeMatch) {
				const kind = typeMatch[1];
				const name = typeMatch[2];
				const block = this.findBlock(cleaned, i);
				nodes.push({ kind, name, line: i + 1, endLine: block.endLine, detail: trimmed.slice(0, 80), children: [] });
				i = block.endIdx + 1; continue;
			}

			// func
			const fnMatch = trimmed.match(/^(?:(?:public|private|internal|open|fileprivate|static|class|override|async|throws|rethrows|mutating|nonmutating)\s+)*func\s+(\w+)/);
			if (fnMatch) {
				const block = this.findBlock(cleaned, i);
				nodes.push({ kind: "function", name: fnMatch[1], line: i + 1, endLine: block.endLine, detail: trimmed.slice(0, 80), children: [] });
				i = block.endIdx + 1; continue;
			}

			// var / let (top-level)
			const varMatch = trimmed.match(/^(?:(?:public|private|internal|static|let|var)\s+)+(?:let|var)\s+(\w+)/);
			if (varMatch) {
				nodes.push({ kind: "property", name: varMatch[1], line: i + 1, endLine: i + 1, detail: trimmed.slice(0, 60), children: [] });
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
}
