// One-shot doc link integrity check: verifies every relative link in docs/
// resolves to an existing file or directory. Run via `npm run check:links`.
// Exits non-zero on any broken link so it can gate commits/CI.
//
// Verifies:
//   - relative `.md` links (legacy behavior, kept intact)
//   - relative source links: `.ts` `.tsx` `.js` `.jsx` `.cjs` `.mjs` `.json`
//   - relative directory links (e.g. `../archive/`, `../../src/server/`)
//
// Skips:
//   - docs/.docloop/ (separate effort)
//   - Absolute (`http://`, `https://`, `mailto:`, root-anchored `/...`)
//   - Anchor-only links (`#section`)
//   - Inline code spans and fenced code blocks (avoid treating code like
//     `foo(bar)` or `arr[idx](fn)` as markdown links)
//   - Link targets that have neither a `/` nor a known extension (filters
//     out incidental `](text)` patterns in prose / Obsidian alias syntax)
//
// A relative link may be resolved against EITHER the doc file's directory
// (conventional) OR the repo root (for paths written as `src/...`,
// `tests/...`, `scripts/...` without a leading `./` or `../`).

const fs = require("fs");
const path = require("path");

const DOCS = path.resolve(__dirname, "..", "docs");
const REPO_ROOT = path.resolve(__dirname, "..");

// Markdown link regex: [text](target). target captured verbatim.
const LINK_RE = /\]\(([^)]+)\)/g;

// Extensions we verify as source/asset links (besides .md).
const SOURCE_EXT = new Set([
	".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".json", ".html", ".mdx",
]);

// Walk and collect .md files (excluding .docloop and code blocks stripped later).
function walkMdFiles(dir, out) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === ".docloop") continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walkMdFiles(p, out);
		else if (e.name.endsWith(".md")) out.push(p);
	}
	return out;
}

// Strip fenced code blocks and inline code spans so link-like text inside
// code (e.g. `foo(bar)`, `arr[idx](fn)`) is not mistaken for links.
function stripCode(text) {
	// Remove fenced code blocks: ``` ... ``` or ~~~ ... ~~~
	text = text.replace(/```[\s\S]*?```/g, "");
	text = text.replace(/~~~[\s\S]*?~~~/g, "");
	// Remove inline code spans: `...`. Link regex won't fire inside them.
	text = text.replace(/`[^`\n]*`/g, "");
	return text;
}

// Decide whether a link target should be verified.
// Returns true if it's in scope (.md, known source ext, or directory path).
function shouldCheck(target) {
	if (!target) return false;
	if (/^https?:/i.test(target)) return false;
	if (/^mailto:/i.test(target)) return false;
	if (target.startsWith("#")) return false;
	if (target.startsWith("/")) return false; // root-absolute: skip
	// Strip any anchor / query.
	const clean = target.split("#")[0].split("?")[0];
	if (!clean) return false;
	const lower = clean.toLowerCase();
	if (lower.endsWith(".md")) return true;
	for (const ext of SOURCE_EXT) {
		if (lower.endsWith(ext)) return true;
	}
	// Directory-style link: ends with "/" OR contains "/" and has no extension
	// at the final segment (e.g. "../archive", "../../src/server").
	if (clean.endsWith("/")) return true;
	const lastSlash = clean.lastIndexOf("/");
	const lastSeg = clean.slice(lastSlash + 1);
	if (lastSlash >= 0 && !lastSeg.includes(".")) return true;
	return false;
}

function resolveTarget(fromFile, target) {
	const clean = target.split("#")[0].split("?")[0];
	// Try relative to doc directory first.
	const fromDir = path.dirname(fromFile);
	const relToDoc = path.normalize(path.join(fromDir, clean));
	if (fs.existsSync(relToDoc)) return relToDoc;
	// Fall back to repo root for paths written as `src/...`, `tests/...`,
	// `scripts/...`, `docs/...` (no leading `./` or `../`).
	if (!clean.startsWith(".") && !clean.startsWith("/")) {
		const relToRoot = path.normalize(path.join(REPO_ROOT, clean));
		if (fs.existsSync(relToRoot)) return relToRoot;
	}
	return null;
}

const files = walkMdFiles(DOCS, []);
const broken = [];
let checked = 0;

for (const file of files) {
	const raw = fs.readFileSync(file, "utf-8");
	const src = stripCode(raw);
	let m;
	while ((m = LINK_RE.exec(src))) {
		const target = m[1];
		if (!shouldCheck(target)) continue;
		const resolved = resolveTarget(file, target);
		checked++;
		if (!resolved) {
			broken.push(`${path.relative(DOCS, file)}  →  ${target}`);
		}
	}
}

console.log(`checked ${checked} relative links (.md + source + dir)`);
if (broken.length === 0) {
	console.log("✅ all relative links resolve");
	process.exit(0);
}
console.log(`❌ ${broken.length} broken:`);
for (const b of broken) console.log("  " + b);
process.exit(1);
