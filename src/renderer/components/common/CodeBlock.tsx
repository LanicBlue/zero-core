// 代码块高亮渲染组件
//
// # 文件说明书
//
// ## 核心功能
// 使用 Shiki 进行语法高亮的代码块渲染
//
// ## 输入
// 代码文本、语言标识、可选标题
//
// ## 输出
// 带语法高亮的代码块 JSX
//
// ## 定位
// src/renderer/components/common/ — 通用组件，为 Markdown 渲染提供代码支持
//
// ## 依赖
// React、utils/shiki-init.js
//
// ## 维护规则
// 新增高亮语言需确保 Shiki 已加载对应 grammar
//
import React, { useState, useEffect, useMemo } from "react";
import { getShiki, isShikiReady } from "../../utils/shiki-init.js";

interface Props {
	code: string;
	language?: string;
}

const COLLAPSE_THRESHOLD = 15;

const LANG_ALIASES: Record<string, string> = {
	js: "javascript",
	ts: "typescript",
	py: "python",
	rb: "ruby",
	sh: "bash",
	shell: "bash",
	yml: "yaml",
	mdx: "markdown",
	text: "",
	plaintext: "",
};

function resolveLang(lang?: string): string {
	if (!lang) return "";
	const lower = lang.toLowerCase().replace(/^language-/, "");
	return LANG_ALIASES[lower] ?? lower;
}

export default function CodeBlock({ code, language }: Props) {
	const lang = resolveLang(language);
	const displayName = lang || "text";
	const lines = code.split("\n");
	const collapsible = lines.length > COLLAPSE_THRESHOLD;
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);
	const [html, setHtml] = useState<string>("");

	const theme = document.documentElement.getAttribute("data-theme") === "light"
		? "github-light"
		: "github-dark";

	useEffect(() => {
		if (!isShikiReady() || !lang) {
			setHtml("");
			return;
		}
		try {
			const shiki = getShiki();
			const loadedLangs = shiki.getLoadedLanguages();
			if (loadedLangs.includes(lang)) {
				setHtml(shiki.codeToHtml(code, { lang, theme }));
			} else {
				setHtml("");
			}
		} catch {
			setHtml("");
		}
	}, [code, lang, theme]);

	const displayCode = collapsible && !expanded
		? lines.slice(0, COLLAPSE_THRESHOLD).join("\n") + "\n..."
		: code;

	const copy = async () => {
		await navigator.clipboard.writeText(code);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	return (
		<div className="code-block">
			<div className="code-block-header">
				<span className="code-block-lang">{displayName}</span>
				<button type="button" className="code-block-copy" onClick={copy}>
					{copied ? "Copied!" : "Copy"}
				</button>
			</div>
			{html ? (
				<div
					className="code-block-content"
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			) : (
				<pre className="code-block-content"><code>{displayCode}</code></pre>
			)}
			{collapsible && !expanded && (
				<button
					type="button"
					className="code-block-expand"
					onClick={() => setExpanded(true)}
				>
					Show {lines.length - COLLAPSE_THRESHOLD} more lines
				</button>
			)}
		</div>
	);
}
