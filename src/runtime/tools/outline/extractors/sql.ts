import { OutlineNode, LangExtractor } from "../types.js";

/**
 * SQL extractor.
 * Extracts: CREATE TABLE/VIEW/INDEX/FUNCTION/PROCEDURE/TRIGGER, top-level SELECT.
 */
export class SqlExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed.startsWith("--")) continue;

			// CREATE statements
			const createMatch = trimmed.match(/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER|SCHEMA|DATABASE|TYPE|ENUM|SEQUENCE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
			if (createMatch) {
				const kind = createMatch[1].toUpperCase();
				const name = createMatch[2];
				const endLine = this.findEnd(lines, i);
				nodes.push({ kind, name, line: i + 1, endLine, detail: trimmed.slice(0, 80), children: [] });
				continue;
			}

			// ALTER
			const alterMatch = trimmed.match(/^ALTER\s+TABLE\s+(\w+)/i);
			if (alterMatch) {
				nodes.push({ kind: "ALTER", name: alterMatch[1], line: i + 1, endLine: i + 1, detail: trimmed.slice(0, 80), children: [] });
				continue;
			}

			// INSERT / SELECT / UPDATE / DELETE (top-level)
			const dmlMatch = trimmed.match(/^(SELECT|INSERT|UPDATE|DELETE)\b/i);
			if (dmlMatch && !trimmed.startsWith("--")) {
				const endLine = this.findStatementEnd(lines, i);
				nodes.push({ kind: dmlMatch[1].toUpperCase(), name: dmlMatch[1].toLowerCase(), line: i + 1, endLine, detail: trimmed.slice(0, 60), children: [] });
			}
		}

		return nodes;
	}

	private findEnd(lines: string[], startIdx: number): number {
		for (let i = startIdx; i < lines.length; i++) {
			if (lines[i].trim().endsWith(";")) return i + 1;
		}
		return lines.length;
	}

	private findStatementEnd(lines: string[], startIdx: number): number {
		return this.findEnd(lines, startIdx);
	}
}
