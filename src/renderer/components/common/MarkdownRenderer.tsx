// Markdown 渲染器组件
//
// # 文件说明书
//
// ## 核心功能
// 将 Markdown 文本渲染为 HTML，支持 GFM 扩展、代码高亮和原始 HTML
//
// ## 输入
// Markdown 文本、可选 CSS 类名
//
// ## 输出
// 渲染后的 HTML JSX
//
// ## 定位
// src/renderer/components/common/ — 通用组件，为多个页面提供 Markdown 展示
//
// ## 依赖
// React、react-markdown、remark-gfm、rehype-raw、CodeBlock
//
// ## 维护规则
// Markdown 插件升级需确保不破坏现有渲染
//
import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import CodeBlock from "./CodeBlock.js";

interface Props {
	content: string;
	streaming?: boolean;
	className?: string;
}

/**
 * Box-drawing + box-element characters (U+2500–U+257F): ─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼
 * ╭ ╮ ╰ ╯ … These only align in a MONOSPACE font. When the model emits a tree /
 * ASCII-art diagram as plain text (not in a code fence), Markdown renders it as a
 * normal paragraph in the proportional body font → the connectors and spaces
 * don't share column widths → the tree renders jagged/misaligned. detectAsciiArt
 * wraps such runs in a `text` code fence so CodeBlock renders them in <pre>
 * (monospace, whitespace preserved).
 */
const BOX_DRAWING = /[─-╿]/;
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;

/**
 * Wrap runs of box-drawing lines in a `text` code fence. Fence-aware: lines
 * already inside a ``` / ~~~ block pass through untouched (so we never nest
 * fences). Captures the single preceding non-blank line as the tree's root
 * label (e.g. "wiki-root:global") so it stays with its children.
 */
function wrapAsciiArt(md: string): string {
	const lines = md.split("\n");
	const out: string[] = [];
	let inFence = false;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (FENCE_OPEN.test(line)) {
			inFence = !inFence;
			out.push(line);
			i++;
			continue;
		}
		if (inFence) {
			out.push(line);
			i++;
			continue;
		}
		if (BOX_DRAWING.test(line)) {
			const block: string[] = [];
			// Pull the preceding root label into the block so it isn't stranded
			// as a separate paragraph above the fenced tree.
			if (out.length > 0) {
				const prev = out[out.length - 1];
				if (prev && prev.trim() !== "" && prev.length <= 80 && !/[.。!?！？]$/.test(prev.trim())) {
					block.push(out.pop()!);
				}
			}
			while (i < lines.length && BOX_DRAWING.test(lines[i])) {
				block.push(lines[i]);
				i++;
			}
			out.push("```text");
			out.push(...block);
			out.push("```");
		} else {
			out.push(line);
			i++;
		}
	}
	return out.join("\n");
}

export default function MarkdownRenderer({ content, streaming, className }: Props) {
	// remark-breaks turns single newlines into <br> so author-intended line
	// breaks survive rendering. Without it, Markdown treats a single \n as a
	// soft wrap and collapses it — which eats the structure of ASCII / tree
	// diagrams the model emits as plain text (not in a code fence), scrambling
	// their alignment. Code blocks are unaffected (they preserve newlines
	// regardless). Applies uniformly to chat messages, tool results, and the
	// doc viewer.
	const cleaned = useMemo(() => {
		const collapsed = content.replace(/\n{3,}/g, "\n\n").trim();
		return wrapAsciiArt(collapsed);
	}, [content]);

	const components = useMemo(() => ({
		code({ className: codeClassName, children, ...rest }: React.HTMLAttributes<HTMLElement> & { node?: any }) {
			const text = String(children);
			const match = /language-(\w+)/.exec(codeClassName || "");
			// BLOCK code (a fenced ``` block) routes through CodeBlock so it
			// renders in a monospace <pre> with whitespace preserved. Block code
			// is identified by EITHER a language info string OR a newline —
			// react-markdown v10 no longer passes an `inline` flag, but inline
			// code is a single line with no language class, so "multiline OR
			// has-language" cleanly separates the two. Without this, a
			// language-less fence (e.g. the model wrapping an ASCII tree in
			// ``` with no language) fell through to inline `<code>`, the `<pre>`
			// wrapper got stripped, leading spaces collapsed, and the tree's
			// indentation/alignment was destroyed.
			if (match || text.includes("\n")) {
				return <CodeBlock code={text.replace(/\n$/, "")} language={match ? match[1] : undefined} />;
			}

			return <code className="md-inline-code" {...rest}>{children}</code>;
		},
		pre({ children }: React.HTMLAttributes<HTMLPreElement>) {
			// CodeBlock renders its own container; don't add a wrapping <pre>.
			return <>{children}</>;
		},
	}), []);

	return (
		<div className={`markdown-body${streaming ? " streaming" : ""}${className ? ` ${className}` : ""}`}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm, remarkBreaks]}
				rehypePlugins={[rehypeRaw]}
				components={components}
			>
				{cleaned}
			</ReactMarkdown>
		</div>
	);
}
