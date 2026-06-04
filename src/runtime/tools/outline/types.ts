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
