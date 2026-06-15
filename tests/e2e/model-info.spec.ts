// E2E 测试：Agent 编辑器模型下拉框中的模型元信息
//
// # 文件说明书
//
// ## 核心功能
// 验证 Agent 编辑器的 Model 下拉框选项渲染「模型名 — 上下文窗口」格式，包含 Mock Model 与 128K 上下文窗口文本
//
// ## 输入
// simple-response.json fixture（mock provider，seed 模型 contextWindow=128000）
//
// ## 输出
// Playwright 测试用例：进入 Agent 编辑器后断言 optgroup option 文本匹配 /Mock Model\s*—\s*128K/
//
// ## 定位
// tests/e2e/ — E2E 测试套件，验证 Agent 编辑器 Model 下拉框元数据展示
//
// ## 依赖
// @playwright/test、./helpers/test-app（launchApp、waitForAppReady、selectTestAgent）
//
// ## 维护规则
// 模型下拉格式变更需同步更新「ModelName — ContextK」正则断言
// seed 模型上下文窗口或名称变更需更新 128K / Mock Model 文本断言
//
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady, selectTestAgent } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

test.describe("Model info in dropdown", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.beforeEach(async () => {
		const app = await launchApp(FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
		await selectTestAgent(window);
	});

	test.afterEach(async () => {
		await cleanup();
	});

	async function navigateToAgentEditor(): Promise<void> {
		const agentsBtn = window.locator(".icon-sidebar-top button[title='Agents']");
		await agentsBtn.click();

		const agentItem = window.locator(".agents-list-item").first();
		await expect(agentItem).toBeVisible({ timeout: 10_000 });
		await agentItem.click();

		await window.waitForSelector(".agent-editor", { timeout: 10_000 });
	}

	function modelSelect() {
		return window.locator(".agent-editor label:has-text('Model') select");
	}

	test("model dropdown renders model options with context window", async () => {
		await navigateToAgentEditor();

		const select = modelSelect();
		await expect(select).toBeVisible({ timeout: 10_000 });

		// The mock provider's model has contextWindow: 128000 from test seed
		const options = select.locator("optgroup option");
		const count = await options.count();
		expect(count).toBeGreaterThanOrEqual(1);

		const text = await options.first().textContent();
		expect(text).toContain("Mock Model");
		expect(text).toContain("128K");
	});

	test("model dropdown option format is 'ModelName — ContextK'", async () => {
		await navigateToAgentEditor();

		const select = modelSelect();
		await expect(select).toBeVisible({ timeout: 10_000 });

		const options = select.locator("optgroup option");
		const count = await options.count();
		expect(count).toBeGreaterThanOrEqual(1);

		const text = await options.first().textContent();
		expect(text).toMatch(/Mock Model\s*—\s*128K/);
	});
});
