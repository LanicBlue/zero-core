import { OutlineNode, LangExtractor } from "../types.js";

export class MarkdownExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		return this.parseHeadings(lines, 0, lines.length, 0);
	}

	private parseHeadings(lines: string[], start: number, end: number, minLevel: number): OutlineNode[] {
		const nodes: OutlineNode[] = [];
		let i = start;
		let lastHeadingIdx = -1;

		while (i < end) {
			const line = lines[i];
			const match = line.match(/^(#{1,6})\s+(.+)$/);
			if (match) {
				const level = match[1].length;
				if (level <= minLevel) { i++; continue; }

				// Close previous heading at the same or lower level
				if (lastHeadingIdx >= 0) {
					const prev = nodes[lastHeadingIdx];
					prev.endLine = i;
					// Extract children for previous heading
					if (prev.line < i) {
						prev.children = this.parseHeadings(lines, prev.line, i, prev.kind === "heading" ? parseInt(prev.detail || "0") || minLevel : minLevel);
					}
				}

				const name = match[2].trim();
				nodes.push({
					kind: "heading",
					name,
					line: i + 1,
					endLine: end,
					detail: String(level),
					children: [],
				});
				lastHeadingIdx = nodes.length - 1;
			}

			// Detect fenced code blocks
			if (line.trimStart().startsWith("```")) {
				const lang = line.trim().slice(3).trim();
				const codeStart = i + 1;
				i++;
				while (i < end && !lines[i].trimStart().startsWith("```")) i++;
				// Add as a child of the current heading later — for now just note it
				// We'll include code blocks as standalone nodes at the current level
				i++; continue;
			}

			i++;
		}

		// Close last heading
		if (lastHeadingIdx >= 0) {
			const prev = nodes[lastHeadingIdx];
			prev.endLine = end;
			if (prev.line < end) {
				const headingLevel = parseInt(prev.detail || "0") || 1;
				prev.children = this.parseHeadings(lines, prev.line, end, headingLevel);
			}
		}

		return nodes;
	}
}
