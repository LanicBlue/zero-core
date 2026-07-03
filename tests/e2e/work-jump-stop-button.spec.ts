// E2E: work-trigger 跳转对话后 Send/Stop 按钮状态
//
// # 文件说明书
//
// ## 核心功能
// 复现并锁死"在项目页触发工位 → 自动跳到 chat → 运行中应显示 Stop,运行完恢复 Send"
// 这条路径。回归点:
//   - 后端 markRunning 发 session_running,前端 streamingSessions 加入该 session
//     (或 pull-on-display 据 isRunning 自愈)→ 按钮变 Stop。
//   - 运行结束 agent_end → finishStreaming → 按钮回 Send(不卡 streaming)。
//
// ## 输入
// 慢速 mock fixture(多 chunk + delayMs),保证断言窗口内 run 仍在 isBusy=true。
// test-seed 已在 TestProject 上种一个已分配、enabled、requiredTools=[] 的 "E2E Work"。
//
// ## 输出
// Playwright 用例:点"立即触发" → 断言 .btn-abort(Stop)可见 → 运行完隐藏。
//
// ## 定位
// tests/e2e/ — 工位跳转按钮状态回归
//
// ## 依赖
// @playwright/test、./helpers/test-app(launchApp, waitForAppReady, writeFixture)
//
// ## 维护规则
//   - 按钮文案/className(btn-abort)变更 → 同步 ChatPanel.tsx 与本测试
//   - 工位卡渲染结构变更 → 同步 ProjectPage.tsx ProjectWorkCard
//
import { test, expect } from "@playwright/test";
import { launchApp, waitForAppReady, writeFixture } from "./helpers/test-app.js";

test.describe("Work-trigger jump → chat Stop button", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.beforeEach(async () => {
		// Slow fixture: ~16 text chunks at 250ms + finish ≈ 4s of streaming. Keeps
		// isBusy=true through the Stop-button assertion, then drains so we can also
		// assert the button returns to Send (no stuck streaming).
		const chunks = [
			...Array.from({ length: 16 }, (_, i) => ({ type: "text", text: `chunk ${i} ` })),
			{ type: "finish", finishReason: "stop" },
		];
		const fixturePath = writeFixture(chunks as any[], {
			usage: { inputTokens: 5, outputTokens: 8, totalTokens: 13 },
			delayMs: 250,
		});
		const app = await launchApp(fixturePath);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
	});

	test.afterEach(async () => {
		await cleanup();
	});

	test("shows Stop while the triggered work run is in-flight, then Send after it ends", async () => {
		// Open the project page (Requirements sidebar entry).
		await window.locator("button[title='Requirements']").click();
		await expect(window.locator(".page-overlay")).toBeVisible({ timeout: 10_000 });
		// Let fetchProjects + auto-select (TestProject is the only project) settle.
		await window.waitForTimeout(1000);

		// "Worker" tab hosts the work cards (项目工位).
		await window.getByRole("button", { name: "Worker" }).first().click({ timeout: 10_000 });
		await window.waitForTimeout(500);

		// The seeded "E2E Work" card (only work on TestProject). Scope the trigger
		// button to its row so the selector is robust if more works appear later.
		const workRow = window.locator("div").filter({ hasText: "E2E Work" }).filter({ hasText: "立即触发" }).first();
		await expect(workRow).toBeVisible({ timeout: 10_000 });
		await workRow.getByRole("button", { name: "立即触发" }).click({ timeout: 10_000 });

		// doTrigger switches to the chat page (.page-active) after the trigger
		// round-trip. The Stop button (.btn-abort) must be visible while isBusy.
		await expect(window.locator(".page-chat.page-active")).toBeVisible({ timeout: 10_000 });
		await expect(window.locator(".btn-abort")).toBeVisible({ timeout: 6_000 });

		// After the run drains (agent_end → finishStreaming), Stop disappears and
		// Send returns — guards against a stuck streaming flag.
		await expect(window.locator(".btn-abort")).toBeHidden({ timeout: 25_000 });
	});
});
