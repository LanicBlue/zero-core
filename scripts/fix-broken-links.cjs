// One-shot script: demote broken markdown links in docs/ to inline code,
// preserving the link label as text. Used after hardening check-doc-links.cjs
// to clean up previously-unverified broken source/JSON/dir links without
// weakening the checker.
//
// Strategy:
//   - Reuses the same scope/resolution rules as check-doc-links.cjs.
//   - For each broken link `[label](target)`, rewrite as `` `label` ``.
//   - Leaves code blocks alone (no rewriting inside ``` ``` or `inline`).
//   - Idempotent: re-running on already-fixed files is a no-op (the resulting
//     text contains no markdown link to a broken target).
//
// Run: node scripts/fix-broken-links.cjs

const fs = require("fs");
const path = require("path");

const DOCS = path.resolve(__dirname, "..", "docs");
const REPO_ROOT = path.resolve(__dirname, "..");

const LINK_RE = /\]\(([^)]+)\)/g;
const SOURCE_EXT = new Set([
	".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".json", ".html", ".mdx",
]);

// Match the full markdown link shape `[label](target)` so we can rewrite it.
// Label may already contain backticks / colons. Target is the captured group.
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

function walkMdFiles(dir, out) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === ".docloop") continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walkMdFiles(p, out);
		else if (e.name.endsWith(".md")) out.push(p);
	}
	return out;
}

function stripCodeSpansAndFences(text) {
	return text
		.replace(/```[\s\S]*?```/g, "")
		.replace(/~~~[\s\S]*?~~~/g, "")
		.replace(/`[^`\n]*`/g, "");
}

function shouldCheck(target) {
	if (!target) return false;
	if (/^https?:/i.test(target)) return false;
	if (/^mailto:/i.test(target)) return false;
	if (target.startsWith("#")) return false;
	if (target.startsWith("/")) return false;
	const clean = target.split("#")[0].split("?")[0];
	if (!clean) return false;
	const lower = clean.toLowerCase();
	if (lower.endsWith(".md")) return true;
	for (const ext of SOURCE_EXT) if (lower.endsWith(ext)) return true;
	if (clean.endsWith("/")) return true;
	const lastSlash = clean.lastIndexOf("/");
	const lastSeg = clean.slice(lastSlash + 1);
	if (lastSlash >= 0 && !lastSeg.includes(".")) return true;
	return false;
}

function resolveTarget(fromFile, target) {
	const clean = target.split("#")[0].split("?")[0];
	const fromDir = path.dirname(fromFile);
	const relToDoc = path.normalize(path.join(fromDir, clean));
	if (fs.existsSync(relToDoc)) return relToDoc;
	if (!clean.startsWith(".") && !clean.startsWith("/")) {
		const relToRoot = path.normalize(path.join(REPO_ROOT, clean));
		if (fs.existsSync(relToRoot)) return relToRoot;
	}
	return null;
}

// Returns true if a position in `text` is inside an inline code span or fence.
// Computed by scanning forward from start-of-string keeping state.
function buildCodeMask(text) {
	const mask = new Uint8Array(text.length); // 1 = inside code
	let i = 0;
	while (i < text.length) {
		// Fenced code block
		if (text.startsWith("```", i) || text.startsWith("~~~", i)) {
			const fence = text.substr(i, 3);
			const end = text.indexOf(fence, i + 3);
			const stop = end === -1 ? text.length : end + 3;
			for (let k = i; k < stop; k++) mask[k] = 1;
			i = stop;
			continue;
		}
		// Inline code span
		if (text[i] === "`") {
			let j = i + 1;
			while (j < text.length && text[j] !== "`") j++;
			// Include the closing backtick (or run to EOL if unclosed).
			const stop = j < text.length ? j + 1 : text.length;
			for (let k = i; k < stop; k++) mask[k] = 1;
			i = stop;
			continue;
		}
		i++;
	}
	return mask;
}

const files = walkMdFiles(DOCS, []);
let totalRewrites = 0;
const filesTouched = new Set();

for (const file of files) {
	const raw = fs.readFileSync(file, "utf-8");
	const mask = buildCodeMask(raw);
	// First pass: collect link spans that are broken AND not inside code.
	const rewrites = []; // {start, end, replacement}
	let m;
	MD_LINK_RE.lastIndex = 0;
	while ((m = MD_LINK_RE.exec(raw))) {
		const linkStart = m.index;
		const linkEnd = m.index + m[0].length;
		// Skip if any char of the match is inside a code span/fence.
		let inCode = false;
		for (let k = linkStart; k < linkEnd; k++) {
			if (mask[k]) { inCode = true; break; }
		}
		if (inCode) continue;
		const label = m[1];
		const target = m[2];
		if (!shouldCheck(target)) continue;
		if (resolveTarget(file, target)) continue; // resolves fine
		// Broken link → demote to inline code with the label.
		// If label is empty (rare), fall back to the cleaned target.
		const cleanTarget = target.split("#")[0].split("?")[0];
		const labelText = label.trim().length > 0 ? label.trim() : cleanTarget;
		// Strip surrounding backticks from label (avoid triple backticks).
		const inner = labelText.replace(/^`+/, "").replace(/`+$/, "").trim();
		const replacement = "`" + inner + "`";
		rewrites.push({ start: linkStart, end: linkEnd, replacement });
	}
	if (rewrites.length === 0) continue;
	// Apply rewrites right-to-left.
	rewrites.sort((a, b) => b.start - a.start);
	let out = raw;
	for (const r of rewrites) {
		out = out.slice(0, r.start) + r.replacement + out.slice(r.end);
	}
	fs.writeFileSync(file, out, "utf-8");
	totalRewrites += rewrites.length;
	filesTouched.add(file);
	console.log(`  ${path.relative(DOCS, file)}: ${rewrites.length} link(s) demoted`);
}

console.log(`\nTotal: ${totalRewrites} broken links demoted across ${filesTouched.size} files`);
