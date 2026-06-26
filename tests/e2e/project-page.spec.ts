// E2E 测试：项目页 (v0.8 P5 §8.5 — 替换看板)
//
// # 文件说明书
//
// ## 核心功能
// 验证 P5 项目页渲染 (acceptance-P5.md「项目页」+「测试 e2e」):
//   - 侧栏 Requirements 入口进入项目页(左列表 + 右三 tab)
//   - 三 tab(Dashboard + Activity / Project View / Kanban)切换渲染
//   - 看板 tab 不退化(列标题、+ New Requirement 按钮)
//   - + New Project 弹窗 + 创建项目后出现在左栏
//
// ## 输入
// simple-response.json fixture(mock provider,避免真实 LLM 调用)
//
// ## 输出
// Playwright 用例:文本选择器为主(组件未挂 className hook,用文本匹配 tab 名、
// 卡片标题、按钮文案)。
//
// ## 定位
// tests/e2e/ — E2E 测试套件,验证项目页渲染与基础交互
//
// ## 依赖
// @playwright/test、./helpers/test-app(launchApp, waitForAppReady)
//
// ## 维护规则
//   - tab 名 / 按钮文案变更 → 同步 ProjectPage.tsx 与本测试
//   - 新建项目默认填值逻辑变更 → 同步 handleCreate
//
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

test.describe("Project page (P5 §8.5)", () => {
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

	test("Requirements sidebar entry opens the project page (left list + 3 tabs)", async () => {
		// Sidebar entry — title="Requirements" still routes to activePage="requirements"
		// (now mounted as ProjectPage instead of KanbanPage).
		await window.locator("button[title='Requirements']").click();

		// Page overlay mounts; let the project list fetch settle.
		await expect(window.locator(".page-overlay")).toBeVisible({ timeout: 10_000 });
		await window.waitForTimeout(1500);

		// ProjectPage toolbar heading.
		const toolbarText = await window.locator(".page-overlay").first().textContent({ timeout: 5000 });
		// DEBUG aid: surface what actually rendered when this assertion fails.
		if (!toolbarText || !toolbarText.includes("Projects")) {
			console.error("Project page toolbar did not render Projects heading. Page text:", toolbarText?.slice(0, 500));
		}
		expect(toolbarText).toContain("Projects");

		// + New Project button present.
		const newProjectBtn = window.getByText("+ New Project", { exact: false });
		await expect(newProjectBtn.first()).toBeVisible({ timeout: 10_000 });

		// All three tab labels are present.
		for (const label of ["Dashboard + Activity", "Project View", "Kanban"]) {
			await expect(window.getByText(label, { exact: false }).first()).toBeVisible({ timeout: 5_000 });
		}
	});

	test("switching tabs renders each tab body", async () => {
		await window.locator("button[title='Requirements']").click();
		await expect(window.locator(".page-overlay")).toBeVisible({ timeout: 10_000 });
		await expect(window.locator(".page-overlay").getByText("Projects", { exact: false }).first()).toBeVisible({ timeout: 10_000 });

		// Wait for fetchProjects + auto-select to settle before clicking tabs.
		await window.waitForTimeout(1000);

		// Project View tab — switch & verify ProjectPage didn't crash. With no
		// project selected, the body shows EmptyState; once one IS selected it
		// shows the container view cards. Either way the toolbar "Projects"
		// heading stays visible.
		await window.getByRole("button", { name: "Project View" }).first().click();
		await window.waitForTimeout(500);
		await expect(window.locator(".page-overlay").getByText("Projects", { exact: false }).first()).toBeVisible({ timeout: 10_000 });

		// Kanban tab body shows the kanban toolbar.
		await window.getByRole("button", { name: "Kanban" }).first().click();
		await window.waitForTimeout(500);
		// KanbanBoard toolbar (slim): "Kanban" heading.
		await expect(window.locator(".page-overlay").getByText("Kanban", { exact: false }).first()).toBeVisible({ timeout: 10_000 });
		// + New Requirement button (kanban tab functionality preserved — the
		// original KanbanPage had this button and it must survive the refactor).
		await expect(window.getByRole("button", { name: "+ New Requirement" })).toBeVisible({ timeout: 10_000 });
	});

	test("creating a project via the + New Project modal adds it to the left list", async () => {
		await window.locator("button[title='Requirements']").click();
		await expect(window.locator(".page-overlay")).toBeVisible({ timeout: 10_000 });
		await expect(window.locator(".page-overlay").getByText("Projects", { exact: false }).first()).toBeVisible({ timeout: 10_000 });
		// Let fetchProjects finish + auto-select settle before interacting.
		await window.waitForTimeout(500);

		// Open the modal.
		await window.getByRole("button", { name: "+ New Project" }).click({ timeout: 10_000 });
		// Modal heading.
		await expect(window.getByText("New Project", { exact: false }).first()).toBeVisible({ timeout: 5_000 });

		// Fill the form. Workspace dir is required (immutable after creation);
		// point it at the test's own zero dir so it's a real path.
		const inputs = window.locator("input");
		await inputs.nth(0).fill("E2EProj");
		await inputs.nth(1).fill(process.cwd() + "/e2e-fixture-ws");

		// Submit (the modal's Create button, NOT the toolbar's + New Project).
		await window.getByRole("button", { name: "Create", exact: true }).click({ timeout: 10_000 });

		// Left list now shows the project name.
		await expect(window.getByText("E2EProj").first()).toBeVisible({ timeout: 10_000 });

		// Dashboard tab auto-loaded for the newly-selected project: shows the
		// "Update Status" / "Resource Consumption" cards.
		await expect(window.getByText("Update Status").first()).toBeVisible({ timeout: 15_000 });
		await expect(window.getByText("Resource Consumption").first()).toBeVisible();
		// Activity section header.
		await expect(window.getByText("Activity (requirements by status)")).toBeVisible();
	});
});
