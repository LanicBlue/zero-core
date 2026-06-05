// Shiki 语法高亮初始化
//
// # 文件说明书
//
// ## 核心功能
// 懒加载初始化 Shiki 语法高亮器，支持多种编程语言的代码着色
//
// ## 输入
// 无（单例初始化）
//
// ## 输出
// Shiki Highlighter 实例、就绪状态检查
//
// ## 定位
// src/renderer/utils/ — 渲染进程工具层，为 CodeBlock 提供高亮能力
//
// ## 依赖
// shiki
//
// ## 维护规则
// 新增高亮语言需确保已加载对应 grammar
//
import { createHighlighter, type Highlighter } from "shiki";

let highlighter: Highlighter | null = null;
let initPromise: Promise<void> | null = null;

export function initShiki(): Promise<void> {
	if (highlighter) return Promise.resolve();
	if (initPromise) return initPromise;

	initPromise = createHighlighter({
		themes: ["github-dark", "github-light"],
		langs: [
			"typescript", "javascript", "python", "rust", "go", "java",
			"css", "html", "json", "yaml", "bash", "sql",
			"markdown", "diff", "jsx", "tsx",
		],
	}).then((h) => {
		highlighter = h;
	});

	return initPromise;
}

export function getShiki(): Highlighter {
	if (!highlighter) throw new Error("Shiki not initialized");
	return highlighter;
}

export function isShikiReady(): boolean {
	return highlighter !== null;
}
