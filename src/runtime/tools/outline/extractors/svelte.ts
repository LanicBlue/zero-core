import { OutlineNode, LangExtractor } from "../types.js";

/**
 * Svelte extractor.
 * Extracts: <script>, <style>, and top-level markup elements.
 */
export class SvelteExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];

		let i = 0;
		while (i < lines.length) {
			const trimmed = lines[i].trim();
			if (!trimmed) { i++; continue; }

			// <script> or <style> block
			const blockMatch = trimmed.match(/^<(script|style)(?:\s[^>]*)?>/i);
			if (blockMatch) {
				const name = blockMatch[1].toLowerCase();
				const startLine = i + 1;
				const endRe = new RegExp(`^<\\/${name}>$`, "i");
				let endLine = lines.length;
				for (let j = i + 1; j < lines.length; j++) {
					if (endRe.test(lines[j].trim())) {
						endLine = j + 1;
						break;
					}
				}
				nodes.push({ kind: "section", name, line: startLine, endLine, detail: `<${name}>`, children: [] });
				i = endLine; continue;
			}

			// Svelte control flow
			if (/^\{#(if|each|await|key)\s/.test(trimmed)) {
				const name = trimmed.replace(/^\{#/, "").split(/\s/)[0];
				const endLine = this.findSvelteBlockEnd(lines, i, name);
				nodes.push({ kind: "block", name: `#{name}`, line: i + 1, endLine, detail: trimmed.slice(0, 60), children: [] });
				i = endLine; continue;
			}

			i++;
		}

		return nodes;
	}

	private findSvelteBlockEnd(lines: string[], start: number, blockType: string): number {
		let depth = 1;
		for (let i = start + 1; i < lines.length; i++) {
			const t = lines[i].trim();
			if (t.match(new RegExp(`^\\{/#${blockType}`))) { depth--; if (depth <= 0) return i + 1; }
			if (t.match(new RegExp(`^\\{#${blockType}`))) depth++;
		}
		return lines.length;
	}
}
