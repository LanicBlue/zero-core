import { OutlineNode, LangExtractor } from "../types.js";

/**
 * INI / Config / dotenv / Properties extractor.
 * Extracts: sections + key-value pairs.
 */
export class IniExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";") || trimmed.startsWith("//")) continue;

			// Section: [name]
			const secMatch = trimmed.match(/^\[([^\]]+)\]/);
			if (secMatch) {
				const endLine = this.findSectionEnd(lines, i + 1);
				nodes.push({ kind: "section", name: secMatch[1], line: i + 1, endLine, detail: "", children: [] });
				continue;
			}

			// Key = Value or Key: Value
			const kvMatch = trimmed.match(/^([\w.-]+)\s*[=:]\s*(.*)/);
			if (kvMatch) {
				const name = kvMatch[1];
				const value = kvMatch[2].trim();
				nodes.push({ kind: "key", name, line: i + 1, endLine: i + 1, detail: value.length > 60 ? value.slice(0, 57) + "..." : value, children: [] });
			}
		}

		return nodes;
	}

	private findSectionEnd(lines: string[], start: number): number {
		for (let i = start; i < lines.length; i++) {
			if (/^\[([^\]]+)\]/.test(lines[i].trim())) return i;
		}
		return lines.length;
	}
}
