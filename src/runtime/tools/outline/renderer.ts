import { OutlineNode, OutlineResult } from "./types.js";

export interface RenderOptions {
	budget?: number; // max output lines (default 200)
}

interface RenderEntry {
	line: string;
	children?: OutlineNode[];
	depth: number;
	node: OutlineNode;
}

export function renderOutline(result: OutlineResult, opts?: RenderOptions): string {
	const budget = opts?.budget ?? 200;
	const lang = result.language;
	const nodes = mergeImports(result.nodes);

	// Count total nodes to decide if we can fully expand
	const totalNodes = countAllNodes(nodes);
	const canFullyExpand = totalNodes <= budget;

	const entries: RenderEntry[] = [];

	for (const node of nodes) {
		entries.push({
			line: fmtLine(node, 0, false, lang),
			children: node.children?.length ? node.children : undefined,
			depth: 0,
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
				const childEntries = expandChildren(e, lang);
				e.children = undefined;
				e.line = fmtLine(e.node, e.depth, true, lang);
				entries.splice(i + 1, 0, ...childEntries);
				totalLines += childEntries.length;
			}
			i++;
		}
	} else {
		// BFS expansion: expand shallowest depth first, then by children count
		totalLines += 3; // header + blank + footer
		let skipped = 0;
		const prevSkipped = -1;

		while (totalLines < budget) {
			// Pick best candidate: shallowest depth, then most children
			let bestIdx = -1;
			let bestDepth = Infinity;
			let bestChildren = -1;

			for (let i = 0; i < entries.length; i++) {
				const e = entries[i];
				if (!e.children) continue;

				// BFS: prefer shallower depth
				if (e.depth > bestDepth) continue;
				if (e.depth < bestDepth) {
					bestDepth = e.depth;
					bestChildren = -1;
				}

				// Among same depth: prefer more children
				if (e.children.length > bestChildren) {
					bestChildren = e.children.length;
					bestIdx = i;
				}
			}

			if (bestIdx < 0) break;

			const entry = entries[bestIdx];
			const childEntries = expandChildren(entry, lang);

			if (totalLines + childEntries.length > budget) {
				entry.children = undefined; // too large, mark as collapsed
				skipped++;
				continue;
			}

			entry.children = undefined;
			entry.line = fmtLine(entry.node, entry.depth, true);
			entries.splice(bestIdx + 1, 0, ...childEntries);
			totalLines += childEntries.length;
		}

		// Mark collapsed nodes with child summary
		for (const entry of entries) {
			if (entry.children && entry.children.length > 0) {
				const summary = summarizeChildren(entry.children);
				entry.line += ` [+${summary} — use read offset=${entry.node.line} limit=${entry.node.endLine - entry.node.line + 1}]`;
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

function expandChildren(entry: RenderEntry, lang: string): RenderEntry[] {
	return (entry.children ?? []).map(cn => ({
		line: fmtLine(cn, entry.depth + 1, false, lang),
		children: cn.children?.length ? cn.children : undefined,
		depth: entry.depth + 1,
		node: cn,
	}));
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

function fmtLine(node: OutlineNode, depth: number, expandedChildren?: boolean, lang?: string): string {
	const range = expandedChildren || node.line === node.endLine
		? `L${node.line}`
		: `L${node.line}-${node.endLine}`;

	const indent = "  ".repeat(depth);
	const kind = shortKind(node.kind);
	const detail = formatDetail(node, expandedChildren ?? false, lang ?? "");

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

function formatDetail(node: OutlineNode, expandedChildren: boolean, lang: string): string {
	if (node.kind === "import") return "";

	const isMultiLine = node.endLine > node.line;
	const isLeaf = !node.children?.length;
	const showEllipsis = isMultiLine && isLeaf && !expandedChildren;
	const closing = showEllipsis ? closingText(node, lang) : "";

	let d = node.detail ?? "";

	// Strip trailing {/</ when we'll append { ... } / <tag> ... </tag>
	if (showEllipsis && d.endsWith(" {")) d = d.slice(0, -2);
	else if (showEllipsis && d.endsWith("{")) d = d.slice(0, -1);

	let detail = "";
	if (d && d !== node.name && !d.startsWith(node.name + " ") && !d.startsWith(node.name + "(")) {
		const budget = 80 - (closing.length ? closing.length + 6 : 0);
		const shortened = d.length > budget ? d.slice(0, budget - 3) + "..." : d;
		detail = ` - ${shortened}`;
	}

	if (closing) {
		const opener = openingText(node);
		detail += ` ${opener} ... ${closing}`;
	}

	return detail;
}

// Language categories for closing text
const BRACE_LANGS = new Set([
	"TypeScript", "TypeScript (TSX)", "JavaScript", "JavaScript (JSX)",
	"JavaScript (ESM)", "JavaScript (CJS)", "Java", "C", "C Header",
	"C++", "C++ Header", "Go", "Rust", "Swift", "Kotlin", "Kotlin Script",
	"Scala", "Dart", "CSS", "SCSS", "SASS", "Less",
]);

const END_LANGS = new Set(["Ruby", "Lua", "Shell", "Bash", "Zsh"]);

function closingText(node: OutlineNode, lang: string): string {
	// Per-node override
	if (node.close !== undefined) return node.close;

	switch (node.kind) {
		case "tag": return `</${node.name}>`;
		case "heading": case "import": case "key": case "segment":
			return "";
		default:
			if (END_LANGS.has(lang)) return "end";
			if (!BRACE_LANGS.has(lang)) return ""; // Python, YAML, TOML, etc.
			return "}";
	}
}

function openingText(node: OutlineNode): string {
	if (node.kind === "tag") return "";
	return "{";
}

function summarizeChildren(children: OutlineNode[]): string {
	const total = children.length;
	const byKind: Record<string, number> = {};
	for (const c of children) {
		const k = shortKind(c.kind);
		byKind[k] = (byKind[k] || 0) + 1;
	}
	const parts = Object.entries(byKind)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([k, v]) => `${v} ${v === 1 ? k : pluralize(k)}`);
	return parts.join(", ");
}

function pluralize(word: string): string {
	if (word.endsWith("s") || word.endsWith("es")) return word;
	if (word.endsWith("y")) return word.slice(0, -1) + "ies";
	return word + "s";
}
