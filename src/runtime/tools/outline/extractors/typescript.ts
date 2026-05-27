import { OutlineNode, LangExtractor } from "../types.js";
import { stripComments } from "../stripper.js";

export class TypeScriptExtractor implements LangExtractor {
	extract(source: string): OutlineNode[] {
		const cleaned = stripComments(source, "c");
		const origLines = source.split("\n");
		const lines = cleaned.split("\n");
		const nodes: OutlineNode[] = [];

		let i = 0;
		while (i < lines.length) {
			const trimmed = lines[i].trim();
			if (!trimmed) { i++; continue; }

			// Import
			if (/^import\s/.test(trimmed)) {
				const start = i + 1;
				while (i < lines.length - 1 && !lines[i].includes(";") && !lines[i].includes("}")) i++;
				const detail = origLines.slice(start - 1, i + 1).join(" ").replace(/\s+/g, " ").trim();
				const fromMatch = detail.match(/from\s+['"]([^'"]+)['"]/);
				const name = fromMatch ? fromMatch[1] : detail.replace(/^import\s+/, "").slice(0, 40);
				nodes.push({ kind: "import", name, line: start, endLine: i + 1, detail, children: [] });
				i++; continue;
			}

			// Top-level declaration
			const node = this.tryParseDecl(lines, origLines, i);
			if (node) {
				nodes.push(node);
				i = node.endLine;
				continue;
			}

			i++;
		}

		return nodes;
	}

	private tryParseDecl(lines: string[], origLines: string[], idx: number): OutlineNode | null {
		const trimmed = lines[idx].trim();
		const bare = trimmed.replace(/^export\s+(?:default\s+)?/, "");
		const origDetail = this.summary(origLines[idx].trim());

		// class / interface / type / enum
		const cm = bare.match(/^(?:(?:abstract|declare)\s+)*(class|interface|type|enum)\s+(\w+)/);
		if (cm) {
			const block = this.findBlock(lines, idx);
			const children = (cm[1] === "class" || cm[1] === "interface")
				? this.extractMembers(lines, origLines, idx, block.endIdx)
				: [];
			return { kind: cm[1], name: cm[2], line: idx + 1, endLine: block.endLine, detail: origDetail, children };
		}

		// function
		const fm = bare.match(/^(?:(?:async|generator)\s+)*function\s*\*?\s+(\w+)/);
		if (fm) {
			const block = this.findBlock(lines, idx);
			return { kind: "function", name: fm[1], line: idx + 1, endLine: block.endLine, detail: origDetail, children: [] };
		}

		// arrow function
		const am = bare.match(/^(?:const|let|var)\s+(\w+).*=>/);
		if (am) {
			const block = this.findBlock(lines, idx);
			return { kind: "function", name: am[1], line: idx + 1, endLine: block.endLine, detail: origDetail, children: [] };
		}

		// const/let/var
		const vm = bare.match(/^(?:const|let|var)\s+(\w+)/);
		if (vm) {
			const block = this.findBlock(lines, idx);
			return { kind: "const", name: vm[1], line: idx + 1, endLine: block.endLine, detail: origDetail, children: [] };
		}

		return null;
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
		return { endIdx: lines.length - 1, endLine: lines.length };
	}

	/**
	 * Extract class/interface members by tracking brace depth incrementally.
	 * Members are declarations at depth 1 (directly inside the class body).
	 */
	private extractMembers(lines: string[], origLines: string[], classIdx: number, classEndIdx: number): OutlineNode[] {
		const members: OutlineNode[] = [];

		// Scan from class opening line, tracking depth incrementally
		let depth = 0;
		let foundClassOpen = false;
		let methodStartIdx = -1;
		let methodStartDepth = 0;

		for (let i = classIdx; i <= classEndIdx; i++) {
			const trimmed = lines[i].trim();

			// Save depth BEFORE processing braces — method declaration "async run(...) {"
			// has depthBefore=1 (class body) but depth=2 after processing its opening brace.
			const depthBefore = depth;

			for (const ch of lines[i]) {
				if (ch === "{") {
					if (!foundClassOpen) foundClassOpen = true;
					depth++;
				}
				if (ch === "}") depth--;
			}

			// Skip empty/comment lines
			if (!trimmed || trimmed === "{" || trimmed === "}" || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

			// Only process declarations at class body level
			if (depthBefore !== 1) continue;

			// Property (no opening paren, has = or ; or :)
			const propMatch = trimmed.match(/^(?:(?:public|private|protected|static|readonly|abstract|override|declare)\s+)*(\w+)(?:\??)\s*[=;]/);
			if (propMatch && !trimmed.includes("(")) {
				members.push({
					kind: "property",
					name: propMatch[1],
					line: i + 1,
					endLine: i + 1,
					detail: this.summary(origLines[i].trim()),
					children: [],
				});
				continue;
			}

			// Method or constructor
			const ctorMatch = trimmed.match(/^(?:(?:public|private|protected)\s+)*constructor\s*[<(]/);
			const methodMatch = trimmed.match(/^(?:(?:public|private|protected|static|async|readonly|abstract|override|set|get|declare)\s+)*(?:async\s+)?(\w+)\s*[<(]/);

			if (ctorMatch) {
				const block = this.findBlock(lines, i);
				members.push({
					kind: "method",
					name: "constructor",
					line: i + 1,
					endLine: Math.min(block.endLine, classEndIdx + 1),
					detail: this.summary(origLines[i].trim()),
					children: [],
				});
				// Skip to end of constructor
				// Re-adjust depth by scanning forward
				depth = 0;
				for (let j = classIdx; j <= block.endIdx; j++) {
					for (const ch of lines[j]) {
						if (ch === "{") depth++;
						if (ch === "}") depth--;
					}
				}
				i = block.endIdx;
				continue;
			}

			if (methodMatch && !this.isKeyword(trimmed)) {
				const block = this.findBlock(lines, i);
				members.push({
					kind: "method",
					name: methodMatch[1],
					line: i + 1,
					endLine: Math.min(block.endLine, classEndIdx + 1),
					detail: this.summary(origLines[i].trim()),
					children: [],
				});
				// Skip to end of method body
				depth = 0;
				for (let j = classIdx; j <= block.endIdx; j++) {
					for (const ch of lines[j]) {
						if (ch === "{") depth++;
						if (ch === "}") depth--;
					}
				}
				i = block.endIdx;
				continue;
			}
		}

		return members;
	}

	private isKeyword(trimmed: string): boolean {
		return /^(if|for|while|switch|return|throw|new|else|try|catch|finally|case|break|continue|do)\b/.test(trimmed);
	}

	private summary(text: string): string {
		const s = text.replace(/\s+/g, " ").trim();
		return s.length > 90 ? s.slice(0, 87) + "..." : s;
	}
}
