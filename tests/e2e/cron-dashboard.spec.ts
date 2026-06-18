// E2E 测试：Cron 调度台 (v0.8 P4 §9.5)
//
// # 文件说明书
//
// ## 核心功能
// 验证 Cron 调度台顶级页 (acceptance-P4.md「调度台 UI」):
//   - Cron 按钮在侧栏可见且位于 Agents 之后 (顶级页, 移出 settings)
//   - 点击进入调度台, 渲染 24h 时间轴 + 闹钟卡片网格
//   - 点击 + New Cron 弹出闹钟式新建表单 (mode 切换 / agent / project / 时间)
//   - 分组切换 (By Agent / By Project) 按钮可见
//
// ## 输入
// simple-response.json fixture (mock provider)
//
// ## 输出
// Playwright 用例: 检查 .cron-dashboard / .cron-timeline / .cron-group-toggle /
// .cron-alarm-form / .cron-mode-row 等选择器
//
// ## 定位
// tests/e2e/ — E2E 测试套件, 验证调度台渲染与基础交互
//
// ## 依赖
// @playwright/test、./helpers/test-app (launchApp, waitForAppReady)
//

import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

test.describe("Cron Scheduling Console (P4 §9.5)", () => {
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

	test("cron icon is visible in sidebar after Agents", async () => {
		const sidebar = window.locator(".icon-sidebar-top");
		await expect(sidebar).toBeVisible();

		const buttons = sidebar.locator("button");
		const count = await buttons.count();
		let agentsIdx = -1;
		let cronIdx = -1;
		for (let i = 0; i < count; i++) {
			const title = await buttons.nth(i).getAttribute("title");
			if (title === "Agents") agentsIdx = i;
			if (title === "Cron Scheduling Console") cronIdx = i;
		}
		expect(agentsIdx).toBeGreaterThanOrEqual(0);
		expect(cronIdx).toBeGreaterThanOrEqual(0);
		// Cron sits as a top-level page, immediately after Agents.
		expect(cronIdx).toBeGreaterThan(agentsIdx);
	});

	test("clicking cron icon shows the scheduling console with 24h timeline", async () => {
		const cronBtn = window.locator(".icon-sidebar-top button[title='Cron Scheduling Console']");
		await cronBtn.click();

		const dashboard = window.locator(".cron-dashboard");
		await expect(dashboard).toBeVisible();

		// Header title.
		await expect(dashboard.locator("h2")).toHaveText("Cron Scheduling Console");

		// 24h timeline axis.
		await expect(dashboard.locator(".cron-timeline")).toBeVisible();
		await expect(dashboard.locator(".cron-timeline-axis")).toBeVisible();
		// Hour ticks (00:00 .. 24:00).
		const ticks = dashboard.locator(".cron-timeline-tick-label");
		expect(await ticks.count()).toBeGreaterThan(0);

		// Group toggle (By Agent / By Project).
		await expect(dashboard.locator(".cron-group-toggle")).toBeVisible();
		await expect(dashboard.locator("text=By Agent")).toBeVisible();
		await expect(dashboard.locator("text=By Project")).toBeVisible();

		// New Cron button present.
		await expect(dashboard.locator("button", { hasText: "+ New Cron" })).toBeVisible();
	});

	test("clicking + New Cron opens the alarm-style create form with mode switch", async () => {
		const cronBtn = window.locator(".icon-sidebar-top button[title='Cron Scheduling Console']");
		await cronBtn.click();
		const dashboard = window.locator(".cron-dashboard");

		await dashboard.locator("button", { hasText: "+ New Cron" }).click();

		const form = dashboard.locator(".cron-alarm-form");
		await expect(form).toBeVisible();
		await expect(form.locator(".cron-alarm-form-title")).toHaveText("New Cron");

		// Mode switch shows the three P4 cadence modes.
		const modeRow = form.locator(".cron-mode-row");
		await expect(modeRow).toBeVisible();
		for (const m of ["interval", "alarm", "once"]) {
			await expect(modeRow.locator("button", { hasText: m })).toBeVisible();
		}
	});

	test("empty state shows a helpful hint when no crons exist", async () => {
		const cronBtn = window.locator(".icon-sidebar-top button[title='Cron Scheduling Console']");
		await cronBtn.click();
		const dashboard = window.locator(".cron-dashboard");

		// No cron cards yet — the empty hint is shown.
		await expect(dashboard.locator(".settings-empty")).toBeVisible();
		expect(await dashboard.locator(".cron-group").count()).toBe(0);
	});
});
