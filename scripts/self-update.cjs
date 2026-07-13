#!/usr/bin/env node
// 自更新工作流主脚本(P0–P5)
//
// # 文件说明书
//
// ## 核心功能
// zero-core packaged 自更新的确定性工作流。执行 P0 预检 → P1 回退点 →
// P2 数据快照 → P3 构建 → P4 staging 冒烟 → P5 触发 detached helper 切换。
// 每步 stdout 发一行 JSON,退出码即门(gate)。失败时 Claude 读 <runDir>/*.log 诊断。
// 不直接改用户数据;所有状态变更都有回退点。
//
// ## 输入
// argv: --mode=packaged | --platform=mac|win|linux | --install=<path> | --target=<git-ref> | --no-snapshot
// env:  ZERO_CORE_DIR(数据根,默认 ~/.zero-core)
//
// ## 输出
// <ZERO_CORE_DIR>/update-runs/<ISO_TS>/:{preflight,rollback,swap,helper.pid}.json + build.log/smoke.log
//   + previous.<ext> + staging/ + zero-core.snapshot/
// stdout: 每步 JSON 行 {step,phase,ts,...}
// 退出码:0 ok;10 P0;11 P1;12 P2;13 P3;14 P4
//
// ## 定位
// scripts/ 自更新工作流;由 Claude Code CLI headless 或 npm run self-update 触发。
// P6(替换/重启/回退)由 self-update-helper.cjs detached 执行。
//
// ## 依赖
// Node 内置(child_process/fs/path/os);系统 git/npm/node;mac 的 hdiutil。
//
// ## 维护规则
// 平台分支(mac/win/linux)改动需同步 self-update-helper.cjs 的对应逻辑。

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── helpers ──────────────────────────────────────────────

function emit(step, phase, extra) {
	console.log(JSON.stringify({ step, phase, ts: Date.now(), ...(extra || {}) }));
}

function parseArgs(argv) {
	const a = { mode: "packaged", platform: detectPlatform(), install: null, target: null, noSnapshot: false };
	for (const arg of argv.slice(2)) {
		if (arg.startsWith("--mode=")) a.mode = arg.slice(7);
		else if (arg.startsWith("--platform=")) a.platform = arg.slice(11);
		else if (arg.startsWith("--install=")) a.install = arg.slice(10);
		else if (arg.startsWith("--target=")) a.target = arg.slice(9);
		else if (arg === "--no-snapshot") a.noSnapshot = true;
	}
	return a;
}

function detectPlatform() {
	if (process.platform === "darwin") return "mac";
	if (process.platform === "win32") return "win";
	return "linux";
}

function zeroCoreDir() {
	return process.env.ZERO_CORE_DIR || path.join(os.homedir(), ".zero-core");
}

function makeRunDir() {
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = path.join(zeroCoreDir(), "update-runs", ts);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function writeJson(file, obj) {
	fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function run(cmd, args, opts, logFile) {
	const useShell = process.platform === "win32";
	const stdio = logFile
		? ["ignore", fs.openSync(logFile, "a"), fs.openSync(logFile, "a")]
		: ["ignore", "inherit", "inherit"];
	const res = spawnSync(cmd, args, { stdio, shell: useShell, ...opts });
	if (logFile) { try { fs.closeSync(stdio[1]); fs.closeSync(stdio[2]); } catch {} }
	return res;
}

function which(tool) {
	const lookup = process.platform === "win32" ? "where" : "which";
	return spawnSync(lookup, [tool], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
}

function fail(step, code, msg, logFile) {
	emit(step, "fail", { exit: code, error: msg, ...(logFile ? { log: logFile, hint: "见 log 末 50 行" } : {}) });
	console.error(`[self-update] ${step} FAIL (${code}): ${msg}`);
	process.exit(code);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── install path 探测 ────────────────────────────────────

function resolveInstallPath(args, platform) {
	let p = args.install;
	if (!p) {
		const f = path.join(zeroCoreDir(), "runtime.install-path");
		if (fs.existsSync(f)) p = fs.readFileSync(f, "utf-8").trim();
	}
	if (!p) {
		if (platform === "mac") p = "/Applications/Zero-Core.app"; // 默认猜测
	}
	if (!p) return null;
	// mac: exe 路径(.app/Contents/MacOS/X)回溯到 .app 容器
	if (platform === "mac" && !p.endsWith(".app")) {
		const idx = p.indexOf(".app/");
		if (idx > 0) p = p.slice(0, idx + 4);
	}
	return fs.existsSync(p) ? p : null;
}

// ─── P3 构建产物 + staging 提取 ────────────────────────────

function findBuildArtifact(platform) {
	const releaseDir = path.join(__dirname, "..", "release");
	if (!fs.existsSync(releaseDir)) return null;
	if (platform === "mac") {
		// electron-builder --dir 产出 release/mac-arm64/Zero-Core.app
		const macDir = path.join(releaseDir, "mac-arm64");
		if (!fs.existsSync(macDir)) return null;
		const app = fs.readdirSync(macDir).find((f) => f.endsWith(".app"));
		return app ? path.join("mac-arm64", app) : null; // 相对 release/ 的路径
	}
	const files = fs.readdirSync(releaseDir);
	if (platform === "win") return files.find((f) => /portable.*\.exe$/i.test(f)) || null;
	if (platform === "linux") return files.find((f) => f.endsWith(".AppImage")) || null;
	return null;
}

function extractStaging(platform, artifactPath, runDir) {
	const stagingDir = path.join(runDir, "staging");
	fs.mkdirSync(stagingDir, { recursive: true });
	if (platform === "mac") {
		// electron-builder --dir 产出 release/mac-arm64/Zero-Core.app;直接复制(不打 dmg,避开 dmg-builder 下载)
		const appName = path.basename(artifactPath);
		fs.cpSync(artifactPath, path.join(stagingDir, appName), { recursive: true });
		return path.join(stagingDir, appName);
	}
	// win portable exe / linux AppImage:单文件,直接复制
	const name = path.basename(artifactPath);
	fs.copyFileSync(artifactPath, path.join(stagingDir, name));
	const dest = path.join(stagingDir, name);
	if (platform === "linux") fs.chmodSync(dest, 0o755);
	return dest;
}

// ─── P4 staging 冒烟(复刻 backend-spawn 握手)──────────────

function stagingBackendJs(platform, stagingPath) {
	// mac:.app 内固定路径。win portable / linux AppImage:运行时才解压,文件系统上不可达 → null(冒烟跳过)
	if (platform === "mac") {
		const p = path.join(stagingPath, "Contents", "Resources", "app", "dist", "backend.js");
		return fs.existsSync(p) ? p : null;
	}
	return null;
}

function stagingElectronExe(platform, stagingPath) {
	if (platform === "mac") return path.join(stagingPath, "Contents", "MacOS", "Zero-Core");
	return stagingPath; // win portable exe / linux AppImage 本体
}

function writeMinimalFixture(runDir) {
	// test-seed.ts 识别 ZERO_CORE_TEST_FIXTURE 并 seed 1 个 mock provider + TestAgent
	const f = path.join(runDir, "smoke-fixture.json");
	fs.writeFileSync(f, JSON.stringify({
		chunks: [{ type: "text", text: "smoke ok" }],
		usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
	}));
	return f;
}

function spawnStagingBackend(platform, stagingPath, env, logFile) {
	const exe = stagingElectronExe(platform, stagingPath);
	const backendJs = stagingBackendJs(platform, stagingPath);
	const args = [backendJs, "--port=0"];
	const child = spawn(exe, args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
	});
	let port = null;
	const append = (b) => { try { fs.appendFileSync(logFile, b); } catch {} };
	child.stdout.on("data", (d) => {
		append(d);
		for (const line of d.toString().split("\n")) {
			try { const m = JSON.parse(line); if (m.type === "ready" && m.port) port = m.port; } catch { /* not json */ }
		}
	});
	child.stderr.on("data", append);
	return { child, getPort: () => port };
}

async function waitForReady(getPort, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const p = getPort();
		if (p) return p;
		await sleep(200);
	}
	return null;
}

async function healthCheck(port) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/api/health`);
		return await r.json();
	} catch { return null; }
}

function shutdownChild(child) {
	// 三段式:stdin shutdown → SIGTERM → SIGKILL(复刻 backend-spawn.shutdownBackend)
	try { child.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n"); } catch {}
	setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 5000);
	setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 8000);
}

// 等 zero-core 优雅退出:轮询 runtime.port 的 /api/ready 失联
async function waitForQuit(timeoutMs) {
	const portFile = path.join(zeroCoreDir(), "runtime.port");
	let port = null;
	try { port = parseInt(fs.readFileSync(portFile, "utf-8").trim(), 10); } catch {}
	if (!port) { await sleep(3000); return; } // 没端口信息,等一拍
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await fetch(`http://127.0.0.1:${port}/api/ready`, { signal: AbortSignal.timeout(1000) });
		} catch {
			return; // 失联 = 已退出
		}
		await sleep(500);
	}
}

// ─── main: P0–P5 ──────────────────────────────────────────

async function main() {
	const args = parseArgs(process.argv);
	const platform = args.platform;
	const zcDir = zeroCoreDir();
	const runDir = makeRunDir();
	emit("P0", "start", { mode: args.mode, platform, runDir });

	// P0 preflight
	for (const tool of ["git", "npm", "node"]) {
		if (!which(tool)) fail("P0", 10, `PATH 缺少 ${tool}`);
	}
	const installPath = resolveInstallPath(args, platform);
	if (args.mode === "packaged" && !installPath) {
		fail("P0", 10, "无法定位当前安装位置(传 --install=<path>,或确保运行中的 zero-core 已写 runtime.install-path)");
	}
	writeJson(path.join(runDir, "preflight.json"), { mode: args.mode, platform, installPath, target: args.target });
	emit("P0", "end", { exit: 0, installPath });

	// P1 rollback point(代码:git tag;安装:mv → previous)
	emit("P1", "start");
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const tagName = `pre-update-${ts}`;
	const repoRoot = path.join(__dirname, "..");
	const tagRes = run("git", ["tag", tagName], { cwd: repoRoot }, null);
	const tagged = tagRes.status === 0;
	let previousPath = null;
	if (args.mode === "packaged" && installPath) {
		const ext = platform === "mac" ? ".app" : platform === "win" ? ".exe" : ".AppImage";
		previousPath = path.join(runDir, "previous" + ext);
		try {
			fs.renameSync(installPath, previousPath); // 运行中可 rename(mac 目录 / win exe / linux AppImage 均可)
		} catch (e) {
			fail("P1", 11, `mv 当前安装失败: ${e.message}`);
		}
	}
	writeJson(path.join(runDir, "rollback.json"), { tag: tagName, tagged, previousPath, installPath });
	emit("P1", "end", { exit: 0, tag: tagName, previousPath });

	// P2 数据快照(packaged + !noSnapshot)
	if (args.mode === "packaged" && !args.noSnapshot) {
		emit("P2", "start");
		const sentinel = path.join(zcDir, ".quit-requested");
		try { fs.writeFileSync(sentinel, String(Date.now())); } catch {}
		await waitForQuit(20000); // 主进程 watchFile 命中 → app.quit → shutdownBackend 刷 WAL
		const snapshot = path.join(runDir, "zero-core.snapshot");
		try {
			fs.cpSync(zcDir, snapshot, { recursive: true });
		} catch (e) {
			if (previousPath) { try { fs.renameSync(previousPath, installPath); } catch {} }
			fail("P2", 12, `数据快照失败: ${e.message}`);
		}
		emit("P2", "end", { exit: 0, snapshot });
	}

	// P3 构建
	emit("P3", "start");
	const buildLog = path.join(runDir, "build.log");
	const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
	const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
	let r;
	// better-sqlite3 编给 Electron ABI(打包后端用 Electron fork 跑,需 148;dev 用系统 node 跑,需 141)。
	// 失败通常是缺编译工具链(mac:Xcode CLT / win:MSVC / linux:make+gcc),见 runbook。
	r = run(npmBin, ["run", "rebuild:native:electron"], { cwd: repoRoot }, buildLog);
	if (r.status !== 0) fail("P3", 13, "rebuild:native:electron 失败(检查编译工具链)", buildLog);

	// 构建 + 打包。累计错误而非立即 fail,确保 try/finally 一定把 ABI 还原回 Node(否则 npm run dev 会崩)。
	let p3Err = null;
	const step = (label, fn) => { if (!p3Err) { if (fn().status !== 0) p3Err = label; } };
	try {
		step("build:lib", () => run(npmBin, ["run", "build:lib"], { cwd: repoRoot }, buildLog)); // build:* 隐性依赖 dist/
		step("build", () => run(npmBin, ["run", "build"], { cwd: repoRoot }, buildLog)); // electron-vite build → out/
		// mac:--dir 出 .app 不打 dmg(避开 dmg-builder 网络下载);win:--win(portable);linux:--linux(AppImage)
		const ebArgs = platform === "mac" ? ["--mac", "--dir"] : platform === "win" ? ["--win"] : ["--linux"];
		step(`electron-builder ${ebArgs.join(" ")}`, () => run(npxBin, ["electron-builder", ...ebArgs], { cwd: repoRoot }, buildLog));
	} finally {
		// 无论成败都还原 dev(系统 Node ABI)
		run(npmBin, ["run", "rebuild:native:node"], { cwd: repoRoot }, buildLog);
	}
	if (p3Err) fail("P3", 13, `${p3Err} 失败(dev ABI 已还原,修复后重跑即可)`, buildLog);

	const artifact = findBuildArtifact(platform);
	if (!artifact) fail("P3", 13, "未在 release/ 找到构建产物", buildLog);
	const artifactPath = path.join(repoRoot, "release", artifact);
	let stagingPath;
	try {
		stagingPath = extractStaging(platform, artifactPath, runDir);
	} catch (e) {
		fail("P3", 13, `提取 staging 失败: ${e.message}`, buildLog);
	}
	emit("P3", "end", { exit: 0, artifact, stagingPath });

	// P4 staging 冒烟(mac 全流程;win/linux portable/AppImage 内部路径不可达则跳过)
	emit("P4", "start");
	const smokeLog = path.join(runDir, "smoke.log");
	const backendJs = stagingBackendJs(platform, stagingPath);
	if (!backendJs) {
		emit("P4", "skip", { reason: `${platform} 的 portable/AppImage 内部 backend.js 不可达,首版跳过冒烟`, log: smokeLog });
	} else {
		const tmpZc = fs.mkdtempSync(path.join(os.tmpdir(), "zc-smoke-"));
		const fixture = writeMinimalFixture(runDir);
		const env = { ...process.env, ZERO_CORE_DIR: tmpZc, ZERO_CORE_TEST_FIXTURE: fixture };
		const { child, getPort } = spawnStagingBackend(platform, stagingPath, env, smokeLog);
		try {
			const port = await waitForReady(getPort, 30000);
			if (!port) fail("P4", 14, "staging backend 30s 未 ready", smokeLog);
			const h = await healthCheck(port);
			if (!h || !h.db || !h.dbWritable || (h.providers ?? 0) < 1 || (h.agents ?? 0) < 1) {
				fail("P4", 14, `health 不达标: ${JSON.stringify(h)}`, smokeLog);
			}
			emit("P4", "end", { exit: 0, health: h });
		} finally {
			shutdownChild(child);
			try { fs.rmSync(tmpZc, { recursive: true, force: true }); } catch {}
		}
	}

	// P5 触发 detached helper(P6 由 helper 独立完成)
	emit("P5", "start");
	const swap = { platform, previousPath, stagingPath, installPath, zeroCoreDir: zcDir, mode: args.mode };
	writeJson(path.join(runDir, "swap.json"), swap);
	const helperPath = path.join(__dirname, "self-update-helper.cjs");
	const helper = spawn(process.execPath, [helperPath, runDir], { detached: true, stdio: "ignore" });
	helper.unref();
	writeJson(path.join(runDir, "helper.pid"), { pid: helper.pid });
	emit("P5", "end", { exit: 0, helperPid: helper.pid });
	emit("DONE", "end", { runDir, hint: "P6 由 detached helper 执行;完成后写 result.json" });
	process.exit(0);
}

main().catch((e) => {
	console.error("[self-update] uncaught:", e);
	process.exit(1);
});
