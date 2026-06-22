// E2E 测试 Electron 应用启动器
//
// # 文件说明书
//
// ## 核心功能
// 封装 Playwright Electron 应用启动、窗口就绪等待、Agent 选择和消息发送等 E2E 测试基础设施
//
// ## 输入
// fixture JSON 文件绝对路径（通过 ZERO_CORE_TEST_FIXTURE 环境变量注入主进程）
//
// ## 输出
// TestApp 对象（ElectronApplication、Page、zeroDir、cleanup）
//
// ## 定位
// tests/e2e/helpers/ — E2E 测试辅助层，被所有 spec 文件引用
//
// ## 依赖
// @playwright/test（_electron）、node:fs、node:path、node:os
//
// ## 维护规则
// 应用启动参数变更需在此文件同步
// better-sqlite3 编译说明：开发模式下后端子进程用系统 Node.js spawn（而非 Electron fork），
// 所以 test seed 在后端子进程内完成（startServer 中的 ZERO_CORE_TEST_FIXTURE 分支），无 ABI 问题
//
// Playwright Electron launcher — sets ZERO_CORE_DIR + ZERO_CORE_TEST_FIXTURE
// and lets the production main process seed itself (see src/main/test-setup.ts).
//
// Why we don't seed from the test runner:
//   The test seed runs inside the backend subprocess (startServer handles
//   ZERO_CORE_TEST_FIXTURE), not in Electron's main process. The backend
//   subprocess uses system Node.js (dev mode) or Electron's fork (packaged),
//   both of which have a compatible better-sqlite3.

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

export interface TestApp {
	app: ElectronApplication;
	window: Page;
	zeroDir: string;
	cleanup: () => Promise<void>;
}

export async function launchApp(fixtureAbsPath: string): Promise<TestApp> {
	const zeroDir = mkdtempSync(join(tmpdir(), "zc-e2e-"));

	// Strip ELECTRON_RUN_AS_NODE if inherited (Claude Code / VS Code set this,
	// and it makes the launched Electron boot as plain Node with no app/window).
	const { ELECTRON_RUN_AS_NODE, ...cleanEnv } = process.env;

	const app = await electron.launch({
		args: ["./out/main/index.cjs"],
		cwd: process.cwd(),
		env: {
			...cleanEnv,
			ZERO_CORE_DIR: zeroDir,
			ZERO_CORE_TEST_FIXTURE: fixtureAbsPath,
			NODE_ENV: "test",
		},
	});

	return finishLaunch(app, zeroDir, /* keepTmpDir */ false);
}

/**
 * Fresh-DB launcher — no ZERO_CORE_TEST_FIXTURE, so test-seed.ts does NOT run.
 * Instead fresh-db-seed runs on the empty DB and plants the REAL "zero" agent
 * (with the management toolPolicy) + the software-dev wiki node. The test then
 * bootstraps the Mock provider itself at runtime (via the providers IPC) and
 * drives the real zero agent — the most realistic path, with zero dependence on
 * static test-seed data. Used by tool-wiring.spec.ts.
 */
export async function launchAppFresh(): Promise<TestApp> {
	const zeroDir = mkdtempSync(join(tmpdir(), "zc-e2e-"));
	const { ELECTRON_RUN_AS_NODE, ...cleanEnv } = process.env;
	const app = await electron.launch({
		args: ["./out/main/index.cjs"],
		cwd: process.cwd(),
		env: {
			...cleanEnv,
			ZERO_CORE_DIR: zeroDir,
			NODE_ENV: "test",
		},
	});
	return finishLaunch(app, zeroDir, /* keepTmpDir */ false);
}

/**
 * Real-API launcher — used by context-usage-real-api.spec.ts.
 *
 * Differences from launchApp:
 *   - Does NOT set ZERO_CORE_TEST_FIXTURE (we want the DB's actual default
 *     provider/model, not the seeded Mock provider).
 *   - Does NOT create a fresh tmp ZERO_CORE_DIR — reuses the user's real
 *     ZERO_CORE_DIR (resolved from env or the default ~/.zero-core) so the
 *     real provider config / apiKey is present. Caller still gets cleanup,
 *     but cleanup only closes the app (no tmp dir removal).
 */
export async function launchAppRealApi(): Promise<TestApp> {
	const { ELECTRON_RUN_AS_NODE, ...cleanEnv } = process.env;
	const zeroDir = process.env.ZERO_CORE_DIR ?? join(homedir(), ".zero-core");

	const app = await electron.launch({
		args: ["./out/main/index.cjs"],
		cwd: process.cwd(),
		env: {
			...cleanEnv,
			// Intentionally omit ZERO_CORE_TEST_FIXTURE so test-seed.ts does
			// not run and the DB's real provider/model survives.
			NODE_ENV: "test",
		},
	});

	return finishLaunch(app, zeroDir, /* keepTmpDir */ true);
}

// Shared tail of both launchers: wire stdio, grab the first window, surface
// renderer console errors, build cleanup.
async function finishLaunch(
	app: ElectronApplication,
	zeroDir: string,
	keepTmpDir: boolean,
): Promise<TestApp> {

	app.process().stdout?.on("data", (chunk) => process.stdout.write(`[electron:stdout] ${chunk}`));
	app.process().stderr?.on("data", (chunk) => process.stderr.write(`[electron:stderr] ${chunk}`));

	const window = await app.firstWindow();

	// Surface renderer console errors so failures aren't silent.
	window.on("console", (msg) => {
		const type = msg.type();
		if (type === "error" || type === "warning") {
			process.stderr.write(`[renderer:${type}] ${msg.text()}\n`);
		}
	});
	window.on("pageerror", (err) => {
		process.stderr.write(`[renderer:pageerror] ${err.message}\n${err.stack ?? ""}\n`);
	});

	return {
		app,
		window,
		zeroDir,
		cleanup: async () => {
			try { await app.close(); } catch {}
			// Real-API mode reuses the user's actual ZERO_CORE_DIR — never wipe it.
			if (!keepTmpDir) {
				try { rmSync(zeroDir, { recursive: true, force: true }); } catch {}
			}
		},
	};
}

// Navigate to the Chat page and wait until the agent selector is populated.
export async function waitForAppReady(window: Page): Promise<void> {
	// Default page is "dashboard"; click Chat sidebar button first.
	const chatBtn = window.locator("button[title='Chat']");
	await chatBtn.click({ timeout: 15_000 });
	await window.waitForSelector(".page-chat.page-active", { timeout: 10_000 });
	await window.waitForSelector(".chat-agent-select option[value]:not([value=''])", { timeout: 30_000, state: "attached" });
}

// Select the (single) test agent in the dropdown, then wait for the backend
// activation round-trip (sessionsActivate → setActiveSessionId) to settle.
export async function selectTestAgent(window: Page): Promise<void> {
	const dropdown = window.locator(".chat-agent-select");
	const optionValue = await dropdown.locator("option[value]:not([value=''])").first().getAttribute("value");
	await dropdown.selectOption(optionValue!);
	// data-session-id is set from activeSessionId; empty until activation completes.
	await window.waitForSelector(`.chat-panel[data-session-id]:not([data-session-id=""])`, { timeout: 15_000 });
}

// Send a chat message and return when streaming finishes (cursor-blink detached).
export async function sendChatMessage(window: Page, text: string): Promise<void> {
	await window.locator(".chat-input-bar textarea").fill(text);
	await window.locator(".chat-input-bar button:not(.btn-abort)").click();
	// Wait for streaming to begin, then for it to end
	await window.waitForSelector(".cursor-blink", { timeout: 5_000, state: "attached" }).catch(() => {});
	await window.waitForSelector(".cursor-blink", { timeout: 30_000, state: "detached" });
}

// Select an agent in the chat dropdown by its display name. Used by tool-wiring
// E2E to target the seeded "TestManager" agent (whose toolPolicy carries the
// management-domain tools). Waits for the activation round-trip to settle.
export async function selectAgentByName(window: Page, name: string): Promise<void> {
	const dropdown = window.locator(".chat-agent-select");
	await dropdown.waitFor({ state: "visible", timeout: 15_000 });
	const option = dropdown.locator(`option`, { hasText: name }).first();
	await option.waitFor({ state: "attached", timeout: 15_000 });
	const value = await option.getAttribute("value");
	if (!value) throw new Error(`Agent option not found: ${name}`);
	await dropdown.selectOption(value);
	await window.waitForSelector(`.chat-panel[data-session-id]:not([data-session-id=""])`, { timeout: 15_000 });
}

// Write a MockFixture (as { chunks, usage?, delayMs? }) to a temp JSON file and
// return its absolute path, suitable for `launchApp(...)`. Lets each test compose
// its own tool-call fixture inline instead of committing many JSON files. Typed
// loosely (any[]) to avoid coupling the test layer to the runtime MockFixture type.
let _fixtureCounter = 0;
export function writeFixture(chunks: any[], opts?: { usage?: object; delayMs?: number }): string {
	const fixture = { chunks, usage: opts?.usage, delayMs: opts?.delayMs ?? 5 };
	const dir = mkdtempSync(join(tmpdir(), "zc-fixture-"));
	const path = join(dir, `fixture-${process.pid}-${++_fixtureCounter}.json`);
	writeFileSync(path, JSON.stringify(fixture), "utf-8");
	return path;
}
