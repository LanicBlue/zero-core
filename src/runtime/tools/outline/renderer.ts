import { OutlineNode, OutlineResult } from "./types.js";

export interface RenderOptions {
	budget?: number; // max output lines (default 200)
	source?: string; // raw file content for content-based rendering
}

export function renderOutline(result: OutlineResult, opts?: RenderOptions): string {
	const budget = opts?.budget ?? 200;
	const source = opts?.source;
	const lines = source ? source.split("\n") : [];
	const width = String(result.totalLines).length;
	const nodes = mergeImports(result.nodes);
	const headerLines = 2; // header + blank

	// Collect all nodes grouped by depth
	const byDepth = new Map<number, OutlineNode[]>();
	function collectByDepth(ns: OutlineNode[], depth: number) {
		for (const n of ns) {
			if (!byDepth.has(depth)) byDepth.set(depth, []);
			byDepth.get(depth)!.push(n);
			if (n.children.length > 0) collectByDepth(n.children, depth + 1);
		}
	}
	collectByDepth(nodes, 0);

	// Lines in a node's range not covered by its children
	function gapLineCount(node: OutlineNode): number {
		const total = node.endLine - node.line + 1;
		let childTotal = 0;
		for (const c of node.children) childTotal += c.endLine - c.line + 1;
		return Math.max(0, total - childTotal);
	}

	// Calculate always-visible gap lines (outside any root node)
	let alwaysGap = 0;
	let pos = 1;
	for (const node of nodes) {
		alwaysGap += node.line - pos;
		pos = node.endLine + 1;
	}
	if (lines.length > 0) alwaysGap += Math.max(0, lines.length + 1 - pos);

	// BFS expansion by depth level
	const expanded = new Set<OutlineNode>();
	// Initial: only roots visible as fold hints + always-visible gaps + header
	let currentSize = nodes.length + alwaysGap + headerLines;
	const maxDepth = byDepth.size > 0 ? Math.max(...byDepth.keys()) : 0;

	for (let d = 0; d <= maxDepth; d++) {
		const depthNodes = byDepth.get(d);
		if (!depthNodes || depthNodes.length === 0) continue;

		// Cost of expanding all nodes at this depth:
		// each node goes from 1 fold-hint line to (gapLines + childCount) lines
		let cost = 0;
		for (const node of depthNodes) {
			cost += gapLineCount(node) + node.children.length - 1;
		}

		if (currentSize + cost > budget) break;

		for (const node of depthNodes) expanded.add(node);
		currentSize += cost;
	}

	// Render: walk source lines, show content for expanded nodes, fold hints for collapsed
	const output: string[] = [];
	pos = 1;

	for (const node of nodes) {
		// Gap lines before this root node
		if (source) {
			for (let i = pos; i < node.line; i++) {
				output.push(fmtContent(i, lines[i - 1], width));
			}
		}
		renderNode(node, lines, expanded, 0, width, output, !!source);
		pos = node.endLine + 1;
	}

	// Gap lines after last root node
	if (source) {
		for (let i = pos; i <= lines.length; i++) {
			output.push(fmtContent(i, lines[i - 1], width));
		}
	}

	const header = `${result.file} (${result.totalLines} lines, ${result.language})`;
	output.unshift("", header);

	return output.join("\n");
}

function fmtContent(line: number, content: string, width: number): string {
	return `L${String(line).padStart(width)}  ${content}`;
}

function renderNode(
	node: OutlineNode,
	lines: string[],
	expanded: Set<OutlineNode>,
	depth: number,
	width: number,
	output: string[],
	hasSource: boolean,
): void {
	if (!expanded.has(node)) {
		// Collapsed: show fold hint with name + detail
		const span = node.endLine - node.line + 1;
		const range = node.line === node.endLine
			? `L${String(node.line).padStart(width)}`
			: `L${String(node.line).padStart(width)}-${node.endLine}`;
		const indent = "  ".repeat(depth);
		
		output.push(`${range}  ${indent}${node.name} [...]`);
		return;
	}

	// Expanded: show actual source content interleaved with children
	let pos = node.line;
	for (const child of node.children) {
		// Gap lines before this child
		if (hasSource) {
			for (let i = pos; i < child.line; i++) {
				output.push(fmtContent(i, lines[i - 1], width));
			}
		}
		renderNode(child, lines, expanded, depth + 1, width, output, hasSource);
		pos = child.endLine + 1;
	}
	// Gap lines after last child
	if (hasSource) {
		for (let i = pos; i <= node.endLine; i++) {
			output.push(fmtContent(i, lines[i - 1], width));
		}
	}
}

function mergeImports(nodes: OutlineNode[]): OutlineNode[] {
	const result: OutlineNode[] = [];
	let i = 0;
	while (i < nodes.length) {
		if (nodes[i].kind === "import") {
			const first = nodes[i];
			let count = 1;
			let lastEnd = first.endLine;
			while (i + count < nodes.length && nodes[i + count].kind === "import") {
				lastEnd = nodes[i + count].endLine;
				count++;
			}
			if (count > 3) {
				result.push(first);
				result.push({
					kind: "import",
					name: `${count - 1} more imports`,
					line: first.endLine + 1,
					endLine: lastEnd,
					children: [],
				});
				i += count;
			} else {
				for (let j = 0; j < count; j++) result.push(nodes[i + j]);
				i += count;
			}
		} else {
			result.push(nodes[i]);
			i++;
		}
	}
	return result;
}
