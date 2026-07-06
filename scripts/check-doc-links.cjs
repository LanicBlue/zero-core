// One-shot doc link integrity check: verifies every relative .md link in docs/
// resolves to an existing file. Run via `npm run check:links`. Exits non-zero
// on any broken link so it can gate commits/CI.
//
// Skips docs/.docloop/ (a separate effort). Absolute (http/https, /rooted) and
// anchor-only links are not checked.
const fs = require("fs");
const path = require("path");

const DOCS = path.resolve(__dirname, "..", "docs");
const LINK_RE = /\]\(([^)]+\.md[^)]*)\)/g;
const broken = [];
let checked = 0;

function walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === ".docloop") continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p);
		else if (e.name.endsWith(".md")) check(p);
	}
}

function check(file) {
	const src = fs.readFileSync(file, "utf-8");
	let m;
	while ((m = LINK_RE.exec(src))) {
		let target = m[1].split("#")[0].split("?")[0];
		if (!target || /^https?:/.test(target) || target.startsWith("/")) continue;
		const resolved = path.normalize(path.join(path.dirname(file), target));
		checked++;
		if (!fs.existsSync(resolved)) {
			broken.push(`${path.relative(DOCS, file)}  →  ${m[1]}`);
		}
	}
}

walk(DOCS);
console.log(`checked ${checked} relative .md links`);
if (broken.length === 0) {
	console.log("✅ all relative .md links resolve");
	process.exit(0);
}
console.log(`❌ ${broken.length} broken:`);
for (const b of broken) console.log("  " + b);
process.exit(1);
