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
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { buildTool } from "./tool-factory.js";
import { decodeShellBuffer } from "../core/encoding.js";
import { EXEC_MAX_BUFFER_BYTES } from "../core/constants.js";
import { findWikiPathInShellCommand, wikiPathRejectMessage } from "./wiki-path-guard.js";
import { resolveSkillTokensInShellCommand } from "./skill-paths.js";
import type { CallerCtx, ToolResult } from "./types.js";

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
		// Prefer Homebrew bash 5.x over macOS system /bin/bash (3.2, which
		// lacks associative arrays, ${var^^}, mapfile, etc.). /opt/homebrew on
		// Apple Silicon, /usr/local on Intel; fall back if neither is present.
		for (const p of ["/opt/homebrew/bin/bash", "/usr/local/bin/bash"]) {
			if (existsSync(p)) {
				cachedShell = { shell: p, args: ["-c"], type: "bash" };
				return cachedShell;
			}
		}
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
	// sub-2:configSchema 的 timeout 项移除 —— 默认固化 300s(execute 内硬编码),
	// LLM 仍可经 input `timeout` 单次覆盖。前端 ToolsPage 自动不再渲染该项。
	inputSchema: z.object({
		command: z.string().describe("The shell command to execute"),
		timeout: z.number().optional().describe("Timeout in seconds (a blocking call that times out auto-backgrounds as a safety net)"),
		background: z.boolean().optional().describe("Run in background and return task_id immediately"),
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
	// 注:execution-entry-redesign sub-3 把执行模型从 execFileAsync 改成 spawn
	// (为了超时能保留子进程并 adopt 进 task registry,见 foreground 路径)。spawn
	// 增量收集 stdout 进 chunks 数组,但 emit 仍在 close 后一次性推完整 stdout 作为
	// partial(非真增量流)。真 chunked emit 留后续接入 —— 当前优先级是"输出不丢 +
	// 超时转后台",不是流式 UX。
	execute: async (input: any, callerCtx: CallerCtx): Promise<ToolResult> => {
		const { command, timeout: inputTimeout, background } = input;
		// sub-2:timeout 默认固化 300s(不再读 configSchema 的 timeout —— 该项已移除)。
		// LLM 仍可经 input `timeout` 单次覆盖。sub-3 把超时行为从 kill 改为转后台 task。
		const timeoutSec = inputTimeout ?? 300;
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

		// skill-system sub-3:`[skills]/<id>/<rel>` 虚拟路径通道(resource 段:脚本执行)。
		// 命令里的 `[skills]/foo/scripts/x.py` token → 经 sub-2 解析器 → 真实路径(引号
		// 包裹 + 正斜杠化,Windows 反斜杠 + 命令注入防护)→ 替换进命令 → 执行真实脚本。
		// 同时把 `${SKILL_DIR}` / `${CLAUDE_SKILL_DIR}` 自引用替换成真实 baseDir(有
		// `[skills]/<id>/` 锚点时)。**真实路径命令不变**(无 `[skills]/` token 走原流程,
		// autoApprove/scope 照常——执行权限仍走原有 shell 工具门禁,这里不新造"始终放行")。
		// 任一 token 解析失败(skill 不存在 / `../` 越界)→ 整条命令拒(不部分替换)。
		// 解析成功的 skill baseDir → 注入 `SKILL_DIR=<baseDir>` 子进程 env(脚本自定位用)。
		const skillRes = resolveSkillTokensInShellCommand(command);
		if (!skillRes.ok) {
			return wrap(
				{ text: `Error: ${skillRes.error}`, stdout: "", stderr: "", exitCode: 0, elapsedSec: "0.0" },
				false,
				skillRes.error,
			);
		}
		const finalCommand = skillRes.command;
		const skillDirs = skillRes.skillDirs;

		const info = detectShell();

		// Pre-check: warn about Unix-only commands on non-bash shells
		if (info.type !== "bash") {
			const warning = checkUnixCommand(finalCommand, info.type);
			if (warning) {
				const text = `[Warning] ${warning}\n\n[Command not executed]`;
				return wrap({ text, stdout: "", stderr: warning, exitCode: 0, elapsedSec: "0.0" }, false);
			}
		}

		// Preprocess command for non-bash shells
		const processedCommand = preprocessCommand(finalCommand, info.type);
		const shellArgs = [...info.args, processedCommand];

		// Background mode (sub-2):`background:true` 把命令送进后台 task registry,
		// 立即返 task_id(不等命令完成)。从 sub-4 的移除里恢复 —— 现走中立的
		// callerCtx.delegateFns.runBackground(G1 访问器形态)而非旧的 ctx.runBackground。
		// 与 TaskStart{shell} 同 registry、同路径;两入口的取舍由 prompt 指引(sub-5)。
		//
		// G1:UI dispatcher 预览路径无 loop → delegateFns 缺失。返 benign preview
		// 让 host 能渲染工具预览不崩(model 在真实 run 里看不到这个状态)。
		if (background) {
			const fns = callerCtx.delegateFns;
			if (!fns) {
				return {
					ok: true,
					data: { text: "(preview) Shell background is unavailable outside an agent loop — callerCtx has no delegateFns." },
				};
			}
			if (!fns.runBackground) {
				return { ok: false, error: "Background shell is not available in this context." };
			}
			const taskId = fns.runBackground(processedCommand, timeoutSec);
			// Surface synchronous launch failures (bad shell / missing binary)
			// immediately so the model can tell "launch failed" from "running".
			const launched = fns.getTaskResult?.(taskId);
			if (launched?.status === "failed") {
				return {
					ok: true,
					data: {
						text: `Background command failed to launch.\ntask_id: ${taskId}\nError: ${launched.result ?? "unknown launch error"}`,
					},
				};
			}
			return {
				ok: true,
				data: {
					text: `Background shell started.\ntask_id: ${taskId}\nUse TaskGet to drill in (recent calls / completed result).`,
				},
			};
		}

		// Foreground mode (sub-3:execFileAsync → spawn + 手动超时检测 + 输出增量
		// 收集 + 超时转后台 adopt)。spawn 让我们能在超时时**保留**子进程(不 kill)
		// 并把它移交给 task registry(adoptBackgroundTask),后续输出持续收集进
		// task result,TaskGet 能看到。文本壳(成功 / 失败 / 超时三条路径)与 sub-3
		// 前逐字一致 —— agent 行为不回归;只有超时路径从"丢命令"变成"转后台 task"。
		const cwd = callerCtx.workingDir ?? ".";
		const spawnOpts: SpawnOptions = {
			cwd,
			// m3:显式关 stdin。spawn 默认 stdio:'pipe' → 父进程不写不关 stdin →
			// `cat` / `tail -f`(无参)等命令会 blocking 等 stdin → 300s 超时转后台
			// 后子进程继续阻塞 → registry 里永久存活。Shell 命令本就不该读 stdin,
			// 用 'ignore' 让 child 看到 EOF 立即退出(无参命令)/ 不阻塞。
			stdio: ["ignore", "pipe", "pipe"],
			// n1:Windows 上 spawn cmd.exe / git bash 默认会闪一下控制台窗口。
			// windowsHide:true 让 child 隐藏窗口运行(非 Windows 平台 no-op)。
			windowsHide: true,
		};
		// skill-system:命令含 skill 脚本时注入 `SKILL_DIR=<真实 baseDir>` 子进程 env。
		// (与 sub-3 前的 execOpts.env 语义一致;spawn 的 env 形态完全相同。)
		if (skillDirs.length > 0) {
			spawnOpts.env = { ...process.env, SKILL_DIR: skillDirs[0] };
		}
		const t0 = Date.now();

		// spawn 同步失败(极少见,通常是 shell binary 缺失或权限问题)→ 立即返失败,
		// 与 execFileAsync 的同步 throw 路径等价(只是更早抛 — execFile 是异步抛 error
		// 事件,spawn 失败也走 error 事件,但 try/catch 能抓到 ENOENT 等启动期错误)。
		let child: ChildProcess;
		try {
			child = spawn(info.shell, shellArgs, spawnOpts);
		} catch (err: any) {
			const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
			const msg = `Failed to launch: ${err?.message ?? String(err)}`;
			return wrap({ text: msg, stdout: "", stderr: msg, exitCode: -1, elapsedSec }, false, msg);
		}

		// 增量收集 raw Buffer chunks。**这些数组按引用**传给 adoptBackgroundTask,
		// 后台期间 data 监听器继续追加,close 时 adopt 一次性 concat+decode(避免
		// chunk 边界切断多字节字符 + Windows GBK 回退)。
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		// M1(maxBuffer 回归):execFileAsync 的 maxBuffer:EXEC_MAX_BUFFER_BYTES
		// (10MB)硬上限在 spawn 下没有对应物 —— 不加防护 → 长跑命令(`yes` /
		// `cat /dev/urandom` / 后台化的 `tail -f`)会让 chunks 无限涨 → 父进程 OOM。
		// 这里手写软上限:totalBytes 超 MAX → detach 两个 data 监听器(停止累积)
		// + child.kill()(停止产生更多输出)+ 标记 maxBufferHit。foreground race
		// 走 {kind:"maxbuffer"} 路径返失败;background(已 adopt)由 adopt 的 close
		// handler 在 close 时检测 chunks 总量 > MAX 走 maxbuffer fail 路径(见
		// adoptBackgroundTask 的 finalize)。
		const MAX_BYTES = EXEC_MAX_BUFFER_BYTES;
		let totalBytes = 0;
		let maxBufferHit = false;
		const onChunk = (chunk: Buffer, target: Buffer[]) => {
			if (maxBufferHit) return;
			totalBytes += chunk.length;
			target.push(chunk);
			if (totalBytes > MAX_BYTES) {
				maxBufferHit = true;
				// detach 监听器防止 chunks 继续累积(虽然已超 MAX,但避免后到 chunk
				// 进一步加重内存压力)。listener 已挂,这里 remove 一次性清掉所有
				// 'data' 监听器(只我们一个,无副作用)。
				child.stdout?.removeAllListeners("data");
				child.stderr?.removeAllListeners("data");
				// kill child(SIGTERM)。foreground race 的 close listener 会触发
				// finish({kind:"done",code:SIGTERM-code});background 的 adopt close
				// handler 同样会触发,finalize 检测 totalBytes > MAX 走 maxbuffer fail。
				try { child.kill(); } catch { /* already exited */ }
				// foreground:直接 settle race 为 maxbuffer(outcome.kind 即可识别)。
				// background:settle 是 no-op(timeout 已 settle),不影响。
				finishRace({ kind: "maxbuffer" });
			}
		};

		// 子进程完成 vs 超时 vs maxbuffer:race。三条路径:
		//   - done     :child 自然结束 → decode chunks → 返正常 ToolResult。
		//   - timeout  :**不 kill child** → adopt 进 registry → 返 task_id + 中性提示。
		//   - maxbuffer:输出超 MAX → 返 maxbuffer 失败(保留截断的 partial 输出)。
		// race listeners settle 后变 no-op(不 removeAllListeners — 那会和 adopt
		// 的 close listener attach 抢跑,丢事件;settled flag 让重复触发安全)。
		let doneCode: number;
		let finishRace: (r: { kind: "done"; code: number } | { kind: "timeout" } | { kind: "maxbuffer" }) => void = () => {
			// placeholder — Promise executor 同步重赋值前 maxbuffer 不会触发
			// (data 事件是异步,Promise 构造函数同步跑完)。防御性兜底。
		};
		// **先** attach data 监听器(必须在 await Promise 之前 — Promise 期间
		// child 可能产出 chunks,不能丢)。监听器闭包引用 finishRace,真正实现
		// 在 Promise executor 同步赋值。
		child.stdout?.on("data", (d: Buffer) => onChunk(d, stdoutChunks));
		child.stderr?.on("data", (d: Buffer) => onChunk(d, stderrChunks));
		const outcome: { kind: "done"; code: number } | { kind: "timeout" } | { kind: "maxbuffer" } = await new Promise((resolve) => {
			let settled = false;
			finishRace = (r) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				resolve(r);
			};
			const timer = timeout ? setTimeout(() => finishRace({ kind: "timeout" }), timeout) : undefined;
			child.on("close", (code) => finishRace({ kind: "done", code: typeof code === "number" ? code : -1 }));
			// child.on("error"): 同步 spawn 错误或运行期 spawn-internal 错误。统一
			// 当作 done code=-1 处理(error 事件后 child 通常不会再 close,避免挂起)。
			child.on("error", () => finishRace({ kind: "done", code: -1 }));
		});

		// M1 foreground maxbuffer 路径:输出超 MAX → kill child + 返 maxbuffer 失败。
		// 保留截断的 partial 输出(前 4KB,避免 ToolResult 文本过长)。
		if (maxBufferHit || outcome.kind === "maxbuffer") {
			const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
			const partialStdout = decodeShellBuffer(Buffer.concat(stdoutChunks));
			const partialStderr = decodeShellBuffer(Buffer.concat(stderrChunks));
			const partialPreview = (partialStdout + (partialStderr ? `\n[stderr] ${partialStderr}` : "")).slice(0, 4096);
			const text = `Output exceeded ${MAX_BYTES} bytes (process killed).\nCommand: ${finalCommand}\nPartial output (truncated):\n${partialPreview}`;
			return wrap({ text, stdout: partialStdout.slice(0, 4096), stderr: partialStderr.slice(0, 2048), exitCode: -1, elapsedSec }, false, text);
		}

		// 超时路径:转后台(保留命令 + 已收集输出)。
		if (outcome.kind === "timeout") {
			const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
			// Race guard:child 可能在 timeout 触发与本行之间已退出(close 事件在
			// finish 返回后、adopt 接管前已发;再 attach close listener 不会回放)。
			// exitCode/signalCode 任一非 null 表示 child 已退出 → 走 done 路径返正常
			// 文本(等同 outcome.kind==="done",agent 看到完整输出而非 task_id)。
			const alreadyExited = child.exitCode !== null || child.signalCode !== null;
			if (!alreadyExited) {
				const fns = callerCtx.delegateFns;
				if (fns?.adoptBackgroundTask) {
					// 核心:移交 child 进 task registry。child 的 data 监听器仍挂在
					// bash.ts 的 stdoutChunks/stderrChunks 数组上(按引用),adopt
					// 的 close handler 在 child 真正退出时 concat+decode 这两个数组,
					// 拿到包含超时后所有后续输出的完整结果。TaskKill 经 AbortController
					// → child.kill() 真正终止 child(不像 runBackground 是 bookkeeping only)。
					const taskId = fns.adoptBackgroundTask(child, finalCommand, stdoutChunks, stderrChunks);
					const text = `Command ran ${timeoutSec}s without finishing. Backgrounded as task_id: ${taskId}. You decide: Task kill to stop / Task get to watch / let it finish.`;
					return wrap({ text, stdout: "", stderr: "", exitCode: -1, elapsedSec }, false, text);
				}
				// Adoption unavailable(UI preview / external host / 旧 loop 没装这个
				// delegate fn):退回 sub-3 前行为 —— kill child + 返 timeout 文本。
				// 不静默降级,文本明示 "(background adoption unavailable)" 让 agent
				// 知道这条路径没转后台。
				try { child.kill(); } catch { /* already exited */ }
				const text = `Command timed out after ${timeoutSec}s (background adoption unavailable)\nCommand: ${finalCommand}`;
				return wrap({ text, stdout: "", stderr: "", exitCode: -1, elapsedSec }, false, text);
			}
			// 已退出 → 落到下面的 done 路径(用 child 的 exitCode/signalCode)
			doneCode = child.exitCode !== null ? child.exitCode : -1;
		} else {
			doneCode = outcome.code;
		}

		// Done 路径(自然完成 或 超时 race 中已退出):decode + 返 ToolResult。
		// 文本形态与 sub-3 前逐字一致 —— 成功路径输出 stdout,失败路径 "Exit code N"。
		{
			const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
			const stdout = decodeShellBuffer(Buffer.concat(stdoutChunks));
			const stderr = decodeShellBuffer(Buffer.concat(stderrChunks));
			const stderrText = postprocessError(stderr.trim(), finalCommand, info.type);
			const exitCode = doneCode;
			// G2 流式:推一次完整 stdout 作为 partial(真增量流留后续,同 sub-2)。
			if (emit && stdout.trim()) emit({ type: "partial", text: stdout.trim() });
			const stdoutTrim = stdout.trim();
			if (exitCode === 0) {
				let text = "";
				if (stdoutTrim) text += stdoutTrim;
				if (stderrText) text += "\n[stderr] " + stderrText;
				text += `\n[Completed in ${elapsedSec}s]`;
				return wrap({ text, stdout: stdoutTrim, stderr: stderrText, exitCode: 0, elapsedSec }, true);
			}
			let text = `Exit code ${exitCode}`;
			if (finalCommand.length <= 200) text += `\nCommand: ${finalCommand}`;
			if (stdoutTrim) text += "\n" + stdoutTrim;
			if (stderrText) text += "\n[stderr] " + stderrText;
			text += `\n[Completed in ${elapsedSec}s]`;
			return wrap({ text, stdout: stdoutTrim, stderr: stderrText, exitCode, elapsedSec }, false, text);
		}
	},
	// format(决策 3,G6):透出 data.text。文本形态与 sub-3 前完全一致(成功 +
	// 失败两条路径都逐字保留)。
	format: (result: ToolResult): string => {
		return (result.data as any)?.text ?? result.error ?? "Shell command failed.";
	},
});
