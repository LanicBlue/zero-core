import { OutlineNode, LangExtractor } from "../types.js";

/**
 * YAML extractor.
 * Extracts: key hierarchy with values, anchors.
 */
export class YamlExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		return this.parseBlock(lines, 0, lines.length, -1);
	}

	private parseBlock(lines: string[], start: number, end: number, parentIndent: number): OutlineNode[] {
		const nodes: OutlineNode[] = [];
		let i = start;

		while (i < end) {
			const line = lines[i];
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---") || trimmed.startsWith("...")) { i++; continue; }

			const indent = this.getIndent(line);
			if (indent <= parentIndent && parentIndent >= 0) break;

			// Key: value or key:
			const keyMatch = trimmed.match(/^(&[\w-]+\s+)?([\w][\w.-]*)\s*:(.*)$/);
			if (keyMatch) {
				const name = keyMatch[2];
				const value = keyMatch[3].trim();
				const lineNum = i + 1;

				// Check if it's a block mapping (next lines are more indented)
				const childEnd = this.findBlockEnd(lines, i + 1, end, indent);
				let children: OutlineNode[] = [];
				let detail: string | undefined;
				let endLine = lineNum;

				if (childEnd > i + 1) {
					children = this.parseBlock(lines, i + 1, childEnd, indent);
					endLine = childEnd;
				} else if (value) {
					detail = value.length > 60 ? value.slice(0, 57) + "..." : value;
				} else {
					detail = "{}";
				}

				// Check for array items on next lines
				if (!children.length && i + 1 < end) {
					const nextTrimmed = lines[i + 1].trim();
					if (nextTrimmed.startsWith("- ")) {
						// Collect array items
						let arrEnd = i + 1;
						while (arrEnd < end && lines[arrEnd].trim().startsWith("- ")) arrEnd++;
						endLine = arrEnd;
						detail = `[${arrEnd - i - 1} items]`;
					}
				}

				nodes.push({ kind: "key", name, line: lineNum, endLine, detail, children });
				i = endLine; continue;
			}

			// List item
			if (trimmed.startsWith("- ")) {
				const name = trimmed.slice(2).trim().slice(0, 60);
				nodes.push({ kind: "item", name, line: i + 1, endLine: i + 1, detail: name, children: [] });
				i++; continue;
			}

			i++;
		}

		return nodes;
	}

	private findBlockEnd(lines: string[], start: number, parentEnd: number, parentIndent: number): number {
		for (let i = start; i < parentEnd; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
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
