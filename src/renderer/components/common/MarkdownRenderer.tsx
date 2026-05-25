import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import CodeBlock from "./CodeBlock.js";

interface Props {
	content: string;
	streaming?: boolean;
	className?: string;
}

export default function MarkdownRenderer({ content, streaming, className }: Props) {
	const cleaned = useMemo(() => content.replace(/\n{3,}/g, "\n\n").trim(), [content]);

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
