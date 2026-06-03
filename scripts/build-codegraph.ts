// Static analyzer: extract outline + call graph from backend TypeScript source.
//
// Scans src/{main,preload,runtime,server,core,shared}, builds:
//   - file outline (functions + class methods + line ranges)
//   - function-level call edges (resolved across files via imports)
//   - file-level import edges
//
// Emits a self-contained HTML at docs/visualization/code-graph.html.
//
// Run: npm run build:codegraph

import ts from "typescript";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, relative, dirname, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SCAN_DIRS = ["src/main", "src/preload", "src/runtime", "src/server", "src/core", "src/shared"];

// ---------- Types ----------

interface FunctionInfo {
	id: string; // `${fileId}/${name}:${line}`
	name: string;
	kind: "function" | "method" | "arrow";
	className?: string;
	file: string; // canonical path
	line: number;
	endLine: number;
	statementCount: number;
	exported: boolean;
	signature: string;
	callees: string[]; // ids
}

interface FileInfo {
	path: string; // canonical posix path
	lines: number;
	dir: string;
	exports: string[]; // symbol names
	imports: string[]; // canonical paths imported
	functions: string[]; // function ids
}

interface Edge {
	from: string; // function id or file path
	to: string;
	kind: "call" | "import";
}

interface Data {
	files: FileInfo[];
	functions: FunctionInfo[];
	edges: Edge[];
}

// ---------- File collection ----------

function toCanonical(absPath: string): string {
	return relative(ROOT, absPath).split(sep).join(posix.sep);
}

function collectTsFiles(): string[] {
	const out: string[] = [];
	for (const dir of SCAN_DIRS) {
		const absDir = join(ROOT, dir);
		let stats;
		try { stats = statSync(absDir); } catch { continue; }
		if (!stats.isDirectory()) continue;
		const walk = (d: string) => {
			for (const entry of readdirSync(d, { withFileTypes: true })) {
				const full = join(d, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (
					entry.isFile() &&
					entry.name.endsWith(".ts") &&
					!entry.name.endsWith(".d.ts") &&
					!entry.name.endsWith(".test.ts")
				) {
					out.push(full);
				}
			}
		};
		walk(absDir);
	}
	return out;
}

// ---------- Analysis state ----------

const filePaths = collectTsFiles();
const fileSet = new Set(filePaths.map(toCanonical));

// fileId (canonical) -> SourceFile
const sources = new Map<string, ts.SourceFile>();
// fileId -> Map<localName, { resolvedFile, importedName }>
const fileImports = new Map<string, Map<string, { resolvedFile: string; importedName: string }>>();
// fileId -> Map<symbolName, { line, exported, kind, className? }>
const symbolTable = new Map<string, Map<string, { line: number; exported: boolean; kind: string; className?: string }>>();

// Load all source files
for (const abs of filePaths) {
	const canonical = toCanonical(abs);
	const content = readFileSync(abs, "utf-8");
	const sf = ts.createSourceFile(abs, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	sources.set(canonical, sf);
}

// ---------- Phase 1: Build symbol table ----------

function isExported(modifiers?: ts.ModifiersArray): boolean {
	if (!modifiers) return false;
	return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function countStatements(node: ts.Node): number {
	let count = 0;
	const visit = (n: ts.Node) => {
		if (
			ts.isStatement(n) &&
			!ts.isBlock(n)
		) count++;
		ts.forEachChild(n, visit);
	};
	visit(node);
	return count;
}

function getSignature(node: ts.SignatureDeclaration): string {
	const name = node.name ? (ts.isIdentifier(node.name) ? node.name.text : node.name.getText()) : "";
	const params = node.parameters.map((p) => p.getText()).join(", ");
	const kind = ts.isMethodDeclaration(node) ? "method" : "function";
	return `${kind} ${name}(${params})`;
}

interface RawFunc {
	name: string;
	kind: "function" | "method" | "arrow";
	className?: string;
	line: number;
	endLine: number;
	statementCount: number;
	exported: boolean;
	signature: string;
	body?: ts.Node;
	enclosingClass?: string; // for resolving `this.X()` inside arrow funcs nested in methods
}

function extractFunctions(sf: ts.SourceFile): RawFunc[] {
	const out: RawFunc[] = [];

	// Track enclosing class for resolving this.X() calls
	// Stack because arrow functions inside methods inherit outer `this`
	const classStack: string[] = [];

	const visit = (node: ts.Node, parent: ts.Node | undefined) => {
		let pushedClass = false;
		// function declaration
		if (ts.isFunctionDeclaration(node) && node.name) {
			const { line: startLine } = sf.getLineAndCharacterOfPosition(node.getStart());
			const { line: endLine } = sf.getLineAndCharacterOfPosition(node.getEnd());
			out.push({
				name: node.name.text,
				kind: "function",
				className: classStack[classStack.length - 1],
				enclosingClass: classStack[classStack.length - 1],
				line: startLine + 1,
				endLine: endLine + 1,
				statementCount: node.body ? countStatements(node.body) : 0,
				exported: isExported(node.modifiers),
				signature: getSignature(node),
				body: node.body,
			});
		}
		// class declaration - recurse into methods
		if (ts.isClassDeclaration(node) && node.name) {
			const className = node.name.text;
			classStack.push(className);
			pushedClass = true;
			const classExported = isExported(node.modifiers);
			for (const member of node.members) {
				if (ts.isMethodDeclaration(member) && member.name) {
					const methodName = ts.isIdentifier(member.name) ? member.name.text : member.name.getText();
					const { line: startLine } = sf.getLineAndCharacterOfPosition(member.getStart());
					const { line: endLine } = sf.getLineAndCharacterOfPosition(member.getEnd());
					out.push({
						name: methodName,
						kind: "method",
						className,
						enclosingClass: className,
						line: startLine + 1,
						endLine: endLine + 1,
						statementCount: member.body ? countStatements(member.body) : 0,
						exported: classExported || isExported(member.modifiers),
						signature: getSignature(member),
						body: member.body,
					});
				}
			}
		}
		// const foo = (...) => ...  (VariableDeclaration w/ arrow or function expr)
		if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer) {
			const init = node.initializer;
			const isArrow = ts.isArrowFunction(init);
			const isFuncExpr = ts.isFunctionExpression(init);
			if (isArrow || isFuncExpr) {
				// need parent's modifiers to know export - check VariableStatement
				const exportFlag = parent && ts.isVariableStatement(parent) ? isExported(parent.modifiers) : false;
				const { line: startLine } = sf.getLineAndCharacterOfPosition(node.getStart());
				const { line: endLine } = sf.getLineAndCharacterOfPosition(node.getEnd());
				out.push({
					name: node.name.text,
					kind: "arrow",
					className: classStack[classStack.length - 1],
					enclosingClass: classStack[classStack.length - 1],
					line: startLine + 1,
					endLine: endLine + 1,
					statementCount: countStatements(init),
					exported: exportFlag,
					signature: getSignature(init as ts.SignatureDeclaration),
					body: init.body,
				});
			}
		}
		ts.forEachChild(node, (child) => visit(child, node));
		if (pushedClass) classStack.pop();
	};

	visit(sf, undefined);
	return out;
}

// Build symbol table (only counts exported + non-method for now; methods go via ClassName.method key)
for (const [canonical, sf] of sources) {
	const funcs = extractFunctions(sf);
	const local = new Map<string, { line: number; exported: boolean; kind: string; className?: string }>();
	for (const f of funcs) {
		const key = f.className ? `${f.className}.${f.name}` : f.name;
		local.set(key, { line: f.line, exported: f.exported, kind: f.kind, className: f.className });
	}
	symbolTable.set(canonical, local);

	// Also collect exports list for file-level info
	const exports = funcs.filter((f) => f.exported).map((f) => (f.className ? `${f.className}.${f.name}` : f.name));
	// Deduplicate
	fileImports.set(canonical, new Map()); // init empty for now, populated in Phase 2
}

// ---------- Phase 2: Resolve imports per file ----------

function resolveModuleSpecifier(spec: string, fromFile: string): string | null {
	if (!spec.startsWith(".")) return null; // external package
	// Replace .js with .ts (project uses .js ESM imports)
	let target = spec;
	if (target.endsWith(".js")) target = target.slice(0, -3) + ".ts";
	else if (!target.endsWith(".ts")) target = target + ".ts";
	const fromAbs = join(ROOT, fromFile);
	const resolved = resolve(dirname(fromAbs), target);
	const canonical = toCanonical(resolved);
	if (fileSet.has(canonical)) return canonical;
	// Try index.ts (directory import)
	const indexCanonical = toCanonical(join(resolved, "index.ts"));
	if (fileSet.has(indexCanonical)) return indexCanonical;
	return null;
}

for (const [canonical, sf] of sources) {
	const imports = new Map<string, { resolvedFile: string; importedName: string }>();
	for (const stmt of sf.statements) {
		if (!ts.isImportDeclaration(stmt)) continue;
		if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
		const spec = stmt.moduleSpecifier.text;
		const resolvedFile = resolveModuleSpecifier(spec, canonical);
		if (!resolvedFile) continue;

		const importClause = stmt.importClause;
		if (!importClause) continue;

		// Default import
		if (importClause.name) {
			imports.set(importClause.name.text, { resolvedFile, importedName: "default" });
		}
		// Named bindings
		if (importClause.namedBindings) {
			const nb = importClause.namedBindings;
			if (ts.isNamedImports(nb)) {
				for (const el of nb.elements) {
					const importedName = el.propertyName?.text ?? el.name.text;
					imports.set(el.name.text, { resolvedFile, importedName });
				}
			} else if (ts.isNamespaceImport(nb)) {
				imports.set(nb.name.text, { resolvedFile, importedName: "*" });
			}
		}
	}
	fileImports.set(canonical, imports);
}

// ---------- Phase 3: Extract functions + resolve calls ----------

const allFunctions: FunctionInfo[] = [];
// id -> FunctionInfo for quick lookup
const functionById = new Map<string, FunctionInfo>();

function resolveCallTarget(
	expr: ts.Expression,
	fromFile: string,
	enclosingClass?: string,
): { file: string; name: string } | null {
	const imports = fileImports.get(fromFile);
	if (!imports) return null;
	const localSyms = symbolTable.get(fromFile);

	// Direct identifier: foo()
	if (ts.isIdentifier(expr)) {
		const name = expr.text;
		// Local?
		if (localSyms?.has(name)) {
			return { file: fromFile, name };
		}
		// Imported?
		const imp = imports.get(name);
		if (imp) {
			// default or namespace - just point to file with that pseudo-name
			const target = imp.importedName === "*" ? "*" : imp.importedName;
			return { file: imp.resolvedFile, name: target };
		}
		return null;
	}

	// Property access: foo.bar() OR this.bar() OR foo.bar.baz()
	if (ts.isPropertyAccessExpression(expr)) {
		// Walk to root
		let root: ts.Expression = expr;
		while (ts.isPropertyAccessExpression(root)) root = root.expression;
		const methodName = expr.name.text;

		// `this.method()` inside a class method (or arrow inside one)
		if (root.kind === ts.SyntaxKind.ThisKeyword && enclosingClass) {
			const symName = `${enclosingClass}.${methodName}`;
			if (localSyms?.has(symName)) {
				return { file: fromFile, name: symName };
			}
			return null;
		}

		// `super.method()` — also resolve to local class (best-effort)
		if (root.kind === ts.SyntaxKind.SuperKeyword && enclosingClass) {
			const symName = `${enclosingClass}.${methodName}`;
			if (localSyms?.has(symName)) {
				return { file: fromFile, name: symName };
			}
			return null;
		}

		// Case 1: root is identifier, imported as value (e.g. ctx.foo())
		if (ts.isIdentifier(root)) {
			const rootName = root.text;
			const imp = imports.get(rootName);
			if (imp) {
				// We don't track method membership; point to file with className.methodName if symbol exists
				const targetSyms = symbolTable.get(imp.resolvedFile);
				// Try common class.method names; we don't know class, so try all classes for method
				if (targetSyms) {
					for (const [symName] of targetSyms) {
						if (symName.endsWith("." + methodName)) {
							return { file: imp.resolvedFile, name: symName };
						}
					}
				}
				// Fallback: file + method name (unqualified) — only if it looks like a known free function
				if (targetSyms?.has(methodName)) {
					return { file: imp.resolvedFile, name: methodName };
				}
				return null;
			}
			// Local root — could be local var or `this`. Try local symbols (class.method)
			if (localSyms) {
				for (const [symName] of localSyms) {
					if (symName.endsWith("." + methodName)) {
						return { file: fromFile, name: symName };
					}
				}
				if (localSyms.has(methodName)) {
					return { file: fromFile, name: methodName };
				}
			}
			return null;
		}
		// Other root shapes (call chain, etc.) - skip
		return null;
	}

	return null;
}

for (const [canonical, sf] of sources) {
	const raw = extractFunctions(sf);
	for (const f of raw) {
		const id = `${canonical}/${f.className ? f.className + "." : ""}${f.name}:${f.line}`;
		const callees: string[] = [];
		if (f.body) {
			const seen = new Set<string>();
			const visit = (n: ts.Node) => {
				if (ts.isCallExpression(n)) {
					const target = resolveCallTarget(n.expression, canonical, f.enclosingClass);
					if (target) {
						// Build target id (we may not know exact line; use first match)
						const targetSyms = symbolTable.get(target.file);
						if (targetSyms) {
							const sym = targetSyms.get(target.name);
							if (sym) {
								const targetId = `${target.file}/${target.name}:${sym.line}`;
								if (!seen.has(targetId)) {
									seen.add(targetId);
									callees.push(targetId);
								}
							}
						}
					}
				}
				ts.forEachChild(n, visit);
			};
			visit(f.body);
		}
		const info: FunctionInfo = {
			id,
			name: f.className ? `${f.className}.${f.name}` : f.name,
			kind: f.kind,
			className: f.className,
			file: canonical,
			line: f.line,
			endLine: f.endLine,
			statementCount: f.statementCount,
			exported: f.exported,
			signature: f.signature,
			callees,
		};
		allFunctions.push(info);
		functionById.set(id, info);
	}
}

// ---------- Phase 4: Assemble file-level info ----------

const files: FileInfo[] = [];
const fileEdges: Edge[] = [];

for (const [canonical, sf] of sources) {
	const content = sf.text;
	const lineCount = content.split("\n").length;
	const imports = fileImports.get(canonical)!;
	const functions = allFunctions
		.filter((f) => f.file === canonical)
		.map((f) => f.id);

	// exports: names of exported functions in this file
	const exports = allFunctions
		.filter((f) => f.file === canonical && f.exported)
		.map((f) => f.name);

	const dir = posix.dirname(canonical);
	files.push({
		path: canonical,
		lines: lineCount,
		dir,
		exports,
		imports: [...new Set([...imports.values()].map((v) => v.resolvedFile))],
		functions,
	});

	for (const imp of imports.values()) {
		fileEdges.push({ from: canonical, to: imp.resolvedFile, kind: "import" });
	}
}

// Function-level call edges
const functionEdges: Edge[] = [];
for (const f of allFunctions) {
	for (const callee of f.callees) {
		if (functionById.has(callee)) {
			functionEdges.push({ from: f.id, to: callee, kind: "call" });
		}
	}
}

// ---------- Phase 5: Reverse index for callers ----------

const callersByFunction = new Map<string, string[]>();
for (const f of allFunctions) {
	for (const callee of f.callees) {
		if (!functionById.has(callee)) continue;
		const arr = callersByFunction.get(callee) ?? [];
		arr.push(f.id);
		callersByFunction.set(callee, arr);
	}
}

const callersByFile = new Map<string, string[]>();
for (const fi of files) {
	for (const imp of fi.imports) {
		const arr = callersByFile.get(imp) ?? [];
		arr.push(fi.path);
		callersByFile.set(imp, arr);
	}
}

// ---------- Phase 6: Build HTML ----------

const data: Data = {
	files,
	functions: allFunctions,
	edges: [...fileEdges, ...functionEdges],
};

// Strip body resolution we don't need; also drop functions with no calls/very short bodies
// from the index — they still appear in outline but keep edges lean.
// (We've already collected everything; filtering happens at render.)

const payload = {
	files,
	functions: allFunctions.map((f) => ({
		id: f.id,
		name: f.name,
		kind: f.kind,
		file: f.file,
		line: f.line,
		endLine: f.endLine,
		statementCount: f.statementCount,
		exported: f.exported,
		signature: f.signature,
		callees: f.callees.filter((c) => functionById.has(c)),
	})),
	callers: Object.fromEntries(callersByFunction),
	fileCallers: Object.fromEntries(callersByFile),
};

const totalEdges = fileEdges.length + functionEdges.length;
const exportedCount = allFunctions.filter((f) => f.exported).length;

const html = buildHtml(payload, {
	fileCount: files.length,
	functionCount: allFunctions.length,
	exportedCount,
	edgeCount: totalEdges,
});

const outPath = join(ROOT, "docs", "visualization", "code-graph.html");
writeFileSync(outPath, html, "utf-8");

console.log(
	`✓ Wrote ${outPath}\n` +
	`  ${files.length} files · ${allFunctions.length} functions (${exportedCount} exported)\n` +
	`  ${fileEdges.length} import edges · ${functionEdges.length} call edges`,
);

// ============================================================
// HTML template (inline)
// ============================================================

function buildHtml(
	data: object,
	stats: { fileCount: number; functionCount: number; exportedCount: number; edgeCount: number },
): string {
	const dataJson = JSON.stringify(data);
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Zero-Core · 代码大纲与调用关系</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    margin: 0; padding: 16px;
    background: #0d1117; color: #c9d1d9;
    font-size: 13px;
  }
  h1 { margin: 0 0 4px; color: #f0f6fc; font-size: 18px; }
  .subtitle { color: #8b949e; margin-bottom: 12px; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  .stat {
    background: #161b22; border: 1px solid #30363d; border-radius: 4px;
    padding: 6px 12px; font-size: 11px;
  }
  .stat .num { color: #f0f6fc; font-weight: 600; font-size: 14px; }
  .stat .label { color: #8b949e; margin-left: 4px; }
  .tabs {
    display: flex; gap: 4px; margin-bottom: 12px;
    border-bottom: 1px solid #30363d; padding-bottom: 8px;
  }
  .tab-btn {
    background: transparent; color: #8b949e; border: 1px solid transparent;
    padding: 6px 14px; cursor: pointer; border-radius: 4px; font-size: 13px;
  }
  .tab-btn:hover { color: #c9d1d9; }
  .tab-btn.active { background: #21262d; color: #f0f6fc; border-color: #30363d; }
  .panel { display: none; }
  .panel.active { display: flex; gap: 12px; }
  .col { background: #161b22; border: 1px solid #30363d; border-radius: 4px; padding: 8px; overflow: auto; }
  .col-outline { width: 50%; max-height: 80vh; }
  .col-detail { width: 50%; max-height: 80vh; }
  .col-callees, .col-callers { width: 50%; max-height: 80vh; }
  input[type="search"] {
    width: 100%; padding: 6px 10px; background: #0d1117;
    border: 1px solid #30363d; border-radius: 4px;
    color: #c9d1d9; font-size: 13px; margin-bottom: 8px;
  }
  input[type="search"]:focus { outline: none; border-color: #58a6ff; }
  .tree { font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; }
  .tree ul { list-style: none; padding-left: 14px; margin: 0; }
  .tree > ul { padding-left: 0; }
  .tree li { padding: 1px 0; cursor: default; }
  .tree li.dir, .tree li.file { cursor: pointer; }
  .tree li.dir::before { content: "▸ "; color: #8b949e; }
  .tree li.dir.open::before { content: "▾ "; color: #8b949e; }
  .tree li.file::before { content: "📄 "; opacity: 0.5; }
  .tree li.fn::before { content: "  "; }
  .tree li .name { color: #c9d1d9; }
  .tree li.dir > .name { color: #79c0ff; font-weight: 500; }
  .tree li.file > .name { color: #d2a8ff; }
  .tree li.fn .name { color: #c9d1d9; }
  .tree li.fn .meta { color: #8b949e; font-size: 11px; margin-left: 8px; }
  .tree li.fn.exported > .name { color: #7ee787; }
  .tree li.match-hidden { display: none; }
  .tree li.selected > .name { background: #1f6feb33; border-radius: 2px; }
  .detail h3 { margin: 0 0 8px; color: #f0f6fc; font-size: 13px; }
  .detail .sig {
    font-family: monospace; background: #0d1117; padding: 8px;
    border-radius: 3px; border: 1px solid #30363d;
    color: #d2a8ff; font-size: 12px; margin-bottom: 8px;
    word-break: break-word;
  }
  .detail .loc { color: #8b949e; font-size: 11px; margin-bottom: 12px; }
  .edge-list { list-style: none; padding: 0; margin: 0; }
  .edge-list li {
    padding: 4px 6px; cursor: pointer; border-radius: 3px;
    font-family: monospace; font-size: 12px;
    border-bottom: 1px solid #21262d;
  }
  .edge-list li:hover { background: #21262d; }
  .edge-list .file { color: #8b949e; font-size: 11px; }
  .edge-list .name { color: #79c0ff; }
  .edge-list .empty { color: #8b949e; font-style: italic; padding: 8px; }
  .toggle {
    display: inline-flex; gap: 0; margin-bottom: 8px;
    border: 1px solid #30363d; border-radius: 4px; overflow: hidden;
  }
  .toggle button {
    background: transparent; color: #8b949e; border: 0;
    padding: 4px 12px; cursor: pointer; font-size: 12px;
  }
  .toggle button.active { background: #21262d; color: #f0f6fc; }
  .header-bar { display: flex; gap: 8px; align-items: center; }
  .header-bar h3 { flex: 1; margin: 0; }
  .badge {
    display: inline-block; background: #21262d; color: #8b949e;
    border-radius: 8px; padding: 1px 6px; font-size: 10px;
  }
  .footer {
    margin-top: 16px; color: #8b949e; font-size: 11px;
    border-top: 1px solid #30363d; padding-top: 8px;
  }
  code { background: #21262d; padding: 1px 4px; border-radius: 2px; font-size: 11px; }
</style>
</head>
<body>

<h1>Zero-Core · 代码大纲与调用关系</h1>
<div class="subtitle">基于静态分析 · 后端 src/{main,preload,runtime,server,core,shared}</div>

<div class="stats">
  <div class="stat"><span class="num">${stats.fileCount}</span><span class="label">files</span></div>
  <div class="stat"><span class="num">${stats.functionCount}</span><span class="label">functions</span></div>
  <div class="stat"><span class="num">${stats.exportedCount}</span><span class="label">exported</span></div>
  <div class="stat"><span class="num">${stats.edgeCount}</span><span class="label">edges</span></div>
</div>

<div class="tabs">
  <button class="tab-btn active" data-tab="outline">Outline</button>
  <button class="tab-btn" data-tab="calls">Calls</button>
</div>

<div id="panel-outline" class="panel active">
  <div class="col col-outline">
    <input type="search" id="outline-search" placeholder="filter (substring, e.g. sendPrompt, agent-loop, kb-)">
    <div class="tree" id="outline-tree"></div>
  </div>
  <div class="col col-detail detail" id="outline-detail">
    <div style="color:#8b949e;padding:8px;">点击左侧函数查看 callees 与 callers</div>
  </div>
</div>

<div id="panel-calls" class="panel">
  <div class="col col-callees">
    <div class="header-bar">
      <input type="search" id="calls-search" placeholder="搜索函数或文件 (e.g. sendPrompt, agent-loop.ts)">
    </div>
    <div class="toggle">
      <button class="active" data-mode="function">Function</button>
      <button data-mode="file">File</button>
    </div>
    <h3>调用了 (callees)</h3>
    <ul class="edge-list" id="calls-callees"><li class="empty">先选一个目标</li></ul>
  </div>
  <div class="col col-callers">
    <div class="header-bar"><h3>被调用 by (callers)</h3></div>
    <ul class="edge-list" id="calls-callers"><li class="empty">先选一个目标</li></ul>
  </div>
</div>

<div class="footer">
  生成命令: <code>npm run build:codegraph</code> · 数据来自静态分析，可能因动态 import / 高阶函数遗漏部分调用
</div>

<script>
const DATA = ${dataJson};

// ----- index helpers -----
const funcById = new Map(DATA.functions.map(f => [f.id, f]));
const fileByPath = new Map(DATA.files.map(f => [f.path, f]));
const fnCallers = DATA.callers;   // id -> [id]
const fileCallers = DATA.fileCallers; // path -> [path]

// function id -> file path
function idFile(id) { return id.split('/').slice(0, -1).join('/'); }
function shortFile(p) { return p.replace(/^src\\//, ''); }
function shortFnId(id) {
  // src/runtime/foo.ts:bar:42 -> foo.ts:bar:42
  const m = id.match(/([^/]+\\/[^/]+\\.ts)\\/(.+):(\\d+)$/);
  if (!m) return id;
  return m[1] + ' · ' + m[2] + ':' + m[3];
}

// ----- tree builder -----
const tree = document.getElementById('outline-tree');

// Build hierarchical view: { dirName, files: [], children: { subdir: {...} } }
function buildTree(files) {
  const root = { type: 'dir', name: '', children: {}, files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const d = parts[i];
      if (!node.children[d]) node.children[d] = { type: 'dir', name: d, children: {}, files: [] };
      node = node.children[d];
    }
    node.files.push(f);
  }
  return root;
}

function renderTree(node, parent, depth) {
  // Subdirs (sorted)
  const dirs = Object.values(node.children).sort((a, b) => a.name.localeCompare(b.name));
  for (const d of dirs) {
    const li = document.createElement('li');
    li.className = 'dir';
    li.dataset.name = (parent.dataset.name || '') + '/' + d.name;
    const span = document.createElement('span');
    span.className = 'name';
    span.textContent = d.name + '/';
    li.appendChild(span);
    const ul = document.createElement('ul');
    for (const sub of [...Object.values(d.children).sort((a,b)=>a.name.localeCompare(b.name)), ...d.files.sort((a,b)=>a.path.localeCompare(b.path))]) {
      // We'll re-render differently — handle below
    }
    // Render children
    const childUl = document.createElement('ul');
    const subdirs = Object.values(d.children).sort((a,b)=>a.name.localeCompare(b.name));
    for (const sd of subdirs) renderTreeDir(sd, childUl);
    for (const fi of d.files.sort((a,b)=>a.path.localeCompare(b.path))) renderTreeFile(fi, childUl);
    li.appendChild(childUl);
    childUl.style.display = 'none';
    span.onclick = (e) => {
      e.stopPropagation();
      li.classList.toggle('open');
      childUl.style.display = li.classList.contains('open') ? 'block' : 'none';
    };
    parent.appendChild(li);
  }
}

function renderTreeDir(d, parent) {
  const li = document.createElement('li');
  li.className = 'dir';
  li.dataset.name = (parent.closest('[data-name]')?.dataset.name || '') + '/' + d.name;
  const span = document.createElement('span');
  span.className = 'name';
  span.textContent = d.name + '/';
  li.appendChild(span);
  const childUl = document.createElement('ul');
  for (const sd of Object.values(d.children).sort((a,b)=>a.name.localeCompare(b.name))) renderTreeDir(sd, childUl);
  for (const fi of d.files.sort((a,b)=>a.path.localeCompare(b.path))) renderTreeFile(fi, childUl);
  childUl.style.display = 'none';
  li.appendChild(childUl);
  span.onclick = (e) => {
    e.stopPropagation();
    li.classList.toggle('open');
    childUl.style.display = li.classList.contains('open') ? 'block' : 'none';
  };
  parent.appendChild(li);
}

function renderTreeFile(fi, parent) {
  const li = document.createElement('li');
  li.className = 'file';
  li.dataset.path = fi.path;
  li.dataset.name = ' ' + fi.path; // for filter
  const span = document.createElement('span');
  span.className = 'name';
  span.textContent = shortFile(fi.path).split('/').pop() + '  ';
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = fi.lines + ' lines · ' + fi.functions.length + ' fns';
  li.appendChild(span);
  li.appendChild(meta);
  const ul = document.createElement('ul');
  ul.style.display = 'none';
  // Function children
  for (const fid of fi.functions) {
    const f = funcById.get(fid);
    if (!f) continue;
    const fli = document.createElement('li');
    fli.className = 'fn' + (f.exported ? ' exported' : '');
    fli.dataset.id = f.id;
    fli.dataset.name = ' ' + f.path + ' ' + f.name;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.name;
    const fmeta = document.createElement('span');
    fmeta.className = 'meta';
    fmeta.textContent = ':' + f.line + (f.statementCount > 0 ? ' · ' + f.statementCount + ' stmts' : '');
    fli.appendChild(name);
    fli.appendChild(fmeta);
    fli.onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll('.tree li.selected').forEach(n => n.classList.remove('selected'));
      fli.classList.add('selected');
      showDetail(f);
    };
    ul.appendChild(fli);
  }
  li.appendChild(ul);
  span.onclick = (e) => {
    e.stopPropagation();
    li.classList.toggle('open');
    ul.style.display = li.classList.contains('open') ? 'block' : 'none';
  };
  parent.appendChild(li);
}

const root = buildTree(DATA.files);
const rootUl = document.createElement('ul');
for (const d of Object.values(root.children).sort((a,b)=>a.name.localeCompare(b.name))) renderTreeDir(d, rootUl);
for (const fi of root.files.sort((a,b)=>a.path.localeCompare(b.path))) renderTreeFile(fi, rootUl);
tree.appendChild(rootUl);

// ----- filter -----
const search = document.getElementById('outline-search');
search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  document.querySelectorAll('.tree li').forEach(li => {
    const name = (li.dataset.name || '').toLowerCase();
    const match = !q || name.includes(q);
    li.classList.toggle('match-hidden', !match && q !== '');
    if (q && match) {
      // make sure ancestors visible
      let p = li.parentElement;
      while (p && p.tagName === 'UL') {
        p.style.display = 'block';
        if (p.parentElement) p.parentElement.classList.add('open');
        p = p.parentElement?.parentElement;
      }
    }
  });
});

// ----- detail panel -----
function showDetail(f) {
  const detail = document.getElementById('outline-detail');
  detail.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = f.name;
  detail.appendChild(h);
  const sig = document.createElement('div');
  sig.className = 'sig';
  sig.textContent = f.signature;
  detail.appendChild(sig);
  const loc = document.createElement('div');
  loc.className = 'loc';
  loc.textContent = shortFile(f.file) + ':' + f.line + '-' + f.endLine + ' · ' + f.statementCount + ' statements · ' + (f.exported ? 'exported' : 'private');
  detail.appendChild(loc);

  const calleesTitle = document.createElement('h3');
  calleesTitle.textContent = '调用了 (' + f.callees.length + ')';
  detail.appendChild(calleesTitle);
  const ul1 = document.createElement('ul');
  ul1.className = 'edge-list';
  if (f.callees.length === 0) {
    ul1.appendChild(makeEmpty('无 (或仅外部/动态调用)'));
  } else {
    const seen = new Set();
    for (const cid of f.callees) {
      if (seen.has(cid)) continue;
      seen.add(cid);
      const cf = funcById.get(cid);
      if (!cf) continue;
      ul1.appendChild(makeEdgeItem(cf, () => showDetail(cf)));
    }
  }
  detail.appendChild(ul1);

  const callers = fnCallers[f.id] || [];
  const callersTitle = document.createElement('h3');
  callersTitle.textContent = '被调用 by (' + callers.length + ')';
  detail.appendChild(callersTitle);
  const ul2 = document.createElement('ul');
  ul2.className = 'edge-list';
  if (callers.length === 0) {
    ul2.appendChild(makeEmpty('无 (entry point)'));
  } else {
    for (const cid of callers) {
      const cf = funcById.get(cid);
      if (!cf) continue;
      ul2.appendChild(makeEdgeItem(cf, () => showDetail(cf)));
    }
  }
  detail.appendChild(ul2);
}

function makeEdgeItem(f, onClick) {
  const li = document.createElement('li');
  const file = document.createElement('div');
  file.className = 'file';
  file.textContent = shortFile(f.file) + ':' + f.line;
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = f.name;
  li.appendChild(file);
  li.appendChild(name);
  li.onclick = onClick;
  return li;
}

function makeEmpty(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

// ----- tabs -----
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
  };
});

// ----- calls panel -----
let callsMode = 'function';
document.querySelectorAll('.toggle button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.toggle button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    callsMode = btn.dataset.mode;
    updateCalls();
  };
});

const callsSearch = document.getElementById('calls-search');
let callsTarget = null; // {mode, id}
callsSearch.addEventListener('input', () => {
  // try to find best match
  const q = callsSearch.value.trim().toLowerCase();
  if (!q) { callsTarget = null; updateCalls(); return; }
  if (callsMode === 'function') {
    // match by name OR id
    const exact = DATA.functions.find(f => f.name.toLowerCase() === q || f.id.toLowerCase() === q);
    const partials = DATA.functions.filter(f => f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q));
    const pick = exact || partials[0];
    if (pick) callsTarget = { mode: 'function', id: pick.id };
  } else {
    const exact = DATA.files.find(f => f.path.toLowerCase() === q || shortFile(f.path).toLowerCase() === q);
    const partials = DATA.files.filter(f => f.path.toLowerCase().includes(q));
    const pick = exact || partials[0];
    if (pick) callsTarget = { mode: 'file', id: pick.path };
  }
  updateCalls();
});

function updateCalls() {
  const calleesEl = document.getElementById('calls-callees');
  const callersEl = document.getElementById('calls-callers');
  calleesEl.innerHTML = '';
  callersEl.innerHTML = '';
  if (!callsTarget) {
    calleesEl.appendChild(makeEmpty('先选一个目标'));
    callersEl.appendChild(makeEmpty('先选一个目标'));
    return;
  }
  if (callsTarget.mode === 'function') {
    const f = funcById.get(callsTarget.id);
    if (!f) return;
    calleesEl.appendChild(makeLabelRow(f.name + ' · ' + shortFile(f.file) + ':' + f.line));
    const seen = new Set();
    for (const cid of f.callees) {
      if (seen.has(cid)) continue;
      seen.add(cid);
      const cf = funcById.get(cid);
      if (!cf) continue;
      calleesEl.appendChild(makeEdgeItem(cf, () => { callsTarget = { mode:'function', id: cf.id }; callsSearch.value = cf.name; updateCalls(); }));
    }
    if (f.callees.length === 0) calleesEl.appendChild(makeEmpty('无外部调用'));
    const callers = fnCallers[f.id] || [];
    for (const cid of callers) {
      const cf = funcById.get(cid);
      if (!cf) continue;
      callersEl.appendChild(makeEdgeItem(cf, () => { callsTarget = { mode:'function', id: cf.id }; callsSearch.value = cf.name; updateCalls(); }));
    }
    if (callers.length === 0) callersEl.appendChild(makeEmpty('无 (entry point)'));
  } else {
    const fi = fileByPath.get(callsTarget.id);
    if (!fi) return;
    calleesEl.appendChild(makeLabelRow(shortFile(fi.path)));
    for (const imp of fi.imports) {
      const tf = fileByPath.get(imp);
      calleesEl.appendChild(makeFileEdge(tf, () => { callsTarget = { mode:'file', id: imp }; callsSearch.value = shortFile(imp); updateCalls(); }));
    }
    if (fi.imports.length === 0) calleesEl.appendChild(makeEmpty('不依赖其他文件'));
    const callers = fileCallers[fi.path] || [];
    for (const cf of callers) {
      const ff = fileByPath.get(cf);
      if (!ff) continue;
      callersEl.appendChild(makeFileEdge(ff, () => { callsTarget = { mode:'file', id: cf }; callsSearch.value = shortFile(cf); updateCalls(); }));
    }
    if (callers.length === 0) callersEl.appendChild(makeEmpty('无被导入'));
  }
}

function makeLabelRow(text) {
  const li = document.createElement('li');
  li.style.background = '#21262d';
  li.style.color = '#f0f6fc';
  li.style.fontWeight = '600';
  li.style.fontFamily = 'monospace';
  li.textContent = text;
  return li;
}

function makeFileEdge(f, onClick) {
  const li = document.createElement('li');
  const file = document.createElement('div');
  file.className = 'file';
  file.textContent = f.path;
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = f.functions.length + ' fns · ' + f.lines + ' lines';
  li.appendChild(file);
  li.appendChild(name);
  li.onclick = onClick;
  return li;
}

updateCalls();
</script>

</body>
</html>
`;
}
