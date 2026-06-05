// 大纲提取类型定义
//
// # 文件说明书
//
// ## 核心功能
// 定义代码大纲提取的核心数据结构：OutlineNode 树和 LangExtractor 接口
//
// ## 输入
// 无（纯类型定义）
//
// ## 输出
// OutlineNode、OutlineResult、LangExtractor 等类型接口
//
// ## 定位
// src/runtime/tools/outline/ — 大纲模块的基础类型层
//
// ## 依赖
// 无外部依赖
//
// ## 维护规则
// 节点类型变更需确保所有 extractor 兼容
//
export interface OutlineNode {
	kind: string;       // "import"|"class"|"function"|"method"|"heading"|"property" etc.
	name: string;       // symbol name / tag name / heading text
	line: number;       // 1-based start line
	endLine: number;    // end line (inclusive)
	detail?: string;    // signature summary (params, return type, etc.)
	close?: string;     // closing text for ellipsis display ("}" for C-style, "" to suppress)
	children: OutlineNode[];
}

export interface OutlineResult {
	file: string;
	language: string;
	totalLines: number;
	nodes: OutlineNode[];
}

export interface LangExtractor {
	extract(source: string): OutlineNode[];
}
