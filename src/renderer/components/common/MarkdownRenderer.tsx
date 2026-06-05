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
import rehypeRaw from "rehype-raw";
import CodeBlock from "./CodeBlock.js";

interface Props {
	content: string;
	streaming?: boolean;
	className?: string;
	softBreak?: boolean;
}

export default function MarkdownRenderer({ content, streaming, className, softBreak }: Props) {
	const cleaned = useMemo(() => {
		let s = content;
		if (softBreak) s = s.replace(/\n/g, "  \n");
		return s.replace(/\n{3,}/g, "\n\n").trim();
	}, [content, softBreak]);

	const components = useMemo(() => ({
		code({ className: codeClassName, children, ...rest }: React.HTMLAttributes<HTMLElement> & { node?: any }) {
			const match = /language-(\w+)/.exec(codeClassName || "");
			const code = String(children).replace(/\n$/, "");

			if (match) {
				return <CodeBlock code={code} language={match[1]} />;
			}

			return <code className="md-inline-code" {...rest}>{children}</code>;
		},
		pre({ children }: React.HTMLAttributes<HTMLPreElement>) {
			return <>{children}</>;
		},
	}), []);

	return (
		<div className={`markdown-body${streaming ? " streaming" : ""}${className ? ` ${className}` : ""}`}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[rehypeRaw]}
				components={components}
			>
				{cleaned}
			</ReactMarkdown>
		</div>
	);
}
