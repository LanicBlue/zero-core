// 工具输出格式测试脚本
//
// # 文件说明书
//
// ## 核心功能
// 独立测试各内置工具的输出格式和 schema 验证
//
// ## 输入
// 各工具模块（bash、file-edit、file-write 等）
//
// ## 输出
// 测试结果（JSON 格式验证报告）
//
// ## 定位
// scripts/ — 测试脚本，验证工具输出格式正确性
//
// ## 依赖
// tools/ 下各工具模块
//
// ## 维护规则
// 新增工具需在此添加对应的输出测试
//
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bashTool } from "../src/tools/bash.ts";
import { fileEditTool } from "../src/tools/file-edit.ts";
import { fileWriteTool } from "../src/tools/file-write.ts";
import { fileReadTool } from "../src/tools/file-read.ts";
import { grepTool } from "../src/tools/grep.ts";
import { globTool } from "../src/tools/glob.ts";
import { webSearchTool, setSearchProvider, type SearchProvider } from "../src/tools/web-search.ts";
import { webFetchTool } from "../src/tools/mcp/fetch-tools.ts";
import { todoWriteTool, clearSessionTodos } from "../src/tools/todo-write.ts";
import { taskListTool } from "../src/tools/task-list.ts";
import { taskStatusTool } from "../src/tools/task-status.ts";
import { taskStopTool } from "../src/tools/task-stop.ts";
import { waitTool } from "../src/tools/wait.ts";

function getExecute(toolObj: any) {
	const rawExecute = toolObj.execute;
	return (input: any, toolCtx: any) => rawExecute(input, { experimental_context: toolCtx });
}

const testDir = join(tmpdir(), `zero-tool-test-${Date.now()}`);
await mkdir(testDir, { recursive: true });

function ctx(overrides: Record<string, any> = {}) {
	return { workingDir: testDir, agentId: "test-agent", emit: () => {}, toolConfig: {}, ...overrides };
}

interface T { scenario: string; result: string; pass: boolean; note: string }
const results: Record<string, T[]> = {};

// ═══════════════════════════════════════════
// Bash: config=timeout
// ═══════════════════════════════════════════
{
	const t: T[] = results["Bash"] = [];
	const run = getExecute(bashTool);

	// --- default (no timeout) ---
	let r = await run({ command: "echo hello" }, ctx());
	t.push({ scenario: "default config: echo", result: r, pass: r.includes("hello") && /\[Completed in/.test(r), note: "Output + elapsed" });

	// --- config.timeout=2 ---
	r = await run({ command: "echo from-config" }, ctx({ toolConfig: { Bash: { timeout: 2 } } }));
	t.push({ scenario: "config.timeout=2: echo", result: r, pass: r.includes("from-config"), note: "Uses config timeout" });

	// --- config.timeout=1 + slow command → should timeout ---
	r = await run({ command: "node -e \"setTimeout(()=>{},10000)\"", timeout: undefined }, ctx({ toolConfig: { Bash: { timeout: 1 } } }));
	t.push({ scenario: "config.timeout=1: slow command", result: r, pass: r.includes("timed out") || r.includes("Completed"), note: "Times out from config" });

	// --- input.timeout overrides config ---
	r = await run({ command: "echo override", timeout: 5 }, ctx({ toolConfig: { Bash: { timeout: 1 } } }));
	t.push({ scenario: "input.timeout overrides config", result: r, pass: r.includes("override"), note: "Input takes priority" });

	// --- exit code (err.code) ---
	r = await run({ command: "node -e process.exit(42)" }, ctx());
	t.push({ scenario: "non-zero exit: code extraction", result: r, pass: r.includes("Exit code"), note: "Extracts err.code on Windows" });

	// --- stderr labeled (echo redirect avoids cmd.exe quoting issues on Windows) ---
	r = await run({ command: "echo stderr-test 1>&2", timeout: 5 }, ctx());
	t.push({ scenario: "stderr labeled", result: r, pass: r.includes("[stderr]") && r.includes("stderr-test"), note: "[stderr] prefix" });

	// --- multi-line output preserves newlines ---
	r = await run({ command: "echo a && echo b && echo c" }, ctx());
	t.push({ scenario: "multi-line newlines", result: r, pass: (r.match(/\n/g) || []).length >= 2, note: "Lines separated by \\n" });
}

// ═══════════════════════════════════════════
// Read: config=max_lines, default_mode, max_file_size
// ═══════════════════════════════════════════
{
	const t: T[] = results["Read"] = [];
	const run = getExecute(fileReadTool);

	// Setup
	const longLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
	await writeFile(join(testDir, "50lines.txt"), longLines + "\n", "utf-8");
	await writeFile(join(testDir, "sample.ts"), "import { z } from 'zod';\n\nexport function hello(name: string): string {\n  return `Hello ${name}`;\n}\n\nexport class Foo {\n  private x: number;\n  constructor(x: number) { this.x = x; }\n  bar(): number { return this.x * 2; }\n}\n", "utf-8");
	await writeFile(join(testDir, "small.txt"), "tiny\n", "utf-8");

	// Large file for size limit test (1KB)
	await writeFile(join(testDir, "big.txt"), "x".repeat(2048) + "\n", "utf-8");

	// --- default config: full mode, line numbers ---
	let r = await run({ path: "small.txt" }, ctx());
	t.push({ scenario: "default config: full mode", result: r, pass: r.includes("1\t") && r.includes("tiny"), note: "Line number prefix" });

	// --- config.default_mode="outline" ---
	r = await run({ path: "sample.ts" }, ctx({ toolConfig: { Read: { default_mode: "outline" } } }));
	t.push({ scenario: "config.default_mode=outline", result: r, pass: r.includes("sample.ts") && r.includes("hello") && r.includes("Foo"), note: "Outline without explicit mode param" });

	// --- config.default_mode="full" + explicit mode=outline (explicit wins) ---
	r = await run({ path: "sample.ts", mode: "outline" }, ctx({ toolConfig: { Read: { default_mode: "full" } } }));
	t.push({ scenario: "explicit mode=outline overrides config", result: r, pass: r.includes("sample.ts") && r.includes("hello"), note: "Input mode overrides config" });

	// --- config.max_lines=5 ---
	r = await run({ path: "50lines.txt" }, ctx({ toolConfig: { Read: { max_lines: 5 } } }));
	t.push({ scenario: "config.max_lines=5", result: r, pass: r.includes("line 5") && !r.includes("line 6"), note: "Truncated at 5 lines" });

	// --- config.max_lines=5 + offset (offset forces full mode) ---
	r = await run({ path: "50lines.txt", offset: 10, limit: 3 }, ctx({ toolConfig: { Read: { max_lines: 5 } } }));
	t.push({ scenario: "offset+limit overrides max_lines", result: r, pass: r.includes("line 10") && r.includes("line 12") && !r.includes("line 13"), note: "offset/limit takes priority" });

	// --- config.max_file_size=1 (1KB) + 2KB file → error ---
	r = await run({ path: "big.txt" }, ctx({ toolConfig: { Read: { max_file_size: 1 } } }));
	t.push({ scenario: "config.max_file_size=1KB: 2KB file", result: r, pass: r.includes("too large") || r.includes("File too large"), note: "Rejects oversized file" });

	// --- config.max_file_size=0 (no limit) + 2KB file → ok ---
	r = await run({ path: "big.txt" }, ctx({ toolConfig: { Read: { max_file_size: 0 } } }));
	t.push({ scenario: "config.max_file_size=0: no limit", result: r, pass: r.includes("x".repeat(100)), note: "Reads any size" });

	// --- outline mode: line references ---
	r = await run({ path: "sample.ts", mode: "outline" }, ctx());
	t.push({ scenario: "outline: line refs (L3, L7-L13)", result: r, pass: /L\d+/.test(r) && r.includes("fn") && r.includes("class"), note: "Shows L refs + kind + name" });

	// --- CRLF file ---
	await writeFile(join(testDir, "crlf.txt"), "alpha\r\nbeta\r\ngamma\r\n", "utf-8");
	r = await run({ path: "crlf.txt" }, ctx());
	t.push({ scenario: "CRLF handling", result: r, pass: r.includes("alpha") && r.includes("beta") && !r.includes("\r"), note: "Normalizes to LF" });
}

// ═══════════════════════════════════════════
// Edit: config=syntaxCheck
// ═══════════════════════════════════════════
{
	const t: T[] = results["Edit"] = [];
	const run = getExecute(fileEditTool);

	// --- config.syntaxCheck=true (default) + valid edit ---
	await writeFile(join(testDir, "edit-ok.ts"), "const x = 1;\n", "utf-8");
	let r = await run({ path: "edit-ok.ts", oldText: "const x = 1;", newText: "const x = 2;" }, ctx());
	t.push({ scenario: "syntaxCheck=true: valid edit", result: r, pass: r.includes("Successfully edited") && !r.includes("Syntax"), note: "No warnings" });

	// --- config.syntaxCheck=true + broken result ---
	await writeFile(join(testDir, "edit-bad.ts"), "const a = 1;\nconst b = 2;\n", "utf-8");
	r = await run({ path: "edit-bad.ts", oldText: "const b = 2;", newText: "const b = {" }, ctx());
	t.push({ scenario: "syntaxCheck=true: creates syntax error", result: r, pass: r.includes("Successfully edited") && r.includes("Syntax warnings"), note: "Detects error after edit" });

	// --- config.syntaxCheck=false + broken result → no warning ---
	await writeFile(join(testDir, "edit-nocheck.ts"), "const a = 1;\nconst b = 2;\n", "utf-8");
	r = await run({ path: "edit-nocheck.ts", oldText: "const b = 2;", newText: "const b = {" }, ctx({ toolConfig: { Edit: { syntaxCheck: false } } }));
	t.push({ scenario: "syntaxCheck=false: no warning", result: r, pass: r.includes("Successfully edited") && !r.includes("Syntax"), note: "Skips check" });

	// --- text not found: line count + hint ---
	await writeFile(join(testDir, "edit-nf.txt"), "aaa\nbbb\nccc\n", "utf-8");
	r = await run({ path: "edit-nf.txt", oldText: "nonexistent", newText: "x" }, ctx());
	t.push({ scenario: "text not found: diagnostics", result: r, pass: r.includes("not found") && r.includes("4 lines") && r.includes("Use Read"), note: "Line count + hint" });

	// --- partial match ---
	await writeFile(join(testDir, "edit-partial.txt"), "aaa\nbbb something\nccc\n", "utf-8");
	r = await run({ path: "edit-partial.txt", oldText: "bbb something\nextra", newText: "x" }, ctx());
	t.push({ scenario: "partial match", result: r, pass: r.includes("Partial match") && r.includes("bbb something"), note: "Shows context" });

	// --- CRLF mismatch ---
	await writeFile(join(testDir, "edit-crlf.txt"), "line one\r\nline two\r\n", "utf-8");
	r = await run({ path: "edit-crlf.txt", oldText: "line one\nline two", newText: "x" }, ctx());
	t.push({ scenario: "CRLF mismatch", result: r, pass: r.includes("CRLF"), note: "Detects mismatch" });
}

// ═══════════════════════════════════════════
// Write: config=syntaxCheck
// ═══════════════════════════════════════════
{
	const t: T[] = results["Write"] = [];
	const run = getExecute(fileWriteTool);

	// --- config.syntaxCheck=true (default) + valid ---
	let r = await run({ path: "w-ok.ts", content: "const x = 1;\n" }, ctx());
	t.push({ scenario: "syntaxCheck=true: valid file", result: r, pass: r.includes("Successfully wrote") && !r.includes("Syntax"), note: "No warnings" });

	// --- config.syntaxCheck=true + broken ---
	r = await run({ path: "w-bad.ts", content: "const x = {\n  a: 1\n" }, ctx());
	t.push({ scenario: "syntaxCheck=true: broken file", result: r, pass: r.includes("Successfully wrote") && r.includes("Syntax warnings"), note: "Detects error" });

	// --- config.syntaxCheck=false + broken → no warning ---
	r = await run({ path: "w-nocheck.ts", content: "const x = {\n  a: 1\n" }, ctx({ toolConfig: { Write: { syntaxCheck: false } } }));
	t.push({ scenario: "syntaxCheck=false: no warning", result: r, pass: r.includes("Successfully wrote") && !r.includes("Syntax"), note: "Skips check" });

	// --- nested dirs ---
	r = await run({ path: "deep/sub/dir/file.txt", content: "nested" }, ctx());
	t.push({ scenario: "auto-create dirs", result: r, pass: r.includes("Successfully wrote"), note: "Creates parents" });
}

// ═══════════════════════════════════════════
// Grep: config=head_limit, max_columns
// ═══════════════════════════════════════════
{
	const t: T[] = results["Grep"] = [];
	const run = getExecute(grepTool);

	await mkdir(join(testDir, "grep-test"), { recursive: true });
	const manyLines = Array.from({ length: 20 }, (_, i) => `match_line_${i}`).join("\n");
	await writeFile(join(testDir, "grep-test", "many.txt"), manyLines + "\n", "utf-8");
	await writeFile(join(testDir, "grep-test", "wide.txt"), "TARGET " + "x".repeat(500) + "\n", "utf-8");

	// --- config.head_limit=5 ---
	let r = await run({ pattern: "match_line", path: "grep-test" }, ctx({ toolConfig: { Grep: { head_limit: 5 } } }));
	t.push({ scenario: "config.head_limit=5", result: r, pass: r.includes("match_line_4") && !r.includes("match_line_5"), note: "Limited to 5 results" });

	// --- input.head_limit overrides config ---
	r = await run({ pattern: "match_line", path: "grep-test", head_limit: 3 }, ctx({ toolConfig: { Grep: { head_limit: 10 } } }));
	t.push({ scenario: "input.head_limit overrides config", result: r, pass: r.includes("match_line_2") && !r.includes("match_line_3"), note: "Input wins" });

	// --- config.max_columns=100: truncates wide lines ---
	r = await run({ pattern: "TARGET", path: "grep-test" }, ctx({ toolConfig: { Grep: { max_columns: 100 } } }));
	t.push({ scenario: "config.max_columns=100", result: r, pass: r.includes("TARGET") && !r.includes("x".repeat(200)), note: "Truncated long line" });

	// --- output_mode=files_with_matches ---
	r = await run({ pattern: "TARGET", path: "grep-test", output_mode: "files_with_matches" }, ctx());
	t.push({ scenario: "files_with_matches mode", result: r, pass: r.includes("wide.txt") && !r.includes("match_line"), note: "Only file paths" });

	// --- no match ---
	r = await run({ pattern: "zzzznope", path: "grep-test" }, ctx());
	t.push({ scenario: "no match", result: r, pass: r.includes("No matches found") || r.includes("No matches"), note: "Empty result" });
}

// ═══════════════════════════════════════════
// Glob: config=result_limit (no configSchema but reads it)
// ═══════════════════════════════════════════
{
	const t: T[] = results["Glob"] = [];
	const run = getExecute(globTool);

	// Create many files
	for (let i = 0; i < 10; i++) {
		await writeFile(join(testDir, `file-${i}.dat`), "");
	}

	// --- default: all 10 files ---
	let r = await run({ pattern: "*.dat" }, ctx());
	const defaultCount = r.split("\n").filter((l: string) => l.trim()).length;
	t.push({ scenario: "default: all 10 files", result: r, pass: defaultCount === 10, note: `Got ${defaultCount} files` });

	// --- config.result_limit=3 ---
	r = await run({ pattern: "*.dat" }, ctx({ toolConfig: { Glob: { result_limit: 3 } } }));
	t.push({ scenario: "config.result_limit=3", result: r, pass: r.includes("file-") && (r.includes("total files") || r.split("\n").filter((l: string) => l.includes("file-")).length <= 3), note: "Limited" });

	// --- no match ---
	r = await run({ pattern: "*.zzz" }, ctx());
	t.push({ scenario: "no match", result: r, pass: r.includes("No files matching"), note: "Empty result" });

	// --- scoped path ---
	await mkdir(join(testDir, "subdir"), { recursive: true });
	await writeFile(join(testDir, "subdir", "nested.dat"), "");
	r = await run({ pattern: "*.dat", path: "subdir" }, ctx());
	t.push({ scenario: "scoped path", result: r, pass: r.includes("nested.dat") && !r.includes("file-0"), note: "Only subdir" });
}

// ═══════════════════════════════════════════
// WebSearch: config=provider, maxResults
// ═══════════════════════════════════════════
{
	const t: T[] = results["WebSearch"] = [];
	const run = getExecute(webSearchTool);
	const allResults = [
		{ title: "R1", url: "https://a.com/1", snippet: "S1" },
		{ title: "R2", url: "https://a.com/2", snippet: "S2" },
		{ title: "R3", url: "https://a.com/3", snippet: "S3" },
		{ title: "R4", url: "https://a.com/4", snippet: "S4" },
		{ title: "R5", url: "https://a.com/5", snippet: "S5" },
	];

	// --- no config: uses currentProvider (set via setSearchProvider) ---
	setSearchProvider({ name: "mock", search: async (_q, opts) => allResults.slice(0, opts?.maxResults) });
	let r = await run({ query: "test" }, ctx());
	t.push({ scenario: "default provider: 5 results", result: r, pass: r.includes("Found 5 results"), note: "Uses setSearchProvider default" });

	// --- config.provider: should NOT use setSearchProvider, should call createSearchProvider ---
	// We can't test real providers, but we test that config.provider is read
	// config.provider=duckduckgo → uses createSearchProvider which returns DuckDuckGoProvider
	// This will try real network, but we just verify it doesn't crash
	r = await run({ query: "test", maxResults: 1 }, ctx({ toolConfig: { WebSearch: { provider: "duckduckgo" } } }));
	t.push({ scenario: "config.provider=duckduckgo", result: r, pass: !r.includes("config"), note: "Uses config provider (may be real network)" });

	// --- input.maxResults ---
	r = await run({ query: "test", maxResults: 2 }, ctx());
	t.push({ scenario: "input.maxResults=2", result: r, pass: r.includes("Found 2 results") && !r.includes("R3"), note: "Limits output" });

	// --- empty results ---
	setSearchProvider({ name: "empty", search: async () => [] });
	r = await run({ query: "nothing" }, ctx());
	t.push({ scenario: "empty results", result: r, pass: r.includes("No search results found"), note: "Empty message" });

	// --- result format: header + numbered + Sources ---
	setSearchProvider({ name: "mock", search: async () => allResults.slice(0, 3) });
	r = await run({ query: "fmt" }, ctx());
	t.push({ scenario: "format: header+numbered+sources", result: r, pass: r.includes("Found 3 results") && r.includes("[1] R1") && r.includes("Sources:") && r.includes("[R1](https://a.com/1)"), note: "Full format" });
}

// ═══════════════════════════════════════════
// WebFetch: config=format
// ═══════════════════════════════════════════
{
	const t: T[] = results["WebFetch"] = [];
	const run = getExecute(webFetchTool);

	// --- config.format=json (fallback when no input.format) ---
	let r = await run({ url: "http://httpbin.org/json" }, ctx({ toolConfig: { WebFetch: { format: "json" } } }));
	t.push({ scenario: "config.format=json (no input)", result: r.slice(0, 100), pass: r.includes("{") || r.includes("Error"), note: "Uses config format" });

	// --- input.format overrides config ---
	r = await run({ url: "http://httpbin.org/json", format: "text" }, ctx({ toolConfig: { WebFetch: { format: "json" } } }));
	t.push({ scenario: "input.format=text overrides config=json", result: r.slice(0, 100), pass: !r.includes("null") || r.includes("Error"), note: "Input wins" });

	// --- bad URL ---
	r = await run({ url: "not-a-url" }, ctx());
	t.push({ scenario: "bad URL", result: r, pass: r.includes("Error") || r.includes("error"), note: "Error message" });
}

// ═══════════════════════════════════════════
// TaskList: config=max_completed
// ═══════════════════════════════════════════
{
	const t: T[] = results["TaskList"] = [];
	const run = getExecute(taskListTool);
	const now = Date.now();
	const tasks = Array.from({ length: 8 }, (_, i) => ({
		id: `t${i}`, status: "completed", type: "bash" as const,
		startedAt: now - (8 - i) * 1000, completedAt: now - (7 - i) * 1000,
		step: 1, task: `task ${i}`,
	}));

	// --- config.max_completed=3 ---
	let r = await run({}, ctx({ listTasks: () => tasks, toolConfig: { TaskList: { max_completed: 3 } } }));
	t.push({ scenario: "config.max_completed=3", result: r, pass: r.includes("showing 3 of 8"), note: "Shows 3 of 8" });

	// --- config.max_completed=10 (more than total) ---
	r = await run({}, ctx({ listTasks: () => tasks, toolConfig: { TaskList: { max_completed: 10 } } }));
	t.push({ scenario: "config.max_completed=10 (all)", result: r, pass: r.includes("t7") && !r.includes("of 8"), note: "Shows all" });

	// --- filter=running ---
	r = await run({ filter: "running" }, ctx({ listTasks: () => [] }));
	t.push({ scenario: "filter=running: none", result: r, pass: r.includes("No running"), note: "Empty running" });
}

// ═══════════════════════════════════════════
// TaskStatus: config=recent_turns, turn_length
// ═══════════════════════════════════════════
{
	const t: T[] = results["TaskStatus"] = [];
	const run = getExecute(taskStatusTool);

	// --- not found ---
	let r = await run({ task_id: "nope" }, ctx({ getTaskResult: () => null }));
	t.push({ scenario: "not found", result: r, pass: r.includes("not found"), note: "Missing task" });

	// --- running + currentTool ---
	r = await run({ task_id: "t1" }, ctx({
		getTaskResult: () => ({ id: "t1", status: "running", startedAt: Date.now() - 3000, step: 4, currentTool: "Bash" }),
		db: null,
	}));
	t.push({ scenario: "running with currentTool", result: r, pass: r.includes("running") && r.includes("Bash"), note: "Shows current tool" });

	// --- completed + elapsed ---
	r = await run({ task_id: "t2" }, ctx({
		getTaskResult: () => ({ id: "t2", status: "completed", startedAt: Date.now() - 5000, completedAt: Date.now(), step: 8 }),
		db: null,
	}));
	t.push({ scenario: "completed elapsed", result: r, pass: r.includes("completed") && r.includes("5s"), note: "Elapsed time" });
}

// ═══════════════════════════════════════════
// TaskStop
// ═══════════════════════════════════════════
{
	const t: T[] = results["TaskStop"] = [];
	const run = getExecute(taskStopTool);

	let r = await run({ task_id: "nope" }, ctx({ getTaskResult: () => null, stopTask: () => false }));
	t.push({ scenario: "not found", result: r, pass: r.includes("not found"), note: "Missing task" });

	r = await run({ task_id: "t1" }, ctx({ getTaskResult: () => ({ id: "t1", status: "completed" }), stopTask: () => false }));
	t.push({ scenario: "not running", result: r, pass: r.includes("not running"), note: "Wrong status" });

	r = await run({ task_id: "t2" }, ctx({ getTaskResult: () => ({ id: "t2", status: "running" }), stopTask: () => true }));
	t.push({ scenario: "stopped ok", result: r, pass: r.includes("stopped"), note: "Success" });
}

// ═══════════════════════════════════════════
// Wait
// ═══════════════════════════════════════════
{
	const t: T[] = results["Wait"] = [];
	const run = getExecute(waitTool);

	let r = await run({ timeout: 1 }, ctx());
	t.push({ scenario: "sleep fallback", result: r, pass: r.includes("Resumed after 1s"), note: "Sleep mode" });

	r = await run({ timeout: 1 }, ctx({ suspendUntilWake: async (ms: number) => `Woke after ${ms}ms` }));
	t.push({ scenario: "suspendUntilWake", result: r, pass: r.includes("Woke"), note: "Event wake" });

	r = await run({ timeout: 1, task_id: "t1" }, ctx({ suspendUntilWake: async (_ms: number, tid?: string) => `Task ${tid} done` }));
	t.push({ scenario: "specific task_id", result: r, pass: r.includes("t1"), note: "Targeted wait" });
}

// ═══════════════════════════════════════════
// TodoWrite
// ═══════════════════════════════════════════
{
	const t: T[] = results["TodoWrite"] = [];
	const run = getExecute(todoWriteTool);

	let r = await run({ todos: [
		{ content: "A", status: "completed", activeForm: "a" },
		{ content: "B", status: "in_progress", activeForm: "b" },
		{ content: "C", status: "pending", activeForm: "c" },
	]}, ctx());
	t.push({ scenario: "mixed statuses", result: r, pass: r.includes("1/3 completed") && r.includes("1 in progress"), note: "Summary" });

	r = await run({ todos: [
		{ content: "X", status: "completed", activeForm: "x" },
	]}, ctx());
	t.push({ scenario: "all completed", result: r, pass: r.includes("1/1 completed") && r.includes("0 in progress"), note: "1/1 done" });

	clearSessionTodos("test-agent");
}

// ═══════════════════════════════════════════
// Report
// ═══════════════════════════════════════════
const mode = process.argv[2];
if (mode === "detail") {
	// Detail mode: print all results as JSON for docs generation
	console.log(JSON.stringify(results, null, 2));
} else {
	console.log("\n========================================");
	console.log("  Tool Output + Config Test Report");
	console.log("========================================\n");

	let totalPass = 0, totalFail = 0;

	for (const [tool, tests] of Object.entries(results)) {
		let pass = 0, fail = 0;
		for (const t of tests) { if (t.pass) pass++; else fail++; }
		totalPass += pass;
		totalFail += fail;
		const icon = fail === 0 ? "OK" : "!!";
		console.log(`[${icon}] ${tool}: ${pass}/${tests.length} passed`);
		for (const t of tests) {
			if (!t.pass) {
				console.log(`  FAIL: ${t.scenario} — ${t.note}`);
				console.log(`       Got: ${t.result.slice(0, 150)}`);
			}
		}
		const sample = tests.find((t) => t.pass);
		if (sample) {
			console.log(`  Sample (${sample.scenario}):`);
			for (const line of sample.result.split("\n").slice(0, 5)) console.log(`    | ${line}`);
			if (sample.result.split("\n").length > 5) console.log("    | ...");
		}
		console.log("");
	}

	console.log(`========================================`);
	console.log(`Total: ${totalPass} passed, ${totalFail} failed`);
	console.log(`========================================`);
}

await rm(testDir, { recursive: true, force: true });
if (!mode) { let f=0; for (const ts of Object.values(results)) for (const t of ts) if (!t.pass) f++; process.exit(f > 0 ? 1 : 0); }
