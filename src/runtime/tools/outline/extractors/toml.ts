import { OutlineNode, LangExtractor } from "../types.js";

/**
 * TOML extractor.
 * Extracts: table hierarchy + key-value pairs.
 */
export class TomlExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			// Table: [name] or [[name]]
			const tableMatch = trimmed.match(/^(\[\[?)([\w.-]+)\]?\]$/);
			if (tableMatch) {
				const isArray = tableMatch[1] === "[[";
				const name = tableMatch[2];
				const endLine = this.findTableEnd(lines, i + 1);
				nodes.push({ kind: "table", name, line: i + 1, endLine, detail: isArray ? "(array)" : "", children: [] });
				continue;
			}

			// Key = Value
			const kvMatch = trimmed.match(/^([\w.-]+)\s*=\s*(.*)/);
			if (kvMatch) {
				const name = kvMatch[1];
				let value = kvMatch[2].trim();
				if (value.length > 60) value = value.slice(0, 57) + "...";
				nodes.push({ kind: "key", name, line: i + 1, endLine: i + 1, detail: value, children: [] });
			}
		}

		return nodes;
	}

	private findTableEnd(lines: string[], start: number): number {
		for (let i = start; i < lines.length; i++) {
			if (/^\[\[?[\w.-]+\]?\]$/.test(lines[i].trim())) return i;
		}
		return lines.length;
	}
}
