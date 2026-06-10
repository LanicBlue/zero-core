// 语法检查工具
//
// # 文件说明书
//
// ## 核心功能
// 提供代码语法检查能力，检测常见语法错误。
//
// ## 输入
// - 文件扩展名
// - 文件内容
//
// ## 输出
// - 诊断结果
//
// ## 定位
// Runtime 工具函数，被文件工具使用。
//
// ## 依赖
// - ./outline/stripper - 注释剥离
//
// ## 维护规则
// - 新增语言支持时需更新
// - 保持检查规则准确
//
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

	// Bracket balance — string-aware to avoid false positives
	const stack: { ch: string; line: number }[] = [];

	for (let i = 0; i < cleaned.length; i++) {
		const ch = cleaned[i];

		// Skip string literals
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			i++;
			while (i < cleaned.length) {
				if (cleaned[i] === "\\") { i += 2; continue; }
				if (cleaned[i] === quote) break;
				// Template literal expressions: skip ${...}
				if (quote === "`" && cleaned[i] === "$" && cleaned[i + 1] === "{") {
					i += 2;
					let depth = 1;
					while (i < cleaned.length && depth > 0) {
						if (cleaned[i] === "{") depth++;
						else if (cleaned[i] === "}") depth--;
						i++;
					}
					continue;
				}
				i++;
			}
			continue;
		}

		if (OPEN_BRACKETS.has(ch)) {
			// Find line number
			const line = (cleaned.substring(0, i).match(/\n/g) ?? []).length + 1;
			stack.push({ ch, line });
		} else if (CLOSE_BRACKETS.has(ch)) {
			const line = (cleaned.substring(0, i).match(/\n/g) ?? []).length + 1;
			const expected = BRACKET_PAIRS[ch];
			if (!stack.length) {
				diags.push({ line, message: `unexpected '${ch}' without matching '${expected}'` });
			} else {
				const top = stack.pop()!;
				if (top.ch !== expected) {
					diags.push({ line, message: `'${ch}' mismatches '${top.ch}' opened at line ${top.line}` });
				}
			}
		}
	}

	for (const s of stack) {
		const close = { "(": ")", "{": "}", "[": "]" }[s.ch];
		diags.push({ line: s.line, message: `unmatched '${s.ch}' — missing '${close}'` });
	}

	// Unterminated string check (for C-style languages)
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

		// Skip lines ending with \ (line continuation)
		if (trimmed.endsWith("\\")) continue;

		while (j < line.length) {
			const ch = line[j];

			if (inString) {
				if (ch === "\\") { j += 2; continue; }
				// Template literal expression ${...} — skip nested content
				if (inString === "`" && ch === "$" && line[j + 1] === "{") {
					j += 2;
					let depth = 1;
					while (j < line.length && depth > 0) {
						if (line[j] === "{") depth++;
						else if (line[j] === "}") depth--;
						j++;
					}
					continue;
				}
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

		// Template literals can span multiple lines — don't warn about them
		if (inString && inString !== "`") {
			diags.push({ line: i + 1, message: `possible unterminated ${inString} string` });
		}
	}
}

export function formatDiagnostics(path: string, diags: Diagnostic[]): string {
	if (!diags.length) return "";
	const lines = diags.slice(0, 5).map(d => `  L${d.line}: ${d.message}`);
	const suffix = diags.length > 5 ? `\n  ... and ${diags.length - 5} more` : "";
	return `\n\nSyntax warnings in ${path}:\n${lines.join("\n")}${suffix}\nPlease verify the file structure is correct.`;
}
