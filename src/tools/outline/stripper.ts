// 注释和字符串剥离器
//
// # 文件说明书
//
// ## 核心功能
// 从源代码中剥离注释和字符串字面量，保留行号，防止提取器误匹配
//
// ## 输入
// 源代码文本、CommentStyle（c/hash/html）
//
// ## 输出
// 剥离后的源代码文本（空格替换）
//
// ## 定位
// src/runtime/tools/outline/ — 大纲模块，为各语言提取器提供预处理
//
// ## 依赖
// 无外部依赖
//
// ## 维护规则
// 新增注释风格需更新 CommentStyle 类型和剥离逻辑
//
/**
 * Strip comments and string literals from source code while preserving line numbers.
 * Replaces comment/string content with spaces so regex-based extractors don't match
 * declaration keywords inside comments or strings.
 */

export type CommentStyle =
	| "c"        // /* */ and //
	| "hash"     // #
	| "html"     // <!-- -->
	| "dash"     // --
	;

const LINE_COMMENT_STYLES: Record<string, string> = {
	c: "//",
	hash: "#",
	dash: "--",
};

const BLOCK_COMMENT_PAIRS: Record<string, [string, string]> = {
	c: ["/*", "*/"],
	html: ["<!--", "-->"],
};

export function stripComments(source: string, style: CommentStyle): string {
	const lines = source.split("\n");
	const result: string[] = [];
	let inBlock = false;
	let blockEnd: string | undefined;

	const lineStart = LINE_COMMENT_STYLES[style] ?? "";
	const pair = BLOCK_COMMENT_PAIRS[style];
	const blockStartTok = pair?.[0];
	const blockEndTok = pair?.[1];

	for (const line of lines) {
		if (inBlock) {
			const endIdx = blockEndTok ? line.indexOf(blockEndTok) : -1;
			if (endIdx >= 0) {
				inBlock = false;
				const after = line.slice(endIdx + (blockEndTok?.length ?? 0));
				result.push(" ".repeat(endIdx + (blockEndTok?.length ?? 0)) + after);
			} else {
				result.push(" ".repeat(line.length));
			}
			continue;
		}

		let stripped = "";
		let i = 0;
		while (i < line.length) {
			// Block comment start
			if (blockStartTok && line.slice(i, i + blockStartTok.length) === blockStartTok) {
				inBlock = true;
				blockEnd = blockEndTok;
				const endIdx = line.indexOf(blockEndTok!, i + blockStartTok.length);
				if (endIdx >= 0) {
					inBlock = false;
					stripped += " ".repeat(endIdx + blockEndTok.length - i);
					i = endIdx + blockEndTok.length;
					continue;
				} else {
					stripped += " ".repeat(line.length - i);
					break;
				}
			}

			// Line comment
			if (lineStart && line.slice(i, i + lineStart.length) === lineStart) {
				// For # style, check it's not inside a string or a shebang
				if (style === "hash" && i === 0 && line.startsWith("#!")) {
					stripped += " ".repeat(line.length);
					break;
				}
				stripped += " ".repeat(line.length - i);
				break;
			}

			// String literal — skip content but preserve quotes for structure
			if (line[i] === '"' || line[i] === "'" || line[i] === "`") {
				const quote = line[i];
				stripped += quote;
				i++;
				while (i < line.length && line[i] !== quote) {
					if (line[i] === "\\") {
						stripped += "  ";
						i += 2;
						continue;
					}
					if (quote === "`" && line[i] === "$" && line[i + 1] === "{") {
						// Template literal expression — keep as-is
						stripped += line[i];
						i++;
						continue;
					}
					stripped += " ";
					i++;
				}
				if (i < line.length) {
					stripped += quote;
					i++;
				}
				continue;
			}

			stripped += line[i];
			i++;
		}
		result.push(stripped);
	}

	return result.join("\n");
}
