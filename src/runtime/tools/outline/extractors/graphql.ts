import { OutlineNode, LangExtractor } from "../types.js";

/**
 * GraphQL extractor.
 * Extracts: type, input, enum, interface, union, schema, query, mutation, subscription, fragment.
 */
export class GraphqlExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];
		let i = 0;

		while (i < lines.length) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith('"')) { i++; continue; }

			// type / input / interface / scalar / directive
			const typeMatch = trimmed.match(/^(type|input|interface|scalar|directive)\s+(\w+)/);
			if (typeMatch) {
				const kind = typeMatch[1];
				const name = typeMatch[2];
				const block = this.findBlock(lines, i);
				nodes.push({ kind, name, line: i + 1, endLine: block.endLine, detail: trimmed.slice(0, 80), children: [] });
				i = block.endIdx + 1; continue;
			}

			// enum
			const enumMatch = trimmed.match(/^enum\s+(\w+)/);
			if (enumMatch) {
				const block = this.findBlock(lines, i);
				nodes.push({ kind: "enum", name: enumMatch[1], line: i + 1, endLine: block.endLine, detail: trimmed, children: [] });
				i = block.endIdx + 1; continue;
			}

			// union
			const unionMatch = trimmed.match(/^union\s+(\w+)/);
			if (unionMatch) {
				nodes.push({ kind: "union", name: unionMatch[1], line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// schema
			if (/^schema\s*\{?/.test(trimmed)) {
				const block = this.findBlock(lines, i);
				nodes.push({ kind: "schema", name: "schema", line: i + 1, endLine: block.endLine, detail: trimmed, children: [] });
				i = block.endIdx + 1; continue;
			}

			// Query / Mutation / Subscription (extend type)
			const extendMatch = trimmed.match(/^extend\s+type\s+(\w+)/);
			if (extendMatch) {
				const block = this.findBlock(lines, i);
				nodes.push({ kind: "extend", name: extendMatch[1], line: i + 1, endLine: block.endLine, detail: trimmed, children: [] });
				i = block.endIdx + 1; continue;
			}

			i++;
		}

		return nodes;
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
