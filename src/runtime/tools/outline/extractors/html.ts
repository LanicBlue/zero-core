import { OutlineNode, LangExtractor } from "../types.js";

/**
 * HTML/XML/SVG extractor.
 * Extracts: tag hierarchy tree, with attributes folded.
 */
export class HtmlExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];

		// Self-closing and void tags
		const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
		// Tags to skip (inline, no children worth showing)
		const skipTags = new Set(["script", "style", "title", "meta", "link", "br", "hr", "b", "i", "em", "strong", "span", "a"]);

		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			const trimmed = line.trim();
			if (!trimmed) { i++; continue; }

			// Match opening tag
			const tagMatch = trimmed.match(/^<(\w[\w-]*)([^>]*?)(\/?)>/);
			if (!tagMatch || trimmed.startsWith("</") || trimmed.startsWith("<!") || trimmed.startsWith("<?")) { i++; continue; }

			const tagName = tagMatch[1].toLowerCase();
			const attrs = tagMatch[2].trim();
			const selfClose = tagMatch[3] === "/" || voidTags.has(tagName);

			const start = i + 1;

			// Build detail: show id/class if present
			let detail = `<${tagMatch[1]}`;
			if (attrs) {
				const idMatch = attrs.match(/id\s*=\s*["']([^"']+)["']/);
				const classMatch = attrs.match(/class\s*=\s*["']([^"']+)["']/);
				if (idMatch) detail += ` #${idMatch[1]}`;
				if (classMatch) detail += ` .${classMatch[1].split(/\s+/).join(".")}`;
				if (!idMatch && !classMatch && attrs.length > 30) detail += ` ...`;
				else if (!idMatch && !classMatch) detail += ` ${attrs}`;
			}
			detail += ">";

			if (selfClose || skipTags.has(tagName)) {
				nodes.push({ kind: "tag", name: tagMatch[1], line: start, endLine: start, detail, children: [] });
				i++; continue;
			}

			// Find closing tag
			const endLine = this.findClosingTag(lines, i, tagName);
			nodes.push({
				kind: "tag",
				name: tagMatch[1],
				line: start,
				endLine,
				detail,
				children: [],
			});
			i++; continue;
		}

		return nodes;
	}

	private findClosingTag(lines: string[], startIdx: number, tagName: string): number {
		let depth = 0;
		for (let i = startIdx; i < lines.length; i++) {
			const line = lines[i];
			// Count opening and closing tags for this tagName
			const openRe = new RegExp(`<${tagName}[\\s>]`, "gi");
			const closeRe = new RegExp(`</${tagName}\\s*>`, "gi");
			const selfCloseRe = new RegExp(`<${tagName}[^>]*/>`, "gi");

			for (const m of line.matchAll(openRe)) depth++;
			for (const m of line.matchAll(selfCloseRe)) depth--;
			for (const m of line.matchAll(closeRe)) {
				depth--;
				if (depth <= 0) return i + 1;
			}
		}
		return lines.length;
	}
}
