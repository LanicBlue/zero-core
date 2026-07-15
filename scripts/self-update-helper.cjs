#!/usr/bin/env node
// 自更新切换/重启/回退 helper(P6,detached)
//
// # 文件说明书
//
// ## 核心功能
// 由 self-update.cjs 在 P5 用 detached + stdio:ignore 拉起,独立于 zero-core/Claude 存活。
// 读 <runDir>/swap.json → 确保 zero-core 退出 → 替换安装 → relaunch → 轮询 health →
// 失败自动回退(previous) + relaunch 旧版。全过程写 helper.log + result.json。
//
// ## 输入
// argv[2] = runDir(含 swap.json)
//
// ## 输出
// <runDir>/helper.log、<runDir>/result.json {ok, rolledBack?, error?}
//
// ## 定位
// scripts/ 自更新工作流 P6 执行体;detached,父进程退出不被杀。
//
// ## 维护规则
// 平台分支与 self-update.cjs 的 replaceInstall/relaunch 保持一致。

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const runDir = process.argv[2];
if (!runDir) { console.error("usage: self-update-helper.cjs <runDir>"); process.exit(2); }

const logFile = path.join(runDir, "helper.log");
const resultFile = path.join(runDir, "result.json");
function log(msg) {
	try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

let swap;
try {
	swap = JSON.parse(fs.readFileSync(path.join(runDir, "swap.json"), "utf-8"));
	fs.writeFileSync(path.join(runDir, "helper.pid"), JSON.stringify({ pid: process.pid }));
} catch (e) {
	log(`初始化失败: ${e.message}`);
	process.exit(3);
}

const { platform, previousPath, stagingPath, installPath, zeroCoreDir } = swap;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 确保 zero-core 已退出(P2 可能已退;否则再写 sentinel 等失联)
async function ensureQuit() {
	const sentinel = path.join(zeroCoreDir, ".quit-requested");
	try { fs.writeFileSync(sentinel, String(Date.now())); } catch {}
	const portFile = path.join(zeroCoreDir, "runtime.port");
	let port = null;
	try { port = parseInt(fs.readFileSync(portFile, "utf-8").trim(), 10); } catch {}
	if (!port) { await sleep(3000); return; }
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		try {
			await fetch(`http://127.0.0.1:${port}/api/ready`, { signal: AbortSignal.timeout(1000) });
		} catch { return; } // 失联 = 已退出
		await sleep(500);
	}
	log("警告:zero-core 20s 未退出,继续替换(可能残留进程)");
}

// 替换:把 staging 放到 install 路径(P1 已把旧安装 mv 走,槽位空)
function replaceInstall() {
	if (platform === "mac") {
		const r = spawnSync("ditto", [stagingPath, installPath]); // ditto 保签名/元数据
		if (r.status !== 0) throw new Error("ditto 替换失败: " + (r.stderr ? r.stderr.toString() : ""));
	} else if (platform === "linux") {
		fs.copyFileSync(stagingPath, installPath);
		fs.chmodSync(installPath, 0o755);
	} else {
		fs.copyFileSync(stagingPath, installPath); // win portable exe
	}
}

function relaunch() {
	let exe, opts;
	if (platform === "mac") {
		exe = path.join(installPath, "Contents", "MacOS", "Zero-Core");
		opts = { detached: true, stdio: "ignore" };
	} else {
		exe = installPath;
		opts = { detached: true, stdio: "ignore", windowsHide: platform === "win" };
	}
	// 删除 ELECTRON_RUN_AS_NODE:否则 packaged app 被 Electron 当 node 跑、不进 GUI 主进程
	// (VSCode Claude Code 扩展会注入此变量;dev.js 也专门 delete 它)
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	const child = spawn(exe, [], { ...opts, env });
	child.unref();
	return child.pid;
}

// 轮询新 zero-core 的 runtime.port + /api/health
async function verifyHealth(timeoutMs) {
	const portFile = path.join(zeroCoreDir, "runtime.port");
	const deadline = Date.now() + timeoutMs;
	let seenPort = 0;
	while (Date.now() < deadline) {
		try {
			const port = parseInt(fs.readFileSync(portFile, "utf-8").trim(), 10);
			if (port) {
				const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
				const j = await r.json();
				if (j && j.db && j.dbWritable) return true;
				seenPort = port;
			}
		} catch { /* 还没 ready */ }
		await sleep(1000);
	}
	log(`verifyHealth 超时,lastPort=${seenPort}`);
	return false;
}

function rollback() {
	if (previousPath && fs.existsSync(previousPath)) {
		if (fs.existsSync(installPath)) {
			try { fs.rmSync(installPath, { recursive: true, force: true }); } catch {}
		}
		fs.renameSync(previousPath, installPath);
		log("已恢复 previous 到安装位置");
	} else {
		log("回退失败:previous 不存在,无法恢复");
	}
}

function writeResult(obj) {
	fs.writeFileSync(resultFile, JSON.stringify({ ...obj, ts: Date.now() }, null, 2));
	log(`result: ${JSON.stringify(obj)}`);
}

async function main() {
	log(`helper pid=${process.pid} platform=${platform} install=${installPath}`);
	// 防御:installPath 必须是有效字符串。packaged 模式由 self-update.cjs P0 保证非空;
	// 此处兜底 swap.json 损坏 / 非常规调用(如 mode=dev 回归 installPath=null),
	// 避免 ditto [staging, null] 把 staging 复制到 cwd/"null" + 误导性"替换完成"日志,
	// 也避免 ensureQuit 写 sentinel 误伤恰好运行中的 zero-core。
	if (!installPath || typeof installPath !== "string") {
		writeResult({ ok: false, rolledBack: false, error: `installPath 无效(${JSON.stringify(installPath)}),跳过替换` });
		return;
	}
	try {
		await ensureQuit();
		replaceInstall();
		log("替换完成");
		const pid = relaunch();
		log(`relaunch pid=${pid}`);
		const ok = await verifyHealth(30000);
		if (ok) {
			writeResult({ ok: true });
			log("验活通过,更新成功");
		} else {
			log("验活失败,回退到 previous");
			try { rollback(); relaunch(); } catch (e) { log(`回退 relaunch 异常: ${e.message}`); }
			writeResult({ ok: false, rolledBack: true, error: "health 验活失败或超时" });
		}
	} catch (e) {
		log(`异常: ${e.stack || e.message}`);
		try { rollback(); relaunch(); } catch {}
		writeResult({ ok: false, rolledBack: true, error: e.message });
	}
}

main();
