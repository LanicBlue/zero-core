import { OutlineNode, LangExtractor } from "../types.js";

/**
 * PHP extractor.
 * Extracts: namespace, use, class, function, interface, trait, const.
 */
export class PhpExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		// Strip PHP comments (C-style + #)
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
			// Strip // and # comments
			let stripped = line;
			const singleComment = line.search(/\/\/|#(?!\[)/);
			if (singleComment >= 0) stripped = line.slice(0, singleComment);
			cleaned.push(stripped);
		}

		const result: OutlineNode[] = [];
		let i = 0;
		while (i < cleaned.length) {
			const trimmed = cleaned[i].trim();
			if (!trimmed || trimmed === "<?php" || trimmed === "?>") { i++; continue; }

			// namespace
			const nsMatch = trimmed.match(/^namespace\s+([\w\\]+);/);
			if (nsMatch) {
				result.push({ kind: "namespace", name: nsMatch[1], line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// use
			const useMatch = trimmed.match(/^use\s+([\w\\]+)/);
			if (useMatch) {
				const parts = useMatch[1].split("\\");
				result.push({ kind: "import", name: parts[parts.length - 1], line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// class / interface / trait
			const typeMatch = trimmed.match(/^(?:(?:abstract|final)\s+)?(?:class|interface|trait)\s+(\w+)/);
			if (typeMatch) {
				const name = typeMatch[1];
				const kind = trimmed.includes("interface") ? "interface" : trimmed.includes("trait") ? "trait" : "class";
				const block = this.findBlock(cleaned, i);
				result.push({ kind, name, line: i + 1, endLine: block.endLine, detail: trimmed.slice(0, 80), children: [] });
				i = block.endIdx + 1; continue;
			}

			// function
			const fnMatch = trimmed.match(/^function\s+(\w+)/);
			if (fnMatch) {
				const block = this.findBlock(cleaned, i);
				result.push({ kind: "function", name: fnMatch[1], line: i + 1, endLine: block.endLine, detail: trimmed.slice(0, 80), children: [] });
				i = block.endIdx + 1; continue;
			}

			// const
			const constMatch = trimmed.match(/^const\s+(\w+)/);
			if (constMatch) {
				result.push({ kind: "const", name: constMatch[1], line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			i++;
		}

		return result;
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
