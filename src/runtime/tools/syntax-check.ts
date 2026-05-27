import { stripComments, type CommentStyle } from "./outline/stripper.js";

interface Diagnostic {
	line: number;
	message: string;
}

const EXT_STYLE: Record<string, CommentStyle> = {
	ts: "c", tsx: "c", js: "c", jsx: "c", mjs: "c", cjs: "c",
	c: "c", h: "c", cpp: "c", hpp: "c", cc: "c", cxx: "c",
	java: "c", go: "c", rs: "c", swift: "c", kt: "c", kts: "c",
	scala: "c", dart: "c", css: "c", scss: "c", sass: "c", less: "c",
	php: "c",
	py: "hash", pyw: "hash",
	rb: "hash", sh: "hash", bash: "hash", zsh: "hash",
	r: "hash", yaml: "hash", yml: "hash",
	toml: "hash", nim: "hash",
	lua: "dash", sql: "dash",
	html: "html", htm: "html", xml: "html", svg: "html",
	vue: "html", svelte: "html",
};

const BRACKET_PAIRS: Record<string, string> = {
	")": "(", "}": "{", "]": "[",
};
const OPEN_BRACKETS = new Set(["(", "{", "["]);
const CLOSE_BRACKETS = new Set([")", "}", "]"]);

/**
 * Check source code for bracket/quote balance issues.
 * Returns diagnostics (line number + message) if any issues found.
 */
export function checkSyntax(source: string, ext: string): Diagnostic[] {
	const diags: Diagnostic[] = [];

	// Skip non-code formats
	if (!EXT_STYLE[ext] && !["json", "jsonc", "json5", "md", "mdx", "proto", "graphql", "gql", "ex", "exs", "zig", "ini", "cfg", "conf", "env", "properties"].includes(ext)) {
		return diags;
	}

	const style: CommentStyle = EXT_STYLE[ext] ?? "c";
	const cleaned = stripComments(source, style);

	// Bracket balance
	const stack: { ch: string; line: number }[] = [];
	const lines = cleaned.split("\n");

	for (let i = 0; i < lines.length; i++) {
		for (const ch of lines[i]) {
			if (OPEN_BRACKETS.has(ch)) {
				stack.push({ ch, line: i + 1 });
			} else if (CLOSE_BRACKETS.has(ch)) {
				const expected = BRACKET_PAIRS[ch];
				if (!stack.length) {
					diags.push({ line: i + 1, message: `unexpected '${ch}' without matching '${expected}'` });
				} else {
					const top = stack.pop()!;
					if (top.ch !== expected) {
						diags.push({ line: i + 1, message: `'${ch}' mismatches '${top.ch}' opened at line ${top.line}` });
					}
				}
			}
		}
	}

	for (const s of stack) {
		const close = { "(": ")", "{": "}", "[": "]" }[s.ch];
		diags.push({ line: s.line, message: `unmatched '${s.ch}' — missing '${close}'` });
	}

	// Unterminated string check (for C-style languages with multi-line strings)
	if (style === "c") {
		checkUnterminatedStrings(source, diags);
	}

	return diags;
}

function checkUnterminatedStrings(source: string, diags: Diagnostic[]) {
	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		let inString: string | null = null;
		let j = 0;

		// Skip comment-only lines
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("<!--")) continue;

		while (j < line.length) {
			const ch = line[j];

			if (inString) {
				if (ch === "\\") { j += 2; continue; }
				if (ch === inString) { inString = null; j++; continue; }
				j++; continue;
			}

			if (ch === '"' || ch === "'" || ch === "`") {
				inString = ch;
				j++;
				continue;
			}

			// Stop at comment start
			if (line.slice(j, j + 2) === "//") break;

			j++;
		}

		if (inString && inString !== "`") {
			diags.push({ line: i + 1, message: `possible unterminated ${inString} string` });
		}
	}
}

export function formatDiagnostics(path: string, diags: Diagnostic[]): string {
	if (!diags.length) return "";
	const lines = diags.slice(0, 10).map(d => `  L${d.line}: ${d.message}`);
	const suffix = diags.length > 10 ? `\n  ... and ${diags.length - 10} more` : "";
	return `\n\n⚠ Syntax warnings in ${path}:\n${lines.join("\n")}${suffix}\nPlease verify the file structure is correct.`;
}
