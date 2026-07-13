#!/usr/bin/env node
// better-sqlite3 原生模块 ABI 重编译(electron 或 node)
//
// # 文件说明书
//
// ## 核心功能
// better-sqlite3 是 native addon,dev 后端用系统 node 跑(需 Node ABI),
// 打包后端用 Electron fork 跑(需 Electron ABI)。同一个 .node 二进制不能同时满足。
// 本脚本把 node_modules/better-sqlite3 的 build/Release/better_sqlite3.node
// 在两种 ABI 间切换:打包前编 Electron、打包后还原 Node(恢复 dev)。
//
// ## 为什么不用 @electron/rebuild / electron-builder npmRebuild
// better-sqlite3 12.11.1 没发布 Electron 43(ABI 148)预编译,electron-builder 的
// @electron/rebuild 默认 buildFromSource=false → 找不到预编译就 no-op,留下 Node ABI
// 的 .node,打包后后端启动崩 "NODE_MODULE_VERSION 141 vs 148"。故关掉 npmRebuild,
// 用本脚本显式 node-gyp --runtime=electron 从源码编译(已验证产出 148)。
//
// ## 输入
// argv[2] = electron | node(electron=编给已装的 Electron;node=还原给系统 Node)
//
// ## 输出
// 重写 node_modules/better-sqlite3/build/Release/better_sqlite3.node
// 退出码 0=成功;非 0=失败(通常是缺编译工具链:mac 要 Xcode CLT,win 要 MSVC,linux 要 make+gcc)
//
// ## 维护规则
// Electron 大版本升级后,ABI 变化由本脚本自动跟随(从 node_modules/electron 读版本)。
// 若将来 better-sqlite3 发布了对应 Electron 预编译,可改回 prebuild-install 免编译路径。

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const target = process.argv[2];
if (target !== "electron" && target !== "node") {
	console.error("usage: rebuild-native.cjs <electron|node>");
	process.exit(2);
}

const repoRoot = path.join(__dirname, "..");
const bsq = path.join(repoRoot, "node_modules", "better-sqlite3");
if (!fs.existsSync(bsq)) {
	console.error(`[rebuild-native] 找不到 ${bsq}(先 npm install)`);
	process.exit(1);
}

// node-gyp 二进制:优先项目内 .bin,其次 npx
const nodeGypBin = path.join(repoRoot, "node_modules", ".bin", "node-gyp");
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

function run(cmd, args, cwd, label) {
	// node-gyp 输出量大,继承 stdio 让用户看到编译进度/错误
	const res = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
	if (res.status !== 0) {
		console.error(`[rebuild-native] ${label} 失败 (exit ${res.status})`);
		process.exit(res.status ?? 1);
	}
}

if (target === "electron") {
	let electronVer;
	try {
		electronVer = require(path.join(repoRoot, "node_modules", "electron", "package.json")).version;
	} catch {
		console.error("[rebuild-native] 读不到 electron 版本(确保 electron 已装)");
		process.exit(1);
	}
	const arch = process.arch;
	console.log(`[rebuild-native] 编译 better-sqlite3 给 Electron ${electronVer} (${arch}, ABI 148)…`);
	// node-gyp 走项目内 .bin;没有则用 npx 兜底
	const useBin = fs.existsSync(nodeGypBin);
	const cmd = useBin ? nodeGypBin : "npx";
	const args = useBin
		? ["rebuild", "--release", "--runtime=electron", `--target=${electronVer}`, `--arch=${arch}`, "--disturl=https://electronjs.org/headers"]
		: ["node-gyp", "rebuild", "--release", "--runtime=electron", `--target=${electronVer}`, `--arch=${arch}`, "--disturl=https://electronjs.org/headers"];
	run(cmd, args, bsq, "node-gyp --runtime=electron");
	console.log("[rebuild-native] ✅ 已编为 Electron ABI(dev 暂不可用,打包后请跑 rebuild-native node 还原)");
} else {
	console.log("[rebuild-native] 还原 better-sqlite3 给系统 Node…");
	const useBin = fs.existsSync(nodeGypBin);
	const cmd = useBin ? nodeGypBin : "npx";
	const args = useBin ? ["rebuild", "--release"] : ["node-gyp", "rebuild", "--release"];
	run(cmd, args, bsq, "node-gyp (node)");
	console.log("[rebuild-native] ✅ 已还原为 Node ABI(dev 可用)");
}
