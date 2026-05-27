import { OutlineNode, OutlineResult } from "./types.js";

export interface RenderOptions {
	budget?: number; // max output lines (default 200)
}

function kindIcon(kind: string): string {
	switch (kind) {
		case "import": return "📦";
		case "class": case "struct": return "🔷";
		case "interface": case "trait": return "🔶";
		case "function": case "method": return "ƒ";
		case "constructor": return "ctor";
		case "enum": return "🔸";
		case "property": case "field": case "const": case "variable": case "key": return "·";
		case "heading": return "¶";
		case "namespace": case "module": case "package": return "📂";
		case "type": case "typedef": return "Λ";
		case "preprocessor": return "#";
		case "tag": return "<>";
		case "rule": case "section": return "§";
		case "segment": return "—";
		case "table": return "■";
		case "message": case "service": return "◈";
		default: return kind.slice(0, 3);
	}
}

interface RenderEntry {
	line: string;
	children?: OutlineNode[];
	depth: number;
	/** Priority for expansion — higher = expand first */
	expandPriority: number;
}

export function renderOutline(result: OutlineResult, opts?: RenderOptions): string {
	const budget = opts?.budget ?? 200;
	const rawNodes = result.nodes;

	// Pre-process: merge consecutive imports
	const nodes = mergeImports(rawNodes);

	const entries: RenderEntry[] = [];

	// First pass: render all nodes collapsed
	for (const node of nodes) {
		entries.push({
			line: fmtLine(node, 0),
			children: node.children?.length ? node.children : undefined,
			depth: 0,
			expandPriority: expandPriority(node),
		});
	}

	// Second pass: expand children within budget, highest priority first
	let totalLines = 2 + entries.length;
	const header = `${result.file}  (${result.totalLines} lines, ${result.language})`;

	while (totalLines < budget) {
		// Find highest-priority entry with unexpanded children
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
		const childEntries: RenderEntry[] = [];
		for (let j = 0; j < entry.children!.length; j++) {
			const cn = entry.children![j];
			childEntries.push({
				line: fmtLine(cn, entry.depth + 1, j === entry.children!.length - 1),
				children: cn.children?.length ? cn.children : undefined,
				depth: entry.depth + 1,
				expandPriority: expandPriority(cn),
			});
		}

		if (totalLines + childEntries.length > budget) {
			// Too many children — skip this node so we can try smaller ones
			entry.expandPriority = -1;
			continue;
		}

		entry.children = undefined;
		entries.splice(bestIdx + 1, 0, ...childEntries);
		totalLines += childEntries.length;
	}

	const lines = [header, ""];
	for (const entry of entries) lines.push(entry.line);
	return lines.join("\n");
}

/** Priority for child expansion. Classes > functions > objects > lists. */
function expandPriority(node: OutlineNode): number {
	switch (node.kind) {
		case "class": case "struct": case "interface": case "trait": return 10;
		case "function": case "method": case "impl": return 5;
		case "property": case "key": return 3;
		case "rule": return 1;  // CSS rules are low-value lists
		default: return 2;
	}
}

/** Merge consecutive imports (>3) into first + summary */
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
					name: `... +${count - 1} imports`,
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

function fmtLine(node: OutlineNode, depth: number, isLast?: boolean): string {
	const range = node.line === node.endLine
		? `L${node.line}`
		: `L${node.line}-${node.endLine}`;

	const icon = kindIcon(node.kind);
	const detail = formatDetail(node);

	if (depth === 0) {
		return `${range.padEnd(12)} ${icon} ${node.name}${detail}`;
	}

	const branch = isLast ? "└─" : "├─";
	const pad = "  ".repeat(depth - 1);
	return `${range.padEnd(12)} ${pad}${branch} ${icon} ${node.name}${detail}`;
}

/**
 * Format detail string. Avoids redundancy:
 * - Skip detail if it equals the name
 * - Skip detail for CSS rules (name is already the selector)
 * - For heading, show level as #, ##, etc.
 * - For import, skip if name already shows the module path
 */
function formatDetail(node: OutlineNode): string {
	if (!node.detail) return "";

	const d = node.detail;

	// Skip if detail is same as name or starts with it
	if (d === node.name || d.startsWith(node.name + " ") || d.startsWith(node.name + "(")) return "";

	// CSS rule: name is the selector, detail is redundant
	if (node.kind === "rule" && d === node.name) return "";

	// Heading: convert level number to # marks
	if (node.kind === "heading") {
		const level = parseInt(d);
		if (level >= 1 && level <= 6) return "";
	}

	// Property with simple value
	const maxLen = 70;
	const shortened = d.length > maxLen ? d.slice(0, maxLen - 3) + "..." : d;
	return `  ${shortened}`;
}
