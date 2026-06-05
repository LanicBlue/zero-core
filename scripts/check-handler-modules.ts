// IPC Handler 模块依赖静态检查
//
// # 文件说明书
//
// ## 核心功能
// 静态分析所有 typedHandle/registerCrud handler，确保声明的模块依赖与实际访问一致
//
// ## 输入
// src/main/ipc/ 下所有 handler 源码
//
// ## 输出
// 检查结果（缺失模块声明警告）
//
// ## 定位
// scripts/ — 构建脚本，CI 质量检查
//
// ## 依赖
// typescript（TS AST 解析）
//
// ## 维护规则
// 新增 IPC handler 模式需确保此检查能覆盖
//
// Static check: ensure every typedHandle/registerCrud handler declares all
// the modules it actually accesses on ctx.
//
// Catches the bug class where a handler accesses ctx.providerStore but only
// declares ["agentService"] in the modules array — the handler can run
// before providerStore is initialized and crash on undefined access.
//
// Run: npm run check:handlers

import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const ipcDir = join(root, "src", "main", "ipc");
const FILES = readdirSync(ipcDir)
	.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
	.map((f) => join(ipcDir, f));

// ModuleName union from src/main/ipc/module-readiness.ts
const MODULE_NAMES = new Set([
	"sessionDb", "agentStore", "providerStore", "templateStore",
	"mcpStore", "kbStore", "kbDb", "agentToolStore", "workspaceConfig",
	"registry", "toolRegistry", "agentService", "mcpManager", "recovery",
]);

// ctx fields that aren't modules and don't need to be declared in modules array
const NON_MODULE_CTX_FIELDS = new Set([
	"win", "modulesReady", "whenReady", "isModuleReady",
	"toFileURL", "distServer", "distCore",
	"buildDefaultPrompt", "saveWorkspaceConfig", "createAgentService",
]);

interface Finding {
	file: string;
	line: number;
	channel: string;
	accessed: string[];
	declared: string[];
}

const findings: Finding[] = [];

function extractCtxAccess(node: ts.Node): Set<string> {
	const access = new Set<string>();
	const visit = (n: ts.Node) => {
		// Match ctx.X (PropertyAccessExpression where expression is identifier "ctx")
		if (ts.isPropertyAccessExpression(n) &&
			ts.isIdentifier(n.expression) &&
			n.expression.text === "ctx") {
			access.add(n.name.text);
		}
		// Also match destructure: const { foo, bar } = ctx
		if (ts.isVariableDeclaration(n) &&
			ts.isObjectBindingPattern(n.name) &&
			n.initializer && ts.isIdentifier(n.initializer) &&
			n.initializer.text === "ctx") {
			for (const el of n.name.elements) {
				// propertyName is set when aliased: { foo: bar } = ctx
				const fieldName = el.propertyName ?? el.name;
				if (ts.isIdentifier(fieldName)) access.add(fieldName.text);
			}
		}
		ts.forEachChild(n, visit);
	};
	visit(node);
	return access;
}

function getCallName(node: ts.Node): string | null {
	if (ts.isIdentifier(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	return null;
}

function getStringLiteral(node: ts.Node): string | null {
	if (ts.isStringLiteral(node)) return node.text;
	if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	return null;
}

function extractModulesArray(arg: ts.Node): string[] | null {
	if (ts.isArrayLiteralExpression(arg)) {
		return arg.elements.map(getStringLiteral).filter((s): s is string => s !== null);
	}
	// Single string literal: modules: "agentService"
	const single = getStringLiteral(arg);
	if (single) return [single];
	return null;
}

function checkTypedHandle(node: ts.CallExpression, sourceFile: ts.SourceFile, file: string) {
	const args = node.arguments;
	if (args.length < 3) return;

	const channelArg = args[0];
	const modsArg = args[1];
	const handlerArg = args[2];

	const channel = getStringLiteral(channelArg) ?? channelArg.getText();
	const declared = extractModulesArray(modsArg) ?? [];
	const accessed = extractCtxAccess(handlerArg);

	// Filter: only flag fields that are real modules
	const undeclared = [...accessed].filter(
		(f) => MODULE_NAMES.has(f) && !declared.includes(f) && !NON_MODULE_CTX_FIELDS.has(f),
	);

	if (undeclared.length > 0) {
		const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
		findings.push({ file, line: line + 1, channel, accessed: undeclared, declared });
	}
}

function checkRegisterCrud(node: ts.CallExpression, sourceFile: ts.SourceFile, file: string) {
	// registerCrud({ channel, store: () => ctx.X, module: "X", ... })
	if (node.arguments.length === 0) return;
	const opts = node.arguments[0];
	if (!ts.isObjectLiteralExpression(opts)) return;

	let declaredModule: string | null = null;
	let storeFactory: ts.Node | null = null;

	for (const prop of opts.properties) {
		if (!ts.isPropertyAssignment(prop)) continue;
		const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
		if (name === "module") declaredModule = getStringLiteral(prop.initializer);
		if (name === "store") storeFactory = prop.initializer;
	}

	if (!storeFactory) return;

	const accessed = extractCtxAccess(storeFactory);
	// Filter to real modules
	const storeFields = [...accessed].filter((f) => MODULE_NAMES.has(f));

	if (storeFields.length === 0) return; // store doesn't use ctx (unusual but possible)
	if (declaredModule && storeFields.includes(declaredModule)) return;

	const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
	findings.push({
		file,
		line: line + 1,
		channel: `registerCrud(${declaredModule ?? "no module"})`,
		accessed: storeFields,
		declared: declaredModule ? [declaredModule] : [],
	});
}

function visitFile(file: string) {
	const source = readFileSync(file, "utf-8");
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node)) {
			const name = getCallName(node.expression);
			if (name === "typedHandle") checkTypedHandle(node, sourceFile, file);
			if (name === "registerCrud") checkRegisterCrud(node, sourceFile, file);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
}

for (const file of FILES) visitFile(file);

if (findings.length === 0) {
	console.log("✓ All handlers declare their ctx module access correctly.");
	process.exit(0);
}

console.log(`✗ Found ${findings.length} handler(s) with undeclared ctx access:\n`);
for (const f of findings) {
	const relPath = f.file.replace(root + "\\", "").replace(/\\/g, "/");
	console.log(`  ${relPath}:${f.line}`);
	console.log(`    channel: ${f.channel}`);
	console.log(`    declared: [${f.declared.map((s) => `"${s}"`).join(", ")}]`);
	console.log(`    undeclared access: ${f.accessed.map((s) => `ctx.${s}`).join(", ")}`);
	console.log();
}
process.exit(1);
