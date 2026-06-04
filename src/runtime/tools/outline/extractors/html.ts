import { OutlineNode, LangExtractor } from "../types.js";

/**
 * HTML/XML/SVG extractor.
 * Builds a DOM tree with proper parent-child nesting.
 */
export class HtmlExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");

		const voidTags = new Set([
			"area", "base", "br", "col", "embed", "hr", "img",
			"input", "link", "meta", "param", "source", "track", "wbr",
		]);

		// Tags whose content should not be parsed as HTML (CSS/JS blocks)
		const rawContentTags = new Set(["script", "style"]);

		// Inline presentation tags — skip entirely (don't add structural value)
		const inlineTags = new Set([
			"span", "b", "i", "em", "strong", "a", "small", "s", "u",
			"mark", "sub", "sup", "abbr", "cite", "kbd", "q", "samp",
		]);

		interface RawTag {
			tagName: string;
			startLine: number;
			endLine: number;
			detail: string;
			isLeaf: boolean;
		}

		const rawTags: RawTag[] = [];
		let skipUntil = -1; // 1-based; skip lines until this line (exclusive)

		for (let i = 0; i < lines.length; i++) {
			const lineNum = i + 1; // 1-based
			if (lineNum < skipUntil) continue;

			const line = lines[i].trim();
			if (!line) continue;

			// Skip closing tags, comments, doctypes, processing instructions
			if (line.startsWith("</") || line.startsWith("<!") || line.startsWith("<?")) continue;

			// Match opening tag
			const tagMatch = line.match(/^<(\w[\w-]*)([^>]*?)(\/?)>/);
			if (!tagMatch) continue;

			const tagNameLower = tagMatch[1].toLowerCase();
			const attrs = tagMatch[2].trim();

			// Skip inline tags
			if (inlineTags.has(tagNameLower)) continue;

			const isVoid = voidTags.has(tagNameLower);
			const isSelfClose = tagMatch[3] === "/";
			const isRawContent = rawContentTags.has(tagNameLower);

			// Build detail: show id/class
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

			const startLine = lineNum;
			let endLine = lineNum;
			let isLeaf = isVoid || isSelfClose;

			if (isRawContent) {
				endLine = this.findClosingTag(lines, i, tagNameLower);
				const spanLines = endLine - startLine;
				const lang = tagNameLower === "style" ? "CSS" : "JS";
				detail += ` [${spanLines} lines ${lang} — use read offset=${startLine} limit=${spanLines + 1}]`;
				isLeaf = true;
				skipUntil = endLine + 1;
			} else if (!isLeaf) {
				endLine = this.findClosingTag(lines, i, tagNameLower);
			}

			rawTags.push({
				tagName: tagMatch[1],
				startLine,
				endLine,
				detail,
				isLeaf,
			});
		}

		// Build tree using containment stack
		const roots: OutlineNode[] = [];
		const stack: { node: OutlineNode; endLine: number }[] = [];

		for (const tag of rawTags) {
			// Pop ancestors that have closed before this tag starts
			while (stack.length > 0 && stack[stack.length - 1].endLine < tag.startLine) {
				stack.pop();
			}

			const node: OutlineNode = {
				kind: "tag",
				name: tag.tagName,
				line: tag.startLine,
				endLine: tag.endLine,
				detail: tag.detail,
				children: [],
			};

			if (stack.length > 0) {
				stack[stack.length - 1].node.children.push(node);
			} else {
				roots.push(node);
			}

			// Container tags enter the stack so children can nest inside
			if (!tag.isLeaf) {
				stack.push({ node, endLine: tag.endLine });
			}
		}

		return roots;
	}

	private findClosingTag(lines: string[], startIdx: number, tagName: string): number {
		let depth = 0;
		for (let i = startIdx; i < lines.length; i++) {
			const line = lines[i];
			const openRe = new RegExp(`<${tagName}[\\s>]`, "gi");
			const closeRe = new RegExp(`</${tagName}\\s*>`, "gi");
			const selfCloseRe = new RegExp(`<${tagName}[^>]*/>`, "gi");

			for (const m of Array.from(line.matchAll(openRe))) depth++;
			for (const m of Array.from(line.matchAll(selfCloseRe))) depth--;
			for (const m of Array.from(line.matchAll(closeRe))) {
				depth--;
				if (depth <= 0) return i + 1;
			}
		}
		return lines.length;
	}
}
