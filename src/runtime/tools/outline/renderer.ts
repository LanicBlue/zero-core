import { OutlineNode, OutlineResult } from "./types.js";

export interface RenderOptions {
	budget?: number; // max output lines (default 200)
}

interface RenderEntry {
	line: string;
	children?: OutlineNode[];
	depth: number;
	expandPriority: number;
	node: OutlineNode;
}

export function renderOutline(result: OutlineResult, opts?: RenderOptions): string {
	const budget = opts?.budget ?? 200;
	const nodes = mergeImports(result.nodes);

	// Count total nodes to decide if we can fully expand
	const totalNodes = countAllNodes(nodes);
	const canFullyExpand = totalNodes <= budget;

	const entries: RenderEntry[] = [];

	for (const node of nodes) {
		entries.push({
			line: fmtLine(node, 0),
			children: node.children?.length ? node.children : undefined,
			depth: 0,
			expandPriority: expandPriority(node),
			node,
		});
	}

	let totalLines = entries.length;

	if (canFullyExpand) {
		// Expand everything at once
		let i = 0;
		while (i < entries.length) {
			const e = entries[i];
			if (e.children) {
				const childEntries = expandChildren(e);
				e.children = undefined;
				entries.splice(i + 1, 0, ...childEntries);
				totalLines += childEntries.length;
			}
			i++;
		}
	} else {
		// Priority-based partial expansion
		totalLines += 3; // header + blank + footer
		while (totalLines < budget) {
			let bestIdx = -1;
			let bestPri = -1;
			for (let i = 0; i < entries.length; i++) {
				const e = entries[i];
				if (!e.children) continue;
				if (e.expandPriority > bestPri) {
					bestPri = e.expandPriority;
					bestIdx = i;
				}
			}
			if (bestIdx < 0) break;

			const entry = entries[bestIdx];
			const childEntries = expandChildren(entry);

			if (totalLines + childEntries.length > budget) {
				entry.expandPriority = -1;
				continue;
			}

			entry.children = undefined;
			entries.splice(bestIdx + 1, 0, ...childEntries);
			totalLines += childEntries.length;
		}

		// Mark collapsed nodes
		for (const entry of entries) {
			if (entry.children && entry.children.length > 0) {
				const count = entry.children.length;
				entry.line += ` [+${count} collapsed — use read offset=${entry.node.line} limit=${entry.node.endLine - entry.node.line + 1}]`;
				entry.children = undefined;
			}
		}
	}

	const header = `${result.file} (${result.totalLines} lines, ${result.language})`;
	const lines = [header, ""];
	for (const entry of entries) lines.push(entry.line);

	return lines.join("\n");
}

function countAllNodes(nodes: OutlineNode[]): number {
	let count = 0;
	for (const n of nodes) {
		count++;
		if (n.children?.length) count += countAllNodes(n.children);
	}
	return count;
}

function expandChildren(entry: RenderEntry): RenderEntry[] {
	return (entry.children ?? []).map(cn => ({
		line: fmtLine(cn, entry.depth + 1),
		children: cn.children?.length ? cn.children : undefined,
		depth: entry.depth + 1,
		expandPriority: expandPriority(cn),
		node: cn,
	}));
}

function expandPriority(node: OutlineNode): number {
	switch (node.kind) {
		case "class": case "struct": case "interface": case "trait": return 10;
		case "function": case "method": case "impl": return 5;
		case "property": case "key": return 3;
		case "rule": return 1;
		default: return 2;
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

function fmtLine(node: OutlineNode, depth: number): string {
	const range = node.line === node.endLine
		? `L${node.line}`
		: `L${node.line}-${node.endLine}`;

	const indent = "  ".repeat(depth);
	const kind = shortKind(node.kind);
	const detail = formatDetail(node);

	return `${range.padEnd(12)} ${indent}${kind} ${node.name}${detail}`;
}

function shortKind(kind: string): string {
	switch (kind) {
		case "import": return "import";
		case "class": case "struct": return "class";
		case "interface": case "trait": return "interface";
		case "function": return "fn";
		case "method": return "method";
		case "constructor": return "ctor";
		case "enum": return "enum";
		case "property": case "field": return "field";
		case "const": case "variable": return "const";
		case "type": case "typedef": return "type";
		case "namespace": case "module": return "module";
		case "heading": return "heading";
		default: return kind.slice(0, 8);
	}
}

function formatDetail(node: OutlineNode): string {
	if (!node.detail) return "";
	if (node.kind === "import") return "";

	const d = node.detail;
	if (d === node.name || d.startsWith(node.name + " ") || d.startsWith(node.name + "(")) return "";
	if (node.kind === "rule" && d === node.name) return "";
	if (node.kind === "heading") return "";

	const maxLen = 60;
	const shortened = d.length > maxLen ? d.slice(0, maxLen - 3) + "..." : d;
	return ` - ${shortened}`;
}
