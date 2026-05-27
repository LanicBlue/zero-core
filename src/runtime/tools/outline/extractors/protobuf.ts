import { OutlineNode, LangExtractor } from "../types.js";

/**
 * Protobuf extractor.
 * Extracts: syntax, package, import, message, enum, service, option.
 */
export class ProtobufExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];
		let i = 0;

		while (i < lines.length) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed.startsWith("//")) { i++; continue; }

			// syntax
			if (/^syntax\s*=/.test(trimmed)) {
				nodes.push({ kind: "syntax", name: trimmed, line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// package
			if (/^package\s+/.test(trimmed)) {
				const name = trimmed.replace(/^package\s+/, "").replace(/;.*/, "");
				nodes.push({ kind: "package", name, line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// import
			if (/^import\s+/.test(trimmed)) {
				const name = trimmed.replace(/^import\s+(?:public\s+|weak\s+)?/, "").replace(/['";]/g, "");
				nodes.push({ kind: "import", name, line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
			}

			// message
			const msgMatch = trimmed.match(/^message\s+(\w+)/);
			if (msgMatch) {
				const name = msgMatch[1];
				const block = this.findBlock(lines, i);
				nodes.push({ kind: "message", name, line: i + 1, endLine: block.endLine, detail: trimmed, children: [] });
				i = block.endIdx + 1; continue;
			}

			// enum
			const enumMatch = trimmed.match(/^enum\s+(\w+)/);
			if (enumMatch) {
				const name = enumMatch[1];
				const block = this.findBlock(lines, i);
				nodes.push({ kind: "enum", name, line: i + 1, endLine: block.endLine, detail: trimmed, children: [] });
				i = block.endIdx + 1; continue;
			}

			// service
			const svcMatch = trimmed.match(/^service\s+(\w+)/);
			if (svcMatch) {
				const name = svcMatch[1];
				const block = this.findBlock(lines, i);
				nodes.push({ kind: "service", name, line: i + 1, endLine: block.endLine, detail: trimmed, children: [] });
				i = block.endIdx + 1; continue;
			}

			// option
			if (/^option\s+/.test(trimmed)) {
				const name = trimmed.replace(/^option\s+/, "").split(/\s*=/)[0];
				nodes.push({ kind: "option", name, line: i + 1, endLine: i + 1, detail: trimmed, children: [] });
				i++; continue;
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
