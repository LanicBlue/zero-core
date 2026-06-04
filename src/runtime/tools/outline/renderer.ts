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

	// Phase 1: Expand structural (non-leaf) nodes with BFS priority
	const expanded = new Set<OutlineNode>();
	let currentSize = nodes.length + alwaysGap + headerLines;

	const structuralQueue: { node: OutlineNode; depth: number }[] = [];
	for (const n of nodes) structuralQueue.push({ node: n, depth: 0 });

	while (structuralQueue.length > 0) {
		// Pick best: shallowest depth, then most children
		let bestIdx = 0;
		for (let j = 1; j < structuralQueue.length; j++) {
			const best = structuralQueue[bestIdx];
			const curr = structuralQueue[j];
			if (curr.depth < best.depth ||
				(curr.depth === best.depth && curr.node.children.length > best.node.children.length)) {
				bestIdx = j;
			}
		}
		const { node, depth } = structuralQueue[bestIdx];
		structuralQueue.splice(bestIdx, 1);

		// Skip leaf nodes in phase 1
		if (node.children.length === 0) continue;

		const cost = gapLineCount(node) + node.children.length - 1;
		if (currentSize + cost > budget) continue;

		expanded.add(node);
		currentSize += cost;
		for (const child of node.children) {
			structuralQueue.push({ node: child, depth: depth + 1 });
		}
	}

	// Phase 2: Expand leaf nodes to show full content
	// Collect visible leaf nodes (those whose ancestors are all expanded)
	const leafCandidates: { node: OutlineNode; depth: number }[] = [];
	function collectLeaves(ns: OutlineNode[], depth: number) {
		for (const n of ns) {
			if (!expanded.has(n)) {
				// Collapsed: if leaf, it's a candidate
				if (n.children.length === 0) {
					leafCandidates.push({ node: n, depth });
				}
			} else {
				// Expanded: recurse into children
				collectLeaves(n.children, depth + 1);
			}
		}
	}
	collectLeaves(nodes, 0);

	// Sort: shallowest first, then smallest span first
	leafCandidates.sort((a, b) => {
		if (a.depth !== b.depth) return a.depth - b.depth;
		return (a.node.endLine - a.node.line) - (b.node.endLine - b.node.line);
	});

	const fullContent = new Set<OutlineNode>();
	let prevDepth = -1;
	let depthFailed = false;
	for (const { node, depth } of leafCandidates) {
		if (depth !== prevDepth) {
			if (depthFailed) break;
			prevDepth = depth;
			depthFailed = false;
		}
		const span = node.endLine - node.line + 1;
		const cost = span - 1;
		if (currentSize + cost > budget) {
			depthFailed = true;
			continue;
		}
		fullContent.add(node);
		currentSize += cost;
	}

	// Render
	const output: string[] = [];
	pos = 1;

	for (const node of nodes) {
		if (source) {
			for (let i = pos; i < node.line; i++) {
				output.push(fmtContent(i, lines[i - 1], width));
			}
		}
		renderNode(node, lines, expanded, fullContent, 0, width, output, !!source);
		pos = node.endLine + 1;
	}

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
	fullContent: Set<OutlineNode>,
	depth: number,
	width: number,
	output: string[],
	hasSource: boolean,
): void {
	const isExpanded = expanded.has(node);
	const showContent = fullContent.has(node);

	if (showContent) {
		// Leaf node with full content
		for (let i = node.line; i <= node.endLine; i++) {
			output.push(fmtContent(i, lines[i - 1], width));
		}
		return;
	}

	if (!isExpanded) {
		// Collapsed: fold hint
		const range = node.line === node.endLine
			? `L${String(node.line).padStart(width)}`
			: `L${String(node.line).padStart(width)}-${node.endLine}`;
		const indent = "  ".repeat(depth);
		output.push(`${range}  ${indent}${node.name} [...]`);
		return;
	}

	// Expanded non-leaf: show gap lines + children
	let pos = node.line;
	for (const child of node.children) {
		if (hasSource) {
			for (let i = pos; i < child.line; i++) {
				output.push(fmtContent(i, lines[i - 1], width));
			}
		}
		renderNode(child, lines, expanded, fullContent, depth + 1, width, output, hasSource);
		pos = child.endLine + 1;
	}
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
