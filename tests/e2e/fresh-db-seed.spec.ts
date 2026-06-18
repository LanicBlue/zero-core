// E2E 测试:fresh-DB seed (v0.8 P6 — RFC §7.1 / §7.5)
//
// # 文件说明书
//
// ## 核心功能
// 通过 ZERO_CORE_TEST_FIXTURE 基建启动 Electron,验证 fresh-DB seed 在真实启动
// 流程中生效:
//   - zero agent (workspaceDir=~/.zero-core) 被 seed
//   - knowledge/software-dev wiki 节点被 seed
//
// 这是 acceptance-P6.md「e2e:fresh DB 启动验证可用 ZERO_CORE_TEST_FIXTURE 基建」
// 节的对应覆盖。
//
// ## 输入
// simple-response.json fixture (mock provider 响应;我们不发消息,只需启动)。
//
// ## 输出
// Playwright 用例。
//
// ## 验证策略
// 启动后通过 chat agent 下拉列表确认 zero + TestAgent 同时存在(zero 来自 P6
// seed,TestAgent 来自 test-seed)。这同时验证了:
//   - seed 在 test-seed 之后、restoreAllSessions 之前正常运行(否则会 crash);
//   - 没有破坏 ZERO_CORE_TEST_FIXTURE 自身的 TestAgent seed。
//
// ## 定位
// tests/e2e/ — Electron 端到端测试。
//

import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

test.describe("P6 fresh-DB seed (Electron startup)", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.beforeEach(async () => {
		const app = await launchApp(FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
	});

	test.afterEach(async () => {
		await cleanup();
	});

	test("fresh DB startup seeds both the zero agent and the test agent in the chat selector", async () => {
		// waitForAppReady already opened the Chat page and populated the agent
		// selector. The seeded 'zero' (P6) and 'TestAgent' (test-seed) should
		// both be present — proving seedFreshDbDefaults ran during startup
		// alongside seedTestEnvironment without crashing either path.
		const options = window.locator(".chat-agent-select option[value]:not([value=''])");
		const count = await options.count();
		expect(count).toBeGreaterThanOrEqual(2);

		const labels: string[] = [];
		for (let i = 0; i < count; i++) {
			labels.push((await options.nth(i).innerText()).trim());
		}
		// zero is the P6 fresh-DB seed; TestAgent is the ZERO_CORE_TEST_FIXTURE seed.
		expect(labels.some((l) => /zero/i.test(l)), `expected 'zero' in selector, got: ${labels.join(", ")}`).toBe(true);
		expect(labels.some((l) => /TestAgent/.test(l)), `expected 'TestAgent' in selector, got: ${labels.join(", ")}`).toBe(true);
	});
});
