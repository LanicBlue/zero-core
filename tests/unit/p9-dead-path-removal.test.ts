// P9 验收契约断言:dead path 清理回归
//
// # 文件说明书
//
// ## 核心功能
// 静态扫描源码,锁定 P9 已删的 dead IPC path 不会复活:
//   - src/main/ipc.ts 与 src/main/ipc/ 整目录不存在
//   - registerIpc / typedHandle / setContextGetter / IpcContext 在 src 中零引用
//   - ROUTE_MAP(ipc-proxy.ts R 表 + registerProxyHandlers)是 src/main 唯一
//     ipcMain.handle 注册路径
//   - CronAnalysisManager 旧别名(restoreSchedulesForProjects / scheduleProject /
//     unscheduleProject / rescheduleProject)在 src 中零引用
//   - src/main/index.ts 入口只依赖 backend-spawn / ipc-proxy / mcp-tools cookie /
//     core/constants(不再 import ./ipc 或 ./ipc/*)
//
// 这是一组**契约回归**:P9 后任何 PR 误把这些死路径重新引入都会被立刻发现,
// 而不是在 e2e 才暴露。
//
// ## 输入
// 通过 fs.readFileSync + glob 把 src/ 与 src/main/index.ts 当字符串读入,做
// 子串/正则扫描,不启动任何运行时。
//
// ## 输出
// Vitest 用例。
//
// ## 定位
// tests/unit/ — 静态契约,纯字符串断言。
//
// ## 维护规则
//   - sub1 未来若重启 agent-as-tool / 暴露 P9 后的债务时,本测试要相应更新
//   - 新增 main 进程的 ipcMain.handle 必须走 ROUTE_MAP,否则契约 1.1 会失败
//

import { describe, test, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");
const SRC_MAIN = join(SRC, "main");

// ─── Helpers ─────────────────────────────────────────────────────────

/** Read every .ts/.tsx file under `dir` recursively as one big string. */
function readSourceTree(dir: string): string {
	if (!existsSync(dir)) return "";
	let out = "";
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out += readSourceTree(full);
		} else if (/\.(ts|tsx|js)$/.test(entry.name)) {
			out += "\n//// FILE: " + full + "\n";
			out += readFileSync(full, "utf-8");
		}
	}
	return out;
}

/**
 * Strip // line comments and /* block comments so the contract assertions
 * below flag ONLY real code references, not stale doc pointers that mention
 * a deleted module by name (e.g. wiki-router.ts header still describing the
 * old typedHandle version of the surface).
 */
function stripComments(src: string): string {
	let out = "";
	let i = 0;
	while (i < src.length) {
		// Line comment
		if (src[i] === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		// Block comment
		if (src[i] === "/" && src[i + 1] === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			out += " ";
			continue;
		}
		// String literal — keep contents (so identifiers inside strings are still
		// visible), but skip past it so a // or /* inside a string isn't treated
		// as a comment opener.
		if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
			const q = src[i];
			out += src[i++];
			while (i < src.length && src[i] !== q) {
				if (src[i] === "\\") { out += src[i++]; if (i < src.length) out += src[i++]; }
				else { out += src[i++]; }
			}
			if (i < src.length) out += src[i++];
			continue;
		}
		out += src[i++];
	}
	return out;
}

const SRC_TREE = readSourceTree(SRC);
const SRC_CODE = stripComments(SRC_TREE); // comments stripped — for symbol checks
const MAIN_INDEX = readFileSync(join(SRC_MAIN, "index.ts"), "utf-8");
const IPC_PROXY = readFileSync(join(SRC_MAIN, "ipc-proxy.ts"), "utf-8");

// ─── 1. Dead IPC path removed ────────────────────────────────────────

describe("P9 · dead IPC path removal", () => {
	test("src/main/ipc.ts no longer exists", () => {
		expect(existsSync(join(SRC_MAIN, "ipc.ts"))).toBe(false);
	});

	test("src/main/ipc/ directory no longer exists", () => {
		expect(existsSync(join(SRC_MAIN, "ipc"))).toBe(false);
	});

	test("no src/ code reference to registerIpc (the dead entry)", () => {
		// Comments may still mention it (doc pointers); what matters is no
		// executable call survives.
		expect(SRC_CODE).not.toMatch(/\bregisterIpc\b/);
	});

	test("no src/ code reference to typedHandle / setContextGetter / IpcContext", () => {
		// These were the ctx-assembly mechanism living in the deleted
		// ipc/typed-ipc.ts + ipc/types.ts + ipc/core.ts. With the proxy
		// model (P3+), main process no longer assembles an IpcContext.
		// Stale doc comments in wiki-router.ts still mention typedHandle
		// — those are tolerated; only real code is blocked here.
		expect(SRC_CODE).not.toMatch(/\btypedHandle\b/);
		expect(SRC_CODE).not.toMatch(/\bsetContextGetter\b/);
		expect(SRC_CODE).not.toMatch(/\bIpcContext\b/);
	});

	test("no src/ import of './ipc' or './ipc/' from main", () => {
		// main/index.ts must not pull in a deleted module.
		expect(stripComments(MAIN_INDEX)).not.toMatch(/from\s+["']\.\/ipc(?:\/|["'])/);
	});

	test("no src/ import of any './ipc/*-handlers' submodule", () => {
		expect(SRC_CODE).not.toMatch(/from\s+["'][^"']*\/ipc\/[a-z-]+["']/);
	});
});

// ─── 2. ROUTE_MAP is the sole IPC registration path ──────────────────

describe("P9 · ROUTE_MAP is the sole main-process IPC registration path", () => {
	test("ipc-proxy.ts exposes registerProxyHandlers + connectEventBridge", () => {
		expect(IPC_PROXY).toMatch(/export\s+function\s+registerProxyHandlers\b/);
		expect(IPC_PROXY).toMatch(/export\s+function\s+connectEventBridge\b/);
	});

	test("ipc-proxy.ts declares the R mapping table driving ipcMain.handle", () => {
		// The R object is the single source of truth for IPC channel → REST route.
		// `for (const [channel, route] of Object.entries(R))` is the only loop
		// that calls ipcMain.handle for proxied channels.
		expect(IPC_PROXY).toMatch(/const\s+R\s*:\s*Record<string,\s*RouteMapping>/);
		expect(IPC_PROXY).toMatch(/Object\.entries\(R\)/);
		expect(IPC_PROXY).toMatch(/ipcMain\.handle\(channel,/);
	});

	test("src/main/index.ts only registers via registerProxyHandlers + registerLocalHandlers", () => {
		// Local handlers (window:* / dialog:openDirectory / webfetch:login) are
		// the documented carve-out for things that must run inside Electron.
		expect(MAIN_INDEX).toMatch(/registerProxyHandlers\(port\)/);
		expect(MAIN_INDEX).toMatch(/registerLocalHandlers\(mainWindow!\)/);
		// The local handler set is fixed and enumerated; no new domain handler
		// should sneak in. Verify by checking the exact channels registered.
		const channels = [...MAIN_INDEX.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map((m) => m[1]);
		expect(channels.sort()).toEqual(
			["dialog:openDirectory", "webfetch:login", "window:close", "window:maximize", "window:minimize"].sort(),
		);
	});
});

// ─── 3. CronAnalysisManager legacy aliases absent ────────────────────

describe("P9 · cron legacy aliases removed", () => {
	const LEGACY = [
		"restoreSchedulesForProjects",
		"scheduleProject",
		"unscheduleProject",
		"rescheduleProject",
	];

	for (const name of LEGACY) {
		test(`no src/ code reference to ${name}`, () => {
			// NOTE: restoreSchedules() (singular) is a DIFFERENT, live method
			// called by src/server/recovery.ts — it must remain. The legacy
			// aliases are the project-scoped wrappers (plural / *Project suffix)
			// that project-router used to call.
			expect(SRC_CODE).not.toMatch(new RegExp(`\\b${name}\\b`));
		});
	}
});
