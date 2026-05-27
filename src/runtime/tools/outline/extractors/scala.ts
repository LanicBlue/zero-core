import { OutlineNode, LangExtractor } from "../types.js";

/**
 * Scala extractor.
 * Extracts: import, class, object, trait, def, val (top-level).
 */
export class ScalaExtractor implements LangExtractor {
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

			// import
			if (/^import\s+/.test(trimmed)) {
				const parts = trimmed.replace(/^import\s+/, "").split(".");
				nodes.push({ kind: "import", name: parts[parts.length - 1], line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// package
			if (/^package\s+/.test(trimmed)) {
				const name = trimmed.replace(/^package\s+/, "");
				nodes.push({ kind: "package", name, line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// class / object / trait / case class / enum
			const typeMatch = trimmed.match(/^(?:(?:abstract|sealed|case|final|implicit|lazy|override|private|protected)\s+)*(?:class|object|trait|enum)\s+(\w+)/);
			if (typeMatch) {
				const kind = trimmed.includes("trait") ? "trait" : trimmed.match(/\bobject\b/) ? "object" : "class";
				const name = typeMatch[1];
				const block = this.findBlock(cleaned, i);
				nodes.push({ kind, name, line: i + 1, endLine: block.endLine, detail: trimmed.slice(0, 80), children: [] });
				i = block.endIdx + 1; continue;
			}

			// def
			const defMatch = trimmed.match(/^(?:(?:private|protected|override|abstract|implicit|lazy|final)\s+)*def\s+(\w+)/);
			if (defMatch) {
				const block = this.findBlock(cleaned, i);
				nodes.push({ kind: "function", name: defMatch[1], line: i + 1, endLine: block.endLine, detail: trimmed.slice(0, 80), children: [] });
				i = block.endIdx + 1; continue;
			}

			// val / var (top-level)
			const valMatch = trimmed.match(/^(?:(?:private|protected|override|implicit|lazy|final)\s+)*(?:val|var)\s+(\w+)/);
			if (valMatch) {
				nodes.push({ kind: "const", name: valMatch[1], line: i + 1, endLine: i + 1, detail: trimmed.slice(0, 60), children: [] });
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
