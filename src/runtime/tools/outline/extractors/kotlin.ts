import { OutlineNode, LangExtractor } from "../types.js";

/**
 * Kotlin extractor.
 * Extracts: package, import, class, interface, object, fun, val (top-level).
 */
export class KotlinExtractor implements LangExtractor {
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

			// package
			if (/^package\s+/.test(trimmed)) {
				const name = trimmed.replace(/^package\s+/, "");
				nodes.push({ kind: "package", name, line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// import
			if (/^import\s+/.test(trimmed)) {
				const name = trimmed.replace(/^import\s+/, "").split(".").pop() || "";
				nodes.push({ kind: "import", name, line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// class / interface / object / enum class / annotation class
			const typeMatch = trimmed.match(/^(?:(?:public|private|protected|internal|abstract|open|sealed|data|inner|companion|inline|value)\s+)*(?:class|interface|object)\s+(\w+)/);
			if (typeMatch) {
				const kind = trimmed.includes("interface") ? "interface" : trimmed.match(/\bobject\b/) ? "object" : "class";
				const name = typeMatch[1];
				const block = this.findBlock(cleaned, i);
				nodes.push({ kind, name, line: i + 1, endLine: block.endLine, detail: trimmed.slice(0, 80), children: [] });
				i = block.endIdx + 1; continue;
			}

			// fun
			const fnMatch = trimmed.match(/^(?:(?:public|private|protected|internal|override|abstract|open|suspend|inline|tailrec|infix|operator|infix)\s+)*fun\s+(?:<[^>]+>\s+)?(\w+)/);
			if (fnMatch) {
				const block = this.findBlock(cleaned, i);
				nodes.push({ kind: "function", name: fnMatch[1], line: i + 1, endLine: block.endLine, detail: trimmed.slice(0, 80), children: [] });
				i = block.endIdx + 1; continue;
			}

			// val / var (top-level)
			const valMatch = trimmed.match(/^(?:(?:public|private|protected|internal|const|lateinit|override)\s+)*(?:val|var)\s+(\w+)/);
			if (valMatch) {
				nodes.push({ kind: "property", name: valMatch[1], line: i + 1, endLine: i + 1, detail: trimmed.slice(0, 60), children: [] });
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
