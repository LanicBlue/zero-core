import { OutlineNode, LangExtractor } from "../types.js";

/**
 * Lua extractor.
 * Extracts: require, function, local function.
 */
export class LuaExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];
		let i = 0;

		while (i < lines.length) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed.startsWith("--")) { i++; continue; }

			// require
			const reqMatch = trimmed.match(/local\s+(\w+)\s*=\s*require/);
			if (reqMatch) {
				nodes.push({ kind: "import", name: reqMatch[1], line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// function
			const fnMatch = trimmed.match(/^function\s+(\w+(?:\.\w+)*)/);
			if (fnMatch) {
				const name = fnMatch[1];
				const endLine = this.findEnd(lines, i);
				nodes.push({ kind: "function", name, line: i + 1, endLine, detail: trimmed, children: [] });
				i = endLine; continue;
			}

			// local function
			const localFnMatch = trimmed.match(/^local\s+function\s+(\w+)/);
			if (localFnMatch) {
				const name = localFnMatch[1];
				const endLine = this.findEnd(lines, i);
				nodes.push({ kind: "function", name, line: i + 1, endLine, detail: trimmed, children: [] });
				i = endLine; continue;
			}

			i++;
		}

		return nodes;
	}

	private findEnd(lines: string[], startIdx: number): number {
		for (let i = startIdx; i < lines.length; i++) {
			if (lines[i].trim() === "end") return i + 1;
		}
		return lines.length;
	}
}
