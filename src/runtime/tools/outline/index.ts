// 代码大纲提取器入口
//
// # 文件说明书
//
// ## 核心功能
// 根据文件语言选择对应的提取器，生成代码大纲树
//
// ## 输入
// 源代码文本、文件扩展名
//
// ## 输出
// OutlineResult，包含大纲节点树和语言信息
//
// ## 定位
// src/runtime/tools/outline/ — 大纲提取模块入口
//
// ## 依赖
// types.ts、各语言 extractor（TS/Python/JSON/MD/C/Java/Go/Rust/HTML）
//
// ## 维护规则
// 新增语言支持需在此注册对应的 extractor
//
import { OutlineResult, OutlineNode, LangExtractor } from "./types.js";
import { TypeScriptExtractor } from "./extractors/typescript.js";
import { PythonExtractor } from "./extractors/python.js";
import { JsonExtractor } from "./extractors/json.js";
import { MarkdownExtractor } from "./extractors/markdown.js";
import { CFamilyExtractor } from "./extractors/c-family.js";
import { JavaExtractor } from "./extractors/java.js";
import { GoExtractor } from "./extractors/go.js";
import { RustExtractor } from "./extractors/rust.js";
import { HtmlExtractor } from "./extractors/html.js";
import { CssExtractor } from "./extractors/css.js";
import { RubyExtractor } from "./extractors/ruby.js";
import { PhpExtractor } from "./extractors/php.js";
import { SwiftExtractor } from "./extractors/swift.js";
import { KotlinExtractor } from "./extractors/kotlin.js";
import { ScalaExtractor } from "./extractors/scala.js";
import { DartExtractor } from "./extractors/dart.js";
import { LuaExtractor } from "./extractors/lua.js";
import { ShellExtractor } from "./extractors/shell.js";
import { SqlExtractor } from "./extractors/sql.js";
import { ProtobufExtractor } from "./extractors/protobuf.js";
import { GraphqlExtractor } from "./extractors/graphql.js";
import { ElixirExtractor } from "./extractors/elixir.js";
import { RExtractor } from "./extractors/r-lang.js";
import { ZigExtractor } from "./extractors/zig.js";
import { NimExtractor } from "./extractors/nim.js";
import { YamlExtractor } from "./extractors/yaml.js";
import { TomlExtractor } from "./extractors/toml.js";
import { IniExtractor } from "./extractors/ini.js";
import { VueExtractor } from "./extractors/vue.js";
import { SvelteExtractor } from "./extractors/svelte.js";

const C_EXT = () => new CFamilyExtractor(false);
const CPP_EXT = () => new CFamilyExtractor(true);

const EXTRACTORS: Record<string, () => LangExtractor> = {
	// TypeScript / JavaScript
	ts: () => new TypeScriptExtractor(),
	tsx: () => new TypeScriptExtractor(),
	js: () => new TypeScriptExtractor(),
	jsx: () => new TypeScriptExtractor(),
	mjs: () => new TypeScriptExtractor(),
	cjs: () => new TypeScriptExtractor(),

	// Python
	py: () => new PythonExtractor(),
	pyw: () => new PythonExtractor(),

	// JSON
	json: () => new JsonExtractor(),
	jsonc: () => new JsonExtractor(),
	json5: () => new JsonExtractor(),

	// Markdown
	md: () => new MarkdownExtractor(),
	mdx: () => new MarkdownExtractor(),

	// C / C++
	c: C_EXT, h: C_EXT,
	cpp: CPP_EXT, hpp: CPP_EXT, cc: CPP_EXT, cxx: CPP_EXT,

	// Java
	java: () => new JavaExtractor(),

	// Go
	go: () => new GoExtractor(),

	// Rust
	rs: () => new RustExtractor(),

	// HTML / XML / SVG
	html: () => new HtmlExtractor(), htm: () => new HtmlExtractor(),
	xml: () => new HtmlExtractor(), svg: () => new HtmlExtractor(),

	// CSS / SCSS / SASS / Less
	css: () => new CssExtractor(), scss: () => new CssExtractor(),
	sass: () => new CssExtractor(), less: () => new CssExtractor(),

	// Ruby
	rb: () => new RubyExtractor(),

	// PHP
	php: () => new PhpExtractor(),

	// Swift
	swift: () => new SwiftExtractor(),

	// Kotlin
	kt: () => new KotlinExtractor(), kts: () => new KotlinExtractor(),

	// Scala
	scala: () => new ScalaExtractor(),

	// Dart
	dart: () => new DartExtractor(),

	// Lua
	lua: () => new LuaExtractor(),

	// Shell
	sh: () => new ShellExtractor(), bash: () => new ShellExtractor(), zsh: () => new ShellExtractor(),

	// SQL
	sql: () => new SqlExtractor(),

	// Protobuf
	proto: () => new ProtobufExtractor(),

	// GraphQL
	graphql: () => new GraphqlExtractor(), gql: () => new GraphqlExtractor(),

	// Elixir
	ex: () => new ElixirExtractor(), exs: () => new ElixirExtractor(),
	"elixir": () => new ElixirExtractor(),

	// R
	r: () => new RExtractor(), R: () => new RExtractor(),

	// Zig
	zig: () => new ZigExtractor(),

	// Nim
	nim: () => new NimExtractor(),

	// YAML
	yaml: () => new YamlExtractor(), yml: () => new YamlExtractor(),

	// TOML
	toml: () => new TomlExtractor(),

	// INI / Config / dotenv / Properties
	ini: () => new IniExtractor(), cfg: () => new IniExtractor(), conf: () => new IniExtractor(),
	env: () => new IniExtractor(), properties: () => new IniExtractor(),

	// Vue
	vue: () => new VueExtractor(),

	// Svelte
	svelte: () => new SvelteExtractor(),
};

const LANG_NAMES: Record<string, string> = {
	ts: "TypeScript", tsx: "TypeScript (TSX)", js: "JavaScript", jsx: "JavaScript (JSX)",
	mjs: "JavaScript (ESM)", cjs: "JavaScript (CJS)",
	py: "Python", pyw: "Python",
	json: "JSON", jsonc: "JSONC", json5: "JSON5",
	md: "Markdown", mdx: "MDX",
	c: "C", h: "C Header", cpp: "C++", hpp: "C++ Header", cc: "C++", cxx: "C++",
	java: "Java",
	go: "Go",
	rs: "Rust",
	html: "HTML", htm: "HTML", xml: "XML", svg: "SVG",
	css: "CSS", scss: "SCSS", sass: "SASS", less: "Less",
	rb: "Ruby",
	php: "PHP",
	swift: "Swift",
	kt: "Kotlin", kts: "Kotlin Script",
	scala: "Scala",
	dart: "Dart",
	lua: "Lua",
	sh: "Shell", bash: "Bash", zsh: "Zsh",
	sql: "SQL",
	proto: "Protobuf",
	graphql: "GraphQL", gql: "GraphQL",
	ex: "Elixir", exs: "Elixir Script", elixir: "Elixir",
	r: "R", R: "R",
	zig: "Zig",
	nim: "Nim",
	yaml: "YAML", yml: "YAML",
	toml: "TOML",
	ini: "INI", cfg: "Config", conf: "Config", env: "dotenv", properties: "Properties",
	vue: "Vue",
	svelte: "Svelte",
};

export function extractOutline(file: string, source: string): OutlineResult {
	const ext = getExtension(file);
	const factory = EXTRACTORS[ext];
	const language = LANG_NAMES[ext] || "Unknown";
	const totalLines = source.split("\n").length;

	if (!factory) {
		return { file, language, totalLines, nodes: fallbackExtract(source) };
	}

	const extractor = factory();
	const nodes = extractor.extract(source);
	return { file, language, totalLines, nodes };
}


function getExtension(path: string): string {
	const lastDot = path.lastIndexOf(".");
	if (lastDot < 0) return "";
	// Handle .env.local, .env.production etc.
	const basename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	if (basename.startsWith(".env")) return "env";
	return path.slice(lastDot + 1).toLowerCase();
}

function fallbackExtract(source: string): OutlineNode[] {
	const lines = source.split("\n");
	const nodes: OutlineNode[] = [];
	let segStart = -1;

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed) {
			if (segStart < 0) segStart = i;
		} else {
			if (segStart >= 0) {
				nodes.push({
					kind: "segment",
					name: lines[segStart].trim().slice(0, 60),
					line: segStart + 1,
					endLine: i,
					children: [],
				});
				segStart = -1;
			}
		}
	}

	if (segStart >= 0) {
		nodes.push({
			kind: "segment",
			name: lines[segStart].trim().slice(0, 60),
			line: segStart + 1,
			endLine: lines.length,
			children: [],
		});
	}

	return nodes;
}
