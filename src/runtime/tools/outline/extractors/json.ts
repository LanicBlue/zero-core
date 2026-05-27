import { OutlineNode, LangExtractor } from "../types.js";

export class JsonExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		try {
			const parsed = JSON.parse(source);
			const lines = source.split("\n");
			return this.extractValue(parsed, source, lines, 1, lines.length);
		} catch {
			// Fallback: key-level parsing
			return this.fallbackExtract(source);
		}
	}

	private extractValue(value: unknown, source: string, lines: string[], startLine: number, endLine: number): OutlineNode[] {
		if (Array.isArray(value)) {
			return this.extractArray(value, source, lines, startLine, endLine);
		}
		if (value !== null && typeof value === "object") {
			return this.extractObject(value as Record<string, unknown>, source, lines, startLine, endLine);
		}
		return [];
	}

	private extractObject(obj: Record<string, unknown>, source: string, lines: string[], startLine: number, endLine: number): OutlineNode[] {
		const nodes: OutlineNode[] = [];
		const keys = Object.keys(obj);

		for (const key of keys) {
			const val = obj[key];
			const location = this.findKeyLocation(source, key, startLine, endLine);
			const valEnd = this.findValueEnd(source, key, location, endLine, val);

			let detail: string | undefined;
			let children: OutlineNode[] = [];

			if (typeof val === "string") {
				detail = `"${val.length > 40 ? val.slice(0, 37) + "..." : val}"`;
			} else if (typeof val === "number" || typeof val === "boolean") {
				detail = String(val);
			} else if (val === null) {
				detail = "null";
			} else if (Array.isArray(val)) {
				detail = `[${val.length} items]`;
				if (val.length > 0 && (typeof val[0] === "object" && val[0] !== null)) {
					children = this.extractArray(val, source, lines, location, valEnd);
				}
			} else if (typeof val === "object") {
				detail = `{${Object.keys(val as object).length} keys}`;
				children = this.extractObject(val as Record<string, unknown>, source, lines, location, valEnd);
			}

			nodes.push({
				kind: "property",
				name: key,
				line: location,
				endLine: valEnd,
				detail,
				children,
			});
		}

		return nodes;
	}

	private extractArray(arr: unknown[], source: string, lines: string[], startLine: number, endLine: number): OutlineNode[] {
		const nodes: OutlineNode[] = [];
		for (let idx = 0; idx < arr.length; idx++) {
			const val = arr[idx];
			const location = this.findArrayItemLocation(source, idx, startLine, endLine);
			const valEnd = location; // simplified

			if (typeof val === "object" && val !== null) {
				if (Array.isArray(val)) {
					nodes.push({
						kind: "array",
						name: `[${idx}]`,
						line: location,
						endLine: valEnd,
						detail: `[${val.length} items]`,
						children: this.extractArray(val, source, lines, location, valEnd),
					});
				} else {
					const obj = val as Record<string, unknown>;
					nodes.push({
						kind: "object",
						name: `[${idx}]`,
						line: location,
						endLine: valEnd,
						detail: `{${Object.keys(obj).length} keys}`,
						children: this.extractObject(obj, source, lines, location, valEnd),
					});
				}
			} else {
				let detail: string | undefined;
				if (typeof val === "string") detail = `"${val.length > 40 ? val.slice(0, 37) + "..." : val}"`;
				else if (val === null) detail = "null";
				else detail = String(val);

				nodes.push({
					kind: "value",
					name: `[${idx}]`,
					line: location,
					endLine: valEnd,
					detail,
					children: [],
				});
			}
		}
		return nodes;
	}

	private findKeyLocation(source: string, key: string, startLine: number, endLine: number): number {
		const lines = source.split("\n");
		const searchKey = `"${key}"`;
		for (let i = startLine - 1; i < Math.min(endLine, lines.length); i++) {
			if (lines[i].includes(searchKey)) return i + 1;
		}
		return startLine;
	}

	private findValueEnd(source: string, key: string, keyLine: number, maxEnd: number, val: unknown): number {
		if (typeof val === "object" && val !== null) {
			// For objects/arrays, scan from key line for matching brace/bracket
			const lines = source.split("\n");
			const openCh = Array.isArray(val) ? "[" : "{";
			const closeCh = Array.isArray(val) ? "]" : "}";
			let depth = 0;
			let foundOpen = false;
			for (let i = keyLine - 1; i < Math.min(maxEnd, lines.length); i++) {
				for (const ch of lines[i]) {
					if (ch === openCh) { depth++; foundOpen = true; }
					if (ch === closeCh) depth--;
				}
				if (foundOpen && depth <= 0) return i + 1;
			}
		}
		return keyLine;
	}

	private findArrayItemLocation(source: string, idx: number, startLine: number, endLine: number): number {
		// Simplified: just return a reasonable line
		const lines = source.split("\n");
		let count = -1;
		for (let i = startLine - 1; i < Math.min(endLine, lines.length); i++) {
			const trimmed = lines[i].trim();
			if (trimmed === "[" || trimmed === "{" || trimmed === "," || trimmed === "]" || trimmed === "}") continue;
			if (!trimmed.startsWith("//") && !trimmed.startsWith("#")) {
				count++;
				if (count === idx) return i + 1;
			}
		}
		return startLine;
	}

	private fallbackExtract(source: string): OutlineNode[] {
		const lines = source.split("\n");
		const nodes: OutlineNode[] = [];
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || trimmed === "{" || trimmed === "}" || trimmed === "[" || trimmed === "]" || trimmed === ",") continue;
			if (trimmed.startsWith('"') && trimmed.includes(":")) {
				const keyMatch = trimmed.match(/^"([^"]+)"\s*:/);
				if (keyMatch) {
					const val = trimmed.slice(trimmed.indexOf(":") + 1).trim().replace(/,$/, "");
					nodes.push({
						kind: "property",
						name: keyMatch[1],
						line: i + 1,
						endLine: i + 1,
						detail: val.length > 60 ? val.slice(0, 57) + "..." : val,
						children: [],
					});
				}
			}
		}
		return nodes;
	}
}
