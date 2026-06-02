// Playwright Electron launcher — sets ZERO_CORE_DIR + ZERO_CORE_TEST_FIXTURE
// and lets the production main process seed itself (see src/main/test-setup.ts).
//
// Why we don't seed from the test runner:
//   better-sqlite3 is compiled against Electron's NODE_MODULE_VERSION. Loading
//   it from plain Node (Playwright's test runner) throws. The seed must run
//   inside Electron.

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
			try { rmSync(zeroDir, { recursive: true, force: true }); } catch {}
		},
	};
}

// Wait until the agent selector is populated (core modules loaded).
export async function waitForAppReady(window: Page): Promise<void> {
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
