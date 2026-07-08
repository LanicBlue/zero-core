// Shell 执行工具
//
// # 文件说明书
//
// ## 核心功能
// 执行 Shell 命令，返回输出和错误信息。自动适配平台 shell 环境。
//
// ## 输入
// - 命令字符串
// - 工作目录
//
// ## 输出
// - stdout 输出
// - stderr 错误
// - 退出码
//
// ## 定位
// Runtime 工具，被 Agent 调用。
//
// ## 依赖
// - zod - 数据验证
// - node:child_process - 进程执行
//
// ## 维护规则
// - 保持安全限制（超时、缓冲区）
// - 新增危险命令黑名单时需更新
//
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { buildTool } from "./tool-factory.js";
import { EXEC_MAX_BUFFER_BYTES } from "../core/constants.js";
import { decodeExecBuffers } from "../core/encoding.js";
import { findWikiPathInShellCommand, wikiPathRejectMessage } from "./wiki-path-guard.js";
import type { CallerCtx, ToolResult } from "./types.js";

const execFileAsync = promisify(execFile);

// ─── Shell detection ─────────────────────────────────────────────────

type ShellInfo = { shell: string; args: string[]; type: "bash" | "cmd" | "powershell" };

const GIT_BASH_PATHS = [
	"C:/Program Files/Git/bin/bash.exe",
	"C:/Program Files (x86)/Git/bin/bash.exe",
];

let cachedShell: ShellInfo | null = null;

function detectShell(): ShellInfo {
	if (cachedShell) return cachedShell;
	const isWin = process.platform === "win32";

	if (!isWin) {
		cachedShell = existsSync("/bin/bash")
			? { shell: "/bin/bash", args: ["-c"], type: "bash" }
			: { shell: "/bin/sh", args: ["-c"], type: "bash" };
		return cachedShell;
	}

	// Windows: Git Bash → cmd.exe → PowerShell
	for (const p of GIT_BASH_PATHS) {
		if (existsSync(p)) {
			cachedShell = { shell: p, args: ["-c"], type: "bash" };
			return cachedShell;
		}
	}

	// Check PATH for bash
	const pathDirs = (process.env.PATH ?? "").split(";");
	for (const dir of pathDirs) {
		const candidate = dir.replace(/\\/g, "/") + "/bash.exe";
		if (existsSync(candidate)) {
			cachedShell = { shell: candidate, args: ["-c"], type: "bash" };
			return cachedShell;
		}
	}

	cachedShell = {
		shell: "cmd.exe",
		args: ["/d", "/s", "/c"],
		type: "cmd",
	};
	return cachedShell;
}

// ─── Command translation (cmd.exe only) ──────────────────────────────

const CMD_TRANSLATIONS: Record<string, string> = {
	ls: "dir /b",
	cat: "type",
	rm: "del",
	cp: "copy",
	mv: "move",
	mkdir: "mkdir",
	rmdir: "rmdir /s /q",
	pwd: "cd",
	which: "where",
	touch: "type nul >",
};

const UNIX_ONLY_COMMANDS = new Set([
	"head", "tail", "grep", "awk", "sed", "wc", "sort", "uniq",
	"tee", "xargs", "cut", "tr", "curl", "wget", "find",
	"chmod", "chown", "ln", "tar", "gzip", "gunzip",
	"ps", "kill", "df", "du", "top", "env", "man",
]);

const UNIX_ALTERNATIVES: Record<string, string> = {
	head: "PowerShell: Get-Content file -Head N | Install Git Bash for Unix commands",
	tail: "PowerShell: Get-Content file -Tail N | Install Git Bash for Unix commands",
	grep: "Use the Grep tool instead | PowerShell: Select-String | Install Git Bash",
	awk: "No direct Windows equivalent | Install Git Bash",
	sed: "Use the Edit tool instead | Install Git Bash",
	find: "Use the Glob tool instead | PowerShell: Get-ChildItem -Recurse",
	curl: "PowerShell: Invoke-WebRequest | Install Git Bash",
	wget: "PowerShell: Invoke-WebRequest | Install Git Bash",
	sort: "cmd: sort (built-in) | PowerShell: Sort-Object",
	wc: "PowerShell: (Get-Content file).Count | Install Git Bash",
	tee: "PowerShell: Tee-Object | cmd: command > file & type file",
	xargs: "No direct Windows equivalent | Install Git Bash",
	cut: "PowerShell: -split | Install Git Bash",
	tr: "PowerShell: -replace | Install Git Bash",
	ps: "PowerShell: Get-Process | cmd: tasklist",
	kill: "PowerShell: Stop-Process | cmd: taskkill /PID",
	df: "PowerShell: Get-PSDrive | cmd: wmic logicaldisk",
	du: "PowerShell: (Get-ChildItem -Recurse | Measure-Object -Property Length -Sum).Sum",
	chmod: "No Windows equivalent (NTFS ACLs differ) | Install Git Bash",
	chown: "No Windows equivalent (NTFS ACLs differ) | Install Git Bash",
	ln: "cmd: mklink | PowerShell: New-Item -ItemType SymbolicLink",
	tar: "PowerShell 5.1+: No built-in | Install Git Bash | PowerShell 7+: tar built-in",
};

function preprocessCommand(command: string, shellType: string): string {
	let result = command;

	if (shellType === "bash") return result;

	// Fix unquoted Windows paths with spaces: C:\Users\Some Dir\file → "C:\Users\Some Dir\file"
	result = result.replace(
		/(?:^|[\s=])([A-Za-z]:\\(?:[^\s"|']+\s+[^\s"|']*)+)(?:[\s]|$)/g,
		(match, path: string) => match.replace(path, `"${path}"`),
	);

	// cmd.exe: translate common commands
	const firstWord = result.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	if (CMD_TRANSLATIONS[firstWord]) {
		const rest = result.trim().substring(firstWord.length);
		return CMD_TRANSLATIONS[firstWord] + rest;
	}
	return result;
}

function checkUnixCommand(command: string, shellType: string): string | null {
	if (shellType === "bash") return null;
	const firstWord = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	if (UNIX_ONLY_COMMANDS.has(firstWord)) {
		const alt = UNIX_ALTERNATIVES[firstWord];
		return `'${firstWord}' is a Unix command not available in ${shellType === "cmd" ? "cmd.exe" : "PowerShell"}.${alt ? " Alternatives: " + alt : " Install Git Bash for Unix command support."}`;
	}
	return null;
}

function postprocessError(stderr: string, command: string, shellType: string): string {
	if (shellType === "bash") return stderr;

	// Detect "is not recognized" on Windows
	const notRecognized = /'(\S+)' is not recognized/i.test(stderr) || /'(\S+)' is not an (internal|external)/i.test(stderr);
	if (notRecognized) {
		const firstWord = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
		if (UNIX_ONLY_COMMANDS.has(firstWord)) {
			const alt = UNIX_ALTERNATIVES[firstWord];
			return stderr + `\n[Hint: ${alt ?? "Install Git Bash for Unix command support."}]`;
		}
	}
	return stderr;
}

// ─── Dynamic description ─────────────────────────────────────────────

function buildDescription(): string {
	const info = detectShell();
	const shellLabel = info.type === "bash" ? "bash" : info.type === "cmd" ? "cmd.exe" : "PowerShell";
	const platform = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";

	return `Executes a shell command using ${shellLabel} on ${platform} and returns its output.`;
}

function buildPrompt(): string {
	const info = detectShell();
	const lines: string[] = [
		buildDescription(),
		"",
		"Each Shell call runs in a separate subprocess — `cd` does NOT persist across calls. The working directory is set to the workspace root on every invocation. Always use absolute paths, or chain `cd && command` in a single call.",
		"",
		"IMPORTANT: Avoid using this tool to run `find`, `ls`, `grep`, `cat`, `head`, `tail`, `sed`, or `awk`, " +
		"unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. " +
		"Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:",
		"- File search and directory listing: Use `Glob` tool (NOT find, ls, or dir)",
		"- Content search: Use `Grep` tool (NOT shell grep or rg)",
		"- Read files: Use `Read` tool (NOT cat, head, tail)",
		"- Edit files: Use `Edit` tool (NOT sed, awk)",
		"- Write files: Use `Write` tool (NOT `echo > file`, `cat <<EOF > file`)",
		"",
		"While the Shell tool can do similar things, it's better to use the built-in tools as they provide a much better experience for the user.",
	];

	if (info.type !== "bash") {
		lines.push(
			"",
			`# IMPORTANT: Current shell is ${info.type === "cmd" ? "cmd.exe" : "PowerShell"}, NOT bash.`,
			"Unix commands like head, tail, grep, awk, sed, find, curl, wget are NOT available.",
			"Use purpose-built tools (Glob, Grep, Read, Edit, Write) instead of Unix shell commands.",
			"For && chaining: cmd.exe supports && natively.",
		);
	} else if (process.platform === "win32") {
		lines.push(
			"",
			"# IMPORTANT: Current shell is bash (Git Bash on Windows), NOT cmd.exe or PowerShell.",
			"Use BASH syntax: `rm -f` (not `del`), `ls` (not `dir`), `cp`/`mv`, `cat`, forward-slash paths. " +
				"Windows cmd commands (`del`, `dir`, `type`, `copy`, `move`) and backslash paths will FAIL. " +
				"Path-style flags differ too — prefer POSIX style.",
		);
	}

	lines.push(
		"",
		"# Instructions",
		"- If your command will create new directories or files, first run `ls` to verify the parent directory exists.",
		"- Always quote file paths that contain spaces with double quotes.",
		"- Always use absolute paths. Do NOT rely on `cd` to persist — each call starts fresh from the workspace root. Use `cd dir && command` to run in a specific directory within a single call.",
		"- You may specify an optional timeout in seconds. By default, commands have no timeout unless configured.",
		"- Shell is BLOCKING (waits for output). For a long-running background command (downloads, installs, watches), use TaskStart { type:'shell', command } — it returns a task_id immediately; check it via TaskGet / Wait. A blocking Shell call that times out auto-backgrounds as a safety net (you get a task_id).",
		"- When issuing multiple commands: if independent, make multiple Shell calls in parallel; if dependent, chain with `&&`. Use `;` only when you don't care if earlier commands fail.",
		"- DO NOT use newlines to separate commands.",
		"- For git commands: prefer creating new commits over amending. Never skip hooks (--no-verify) unless explicitly asked.",
		"- Avoid unnecessary `sleep` commands. Do not retry failing commands in a sleep loop - diagnose the root cause.",
		"- Communication: Output text directly (NOT echo/printf).",
	);

	return lines.join("\n");
}

// ─── Tool definition ─────────────────────────────────────────────────

export const bashTool = buildTool({
	name: "Shell",
	description: buildDescription(),
	prompt: buildPrompt(),
	meta: { category: "runtime", isReadOnly: false, isDestructive: true, isConcurrencySafe: false },
	configSchema: [
		{ key: "timeout", type: "number", label: "默认超时 (s)", description: "命令执行超时时间（秒，留空则不限制）" },
	],
	inputSchema: z.object({
		command: z.string().describe("The shell command to execute"),
		timeout: z.number().optional().describe("Timeout in seconds (a blocking call that times out auto-backgrounds as a safety net)"),
	}),
	// tool-decoupling sub-3(决策 1/3 + G5/G6 + G2 流式):workingDir / toolConfig
	// 从 callerCtx 取;Bash 流式经 callerCtx.emit 吐 stdout 增量(sub-2 的
	// ctxToCallerCtx 已桥接 ctx.emit → callerCtx.emit)。返 ToolResult{data:{text,
	// stdout, stderr, exitCode, elapsedSec}}(G6 文本壳 + 元数据);format(r) =
	// r.data.text。文本形态与 sub-3 前完全一致(agent 行为不回归)。
	//
	// 流式契约(G2):callerCtx.emit 缺失(测试 / 合成调用)→ 不流式,只返 JSON。
	// emit 存在 → 边跑边吐 {type:"partial", text:<stdout 增量>}。终态 JSON 仍含
	// 完整 stdout(emit 是副作用通道,不影响返值)。
	//
	// 注:当前用 execFileAsync 一次性收集 stdout(非真流式);emit 在结果就绪后
	// 推一次完整 stdout 作为 partial。真增量流(spawn + chunked emit)留后续接入
	// —— sub-3 不改 exec 模型,只把 emit 通道接通(G2 契约先就位)。
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult> => {
		const { command, timeout: inputTimeout } = input;
		const config = callerCtx.toolConfig?.Shell ?? {};
		const timeoutSec = inputTimeout ?? config.timeout;
		const timeout = timeoutSec ? timeoutSec * 1000 : undefined;
		const emit = typeof callerCtx.emit === "function" ? callerCtx.emit : undefined;

		const wrap = (data: { text: string; stdout: string; stderr: string; exitCode: number; elapsedSec: string }, ok: boolean, error?: string): ToolResult => ({
			ok,
			error,
			data,
		});

		// v0.8 (P1 §10.1): block agent shell access to the wiki memory store.
		// Best-effort token scan; flags clear `.zero-core/wiki/` references.
		const blockedPath = findWikiPathInShellCommand(command, callerCtx.workingDir);
		if (blockedPath) {
			return wrap({ text: wikiPathRejectMessage(blockedPath), stdout: "", stderr: "", exitCode: 0, elapsedSec: "0.0" }, false);
		}

		const info = detectShell();

		// Pre-check: warn about Unix-only commands on non-bash shells
		if (info.type !== "bash") {
			const warning = checkUnixCommand(command, info.type);
			if (warning) {
				const text = `[Warning] ${warning}\n\n[Command not executed]`;
				return wrap({ text, stdout: "", stderr: warning, exitCode: 0, elapsedSec: "0.0" }, false);
			}
		}

		// Preprocess command for non-bash shells
		const processedCommand = preprocessCommand(command, info.type);
		const shellArgs = [...info.args, processedCommand];

		// sub-4: Shell is BLOCKING only. Explicit background is the TaskStart
		// {type:'shell'} tool — `background:true` was removed. A blocking call
		// that times out throws (the auto-background safety net is a Subagent
		// delegate concern, not a Shell one). Foreground:

		// Foreground mode
		const cwd = callerCtx.workingDir ?? ".";
		// encoding:"buffer" → stdout/stderr 以 Buffer 返回,交给 decodeExecBuffers
		// 做 UTF-8(优先)/ GBK(Windows 原生命令回退)解码,避免中文乱码。
		const execOpts: any = { cwd, maxBuffer: EXEC_MAX_BUFFER_BYTES, encoding: "buffer" };
		if (timeout) execOpts.timeout = timeout;
		const t0 = Date.now();

		try {
			const result = await execFileAsync(info.shell, shellArgs, execOpts) as unknown as { stdout: Buffer; stderr: Buffer };
			const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
			const { stdout, stderr } = decodeExecBuffers(result);
			// G2 流式:推一次完整 stdout 作为 partial(真增量流留后续)。
			if (emit && stdout) emit({ type: "partial", text: stdout.trim() });
			let text = "";
			if (stdout) text += stdout.trim();
			if (stderr) text += "\n[stderr] " + stderr.trim();
			text += `\n[Completed in ${elapsedSec}s]`;
			return wrap({ text, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0, elapsedSec }, true);
		} catch (err: any) {
			const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
			if (err.killed) {
				// Timeout:重现旧文本("Command timed out after …s\nCommand: …"),
				// 但走 migrated 返 ToolResult{ok:false} 而非 throw(与 Platform
				// 一致:错误也返 JSON,agent 看到 timeout 文本作为工具结果)。
				const text = `Command timed out after ${timeoutSec}s\nCommand: ${command}`;
				return wrap({ text, stdout: "", stderr: "", exitCode: -1, elapsedSec }, false, text);
			}
			const { stdout, stderr } = decodeExecBuffers(err);
			const stderrText = postprocessError(stderr.trim(), command, info.type);
			const exitCode = err.status ?? err.code ?? 1;
			// G2 流式:即使失败也推 partial(已收集的 stdout)。
			if (emit && stdout) emit({ type: "partial", text: stdout.trim() });
			let text = `Exit code ${exitCode}`;
			if (command.length <= 200) text += `\nCommand: ${command}`;
			const stdoutTrim = stdout.trim();
			if (stdoutTrim) text += "\n" + stdoutTrim;
			if (stderrText) text += "\n[stderr] " + stderrText;
			text += `\n[Completed in ${elapsedSec}s]`;
			// 失败仍返 ToolResult(ok=false)—— format 透出 data.text(同旧 throw
			// 文本),agent 看到的形态不变;UI 拿 exitCode 等元数据。
			return wrap({ text, stdout: stdoutTrim, stderr: stderrText, exitCode, elapsedSec }, false, text);
		}
	},
	// format(决策 3,G6):透出 data.text。文本形态与 sub-3 前完全一致(成功 +
	// 失败两条路径都逐字保留)。
	format: (result: ToolResult): string => {
		return (result.data as any)?.text ?? result.error ?? "Shell command failed.";
	},
});
