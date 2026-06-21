// E2E 测试:上下文使用量指示器 — real-api 通道
//
// # 文件说明书
//
// ## 核心功能
// 验证当 DB 配置的默认 provider/model 是真实(非 mock、带 apiKey)provider 时,
// 发送一条消息会产生非零 token 用量,并驱动 `.context-usage` 指示器渲染真实
// 数字 + 非零进度条宽度。
//
// 与 `context-usage.spec.ts` 的区别:那个用 fixture mock provider,fixed
// 流式返回;本测试**完全不注入 fixture**,改用 DB 已配置的默认 provider 真跑
// 一次 LLM turn,验证真实链路上 usage 事件 → contextInfo → UI 的端到端连通。
//
// ## 触发条件
// 默认 **skip**。只有在环境变量 `ZERO_CORE_E2E_REAL_API=1` 时才跑:
//   - 真实 API 调用花钱、依赖网络、容易 flaky,默认不进常规套件。
//   - 在本地手动:`ZERO_CORE_E2E_REAL_API=1 npx playwright test context-usage-real-api.spec.ts`
//
// ## skip 条件
// 跑前先读 DB 默认 provider/model(经 `window.api.configGet()` + `window.api.providersList()`)
//   - 默认 provider 是 mock 或 type=mock → skip(没真实 API 可用)
//   - 默认 provider 没有 apiKey → skip(无法发真实请求)
//   - env gate 没开 → skip
//
// ## 输入
// DB 现状(用户提供真实 provider 配置)
//
// ## 输出
// Playwright 用例,默认 skip
//
// ## 定位
// tests/e2e/ — real-api 测试通道,与 mock fixture 套件解耦
//
// ## 依赖
// @playwright/test、./helpers/test-app
//
// ## 维护规则
// 默认 provider 字段名(workspace.defaultProvider / defaultModel)变更需同步
// skip-detection 块
//

import { test, expect } from "@playwright/test";
import { launchAppRealApi, waitForAppReady, selectTestAgent, sendChatMessage } from "./helpers/test-app.js";

const REAL_API_ENABLED = process.env.ZERO_CORE_E2E_REAL_API === "1";

test.describe("Context usage indicator — real API (env-gated)", () => {
	test.skip(!REAL_API_ENABLED, "set ZERO_CORE_E2E_REAL_API=1 to run real-API context-usage test");

	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchAppRealApi>>["window"];

	test.beforeEach(async () => {
		// launchAppRealApi does NOT inject ZERO_CORE_TEST_FIXTURE, so the DB's
		// real default provider/model + apiKey survive. test-seed.ts is a no-op.
		const app = await launchAppRealApi();
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
	});

	test.afterEach(async () => {
		await cleanup();
	});

	test("real-API turn produces non-zero token usage and renders the indicator", async () => {
		const api = (window as any).api as {
			configGet: () => Promise<{ defaultProvider?: string; defaultModel?: string }>;
			providersList: () => Promise<Array<{ name: string; type: string; apiKey?: string }>>;
			agentsList?: () => Promise<Array<{ id: string; name: string; provider?: string; model?: string }>>;
		};

		// ─── 1. Resolve the DB's configured default provider. ───────────────
		const cfg = await api.configGet();
		const providers = await api.providersList();
		const defaultProviderName = cfg.defaultProvider;
		const defaultProvider = providers.find((p) => p.name === defaultProviderName) ?? providers[0];

		// Skip when there's no real provider available.
		if (!defaultProvider) {
			test.skip(true, "no provider configured in DB");
			return;
		}
		if (defaultProvider.type === "mock") {
			test.skip(true, "default provider is mock — no real API to exercise");
			return;
		}
		if (!defaultProvider.apiKey) {
			test.skip(true, `provider ${defaultProvider.name} has no apiKey — cannot make real call`);
			return;
		}

		// ─── 2. Find an agent using this provider (or the default model). ────
		// Prefer agentsList (REST-backed). Fall back to the first agent in the
		// chat dropdown if agentsList isn't exposed.
		let targetAgentId: string | undefined;
		try {
			const agents = await api.agentsList?.();
			if (agents && agents.length > 0) {
				const match =
					agents.find((a) => a.provider === defaultProvider.name) ?? agents[0];
				targetAgentId = match?.id;
			}
		} catch {
			// fall through to dropdown
		}

		if (targetAgentId) {
			// Try selecting the specific agent; ignore failure and fall back to
			// selectTestAgent which picks the first option in the dropdown.
			await window
				.locator(`.chat-agent-select option[value="${targetAgentId}"]`)
				.count()
				.then(async (n) => {
					if (n > 0) {
						await window.locator(".chat-agent-select").selectOption(targetAgentId);
						await window.waitForSelector(
							`.chat-panel[data-session-id]:not([data-session-id=""])`,
							{ timeout: 15_000 },
						);
					} else {
						await selectTestAgent(window);
					}
				});
		} else {
			await selectTestAgent(window);
		}

		// ─── 3. Send a message and wait for the turn to finish. ─────────────
		// Keep the prompt tiny to minimize cost.
		await sendChatMessage(window, "Say OK.");

		// ─── 4. Assert context-usage renders with real numbers. ─────────────
		const contextUsage = window.locator(".context-usage");
		await expect(contextUsage).toBeVisible({ timeout: 30_000 });

		const text = window.locator(".context-usage-text");
		await expect(text).toBeVisible({ timeout: 15_000 });
		const content = (await text.textContent()) ?? "";
		// Text contains either "N in · M out | WK" (inputTokens>0 path) or
		// "X / WK" (legacy path). Both contain digits + a unit (K/M/G or plain).
		expect(content).toMatch(/\d+/);

		const fill = window.locator(".context-usage-fill");
		await expect(fill).toBeVisible({ timeout: 10_000 });
		const widthStr = await fill.evaluate((el) => (el as HTMLElement).style.width);
		const width = parseFloat(widthStr);
		// Real usage should be > 0 (some tokens always consumed) and <= 100.
		expect(width).toBeGreaterThan(0);
		expect(width).toBeLessThanOrEqual(100);
	});
});
