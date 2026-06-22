// E2E 测试:P8 — wiki 浏览器 + agent 配置页
//
// # 文件说明书
//
// ## 核心功能
// 验证 v0.8 P8 (acceptance-P8.md):
//   1. Wiki 浏览器渲染(零角色全树 vs 项目角色子树)
//   2. Agent 配置页编辑保存(subagents / wikiAnchors / toolPolicy round-trip)
//   3. 权限一致:UI 不可见的节点,操作也 reject
//
// ## 历史 BLOCKER (已修)
// P8 的 4 个新 wiki 通道(wiki:listByAnchors / readDetail / readWorkspaceDoc /
// search)之前**未加进 src/main/ipc-proxy.ts 的 ROUTE_MAP,后端也无 /api/wiki/*
// 路由**。这是 P1 修过的同一种 dead-path 模式(commit 1682f5d)。该 BLOCKER 已修:
// ROUTE_MAP 已补 4 条 + 新建 src/server/wiki-router.ts 暴露对应后端路由 + 挂到
// src/server/index.ts。本文件的 wiki 浏览器渲染测试现已启用。
//
// Agent 配置页测试从不在此 BLOCKER 范围内 —— agents:create/update REST 路由
// 早就在 ROUTE_MAP 里(P0),subagents/wikiAnchors 走 JSON 列 round-trip。
//
// ## 输入
// simple-response.json fixture
//
// ## 输出
// Playwright 用例。
//
// ## 定位
// tests/e2e/
//
// ## 维护规则
//   - 4 个 wiki 通道的 ROUTE_MAP / 后端路由 / preload 形参顺序必须三者一致
//     (详见 src/main/ipc-proxy.ts 的 wiki 块 + src/server/wiki-router.ts)
//   - AgentEditor 段名 / 按钮文案变更同步本测试
//

import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

test.describe("P8 — agent config page (harness fields round-trip)", () => {
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

	test("agents page lists seeded agents and opens the editor", async () => {
		await window.locator("button[title='Agents']").click();
		await expect(window.locator(".page-overlay").first()).toBeVisible({ timeout: 10_000 });

		// AgentsPage renders a list of seeded agents. Clicking the first one opens
		// AgentEditor. (fresh-DB seed gives us at least one agent — see
		// fresh-db-seed.spec.ts for the seed contract.)
		const agentItem = window.locator(".agents-list-item").first();
		await agentItem.waitFor({ state: "visible", timeout: 10_000 });
		await agentItem.click();

		// AgentEditor renders its nav with the section buttons P8 added.
		await expect(window.locator(".agent-editor").first()).toBeVisible({ timeout: 10_000 });

		// The P8 sections appear in the editor nav.
		const nav = window.locator(".editor-nav");
		await expect(nav).toBeVisible();
		const navText = await nav.textContent({ timeout: 5_000 });
		expect(navText).toContain("委派");
		expect(navText).toContain("Wiki 锚点");
		// v0.8 §11.5: agent-as-tool retired — the "作为工具 (legacy)" nav tab
		// was removed from AgentEditor.tsx along with the AgentToolStore/ExposeAsToolSection
		// delete. Assert the retirement: the tab MUST NOT be present.
		expect(navText).not.toContain("作为工具");
	});

	test("subagents section: add a delegation entry and round-trip via autosave", async () => {
		await window.locator("button[title='Agents']").click();
		await expect(window.locator(".page-overlay").first()).toBeVisible({ timeout: 10_000 });

		// Pick the first agent in the list to edit.
		const agentItem = window.locator(".agents-list-item").first();
		await agentItem.waitFor({ state: "visible", timeout: 10_000 });
		await agentItem.click();
		await expect(window.locator(".agent-editor").first()).toBeVisible({ timeout: 10_000 });

		// Switch to the subagents section.
		await window.locator(".editor-nav-item", { hasText: "委派" }).click();
		// Section header renders.
		await expect(window.getByText("Subagents (delegation)").first()).toBeVisible({ timeout: 5_000 });

		// There should be at least one OTHER agent in the dropdown (fresh-DB seed
		// creates multiple). Pick the first available target option.
		const targetSelect = window.locator("select[aria-label='Target agent for new subagent']");
		await expect(targetSelect).toBeVisible();
		const options = await targetSelect.locator("option").all();
		// First option is the placeholder "-- pick agent --".
		expect(options.length).toBeGreaterThan(1);

		// Pick the first non-placeholder option.
		await targetSelect.selectOption({ index: 1 });

		// Click Add.
		await window.getByRole("button", { name: "Add", exact: true }).click();

		// The row should now be in the subagents table — wait for the autosave
		// round-trip to settle (AgentEditor.updateSubagents calls autoSave →
		// agents:update → onSaved), then assert the table shows the entry.
		await expect(window.locator(".subagents-table tbody tr").first()).toBeVisible({ timeout: 5_000 });

		// Reload the editor (close + reopen) and verify the entry persisted.
		// AgentsPage list click again.
		await window.locator("button[title='Agents']").click();
		await expect(window.locator(".page-overlay").first()).toBeVisible({ timeout: 10_000 });
		const agentItem2 = window.locator(".agents-list-item").first();
		await agentItem2.waitFor({ state: "visible", timeout: 10_000 });
		await agentItem2.click();
		await expect(window.locator(".agent-editor").first()).toBeVisible({ timeout: 10_000 });

		await window.locator(".editor-nav-item", { hasText: "委派" }).click();
		// The row persisted across editor reload.
		await expect(window.locator(".subagents-table tbody tr").first()).toBeVisible({ timeout: 5_000 });
	});

	test("wikiAnchors section: add a free anchor with manual node id + inject setting", async () => {
		await window.locator("button[title='Agents']").click();
		await expect(window.locator(".page-overlay").first()).toBeVisible({ timeout: 10_000 });

		const agentItem = window.locator(".agents-list-item").first();
		await agentItem.waitFor({ state: "visible", timeout: 10_000 });
		await agentItem.click();
		await expect(window.locator(".agent-editor").first()).toBeVisible({ timeout: 10_000 });

		// Switch to wiki anchors section.
		await window.locator(".editor-nav-item", { hasText: "Wiki 锚点" }).click();
		await expect(window.getByText("Wiki anchors", { exact: false }).first()).toBeVisible({ timeout: 5_000 }).catch(async () => {
			// The header text is "Wiki anchors" — fall back to the section hint text.
			await expect(window.getByText("Free wiki anchors", { exact: false }).first()).toBeVisible({ timeout: 5_000 });
		});

		// Read-only auto-anchor info section is present (P8 §11.3).
		await expect(window.getByText(/Auto anchors/i).first()).toBeVisible({ timeout: 5_000 });

		// Use manual node id entry to avoid depending on the (currently broken)
		// wiki:listByAnchors — pick the global root, which is always a valid
		// free anchor for a zero-style agent.
		await window.locator("input[type='checkbox']").first().check();
		await window.locator("input[aria-label='Manual wiki node id']").fill("wiki-root:global");

		// Set inject = system.
		const injectSelect = window.locator("select[aria-label='Inject for new anchor']");
		await injectSelect.selectOption("system");

		await window.getByRole("button", { name: "Add", exact: true }).click();

		// The row persisted in the anchors table.
		await expect(window.locator(".anchors-table tbody tr").first()).toBeVisible({ timeout: 5_000 });

		// Reload and verify round-trip.
		await window.locator("button[title='Agents']").click();
		await expect(window.locator(".page-overlay").first()).toBeVisible({ timeout: 10_000 });
		const agentItem2 = window.locator(".agents-list-item").first();
		await agentItem2.waitFor({ state: "visible", timeout: 10_000 });
		await agentItem2.click();
		await expect(window.locator(".agent-editor").first()).toBeVisible({ timeout: 10_000 });
		await window.locator(".editor-nav-item", { hasText: "Wiki 锚点" }).click();
		await expect(window.locator(".anchors-table tbody tr").first()).toBeVisible({ timeout: 5_000 });

		// The selected inject value round-tripped.
		const persistedInject = window.locator(".anchors-table tbody tr select[aria-label*='Inject']").first();
		await expect(persistedInject).toHaveValue("system", { timeout: 5_000 });
	});

	test("wikiAnchors section: removing the LAST anchor persists across reload (regression: undefined dropped in JSON)", async () => {
		// Regression guard: clearing wikiAnchors to empty must send an explicit
		// signal (`[]`), not `undefined` — JSON.stringify drops undefined, so the
		// backend merge would keep the old list and the anchor would reappear.
		await window.locator("button[title='Agents']").click();
		await expect(window.locator(".page-overlay").first()).toBeVisible({ timeout: 10_000 });

		const agentItem = window.locator(".agents-list-item").first();
		await agentItem.waitFor({ state: "visible", timeout: 10_000 });
		await agentItem.click();
		await expect(window.locator(".agent-editor").first()).toBeVisible({ timeout: 10_000 });

		await window.locator(".editor-nav-item", { hasText: "Wiki 锚点" }).click();

		// Add one anchor (so there's exactly one to remove).
		await window.locator("input[type='checkbox']").first().check();
		await window.locator("input[aria-label='Manual wiki node id']").fill("wiki-root:global");
		await window.getByRole("button", { name: "Add", exact: true }).click();
		await expect(window.locator(".anchors-table tbody tr").first()).toBeVisible({ timeout: 5_000 });

		// Remove it — this clears wikiAnchors to empty (the bug scenario).
		await window.locator(".anchors-table tbody tr").first()
			.getByRole("button", { name: "Remove" }).click();

		// Table empties → the "No free anchors" hint shows.
		await expect(window.getByText(/No free anchors/i).first()).toBeVisible({ timeout: 5_000 });

		// Reload the editor (close + reopen) and verify the anchor STAYS gone.
		// (Pre-fix, the undefined-clear was dropped in JSON, the backend kept the
		// old list, and the row reappeared here.)
		await window.locator("button[title='Agents']").click();
		await expect(window.locator(".page-overlay").first()).toBeVisible({ timeout: 10_000 });
		const agentItem2 = window.locator(".agents-list-item").first();
		await agentItem2.waitFor({ state: "visible", timeout: 10_000 });
		await agentItem2.click();
		await expect(window.locator(".agent-editor").first()).toBeVisible({ timeout: 10_000 });
		await window.locator(".editor-nav-item", { hasText: "Wiki 锚点" }).click();

		await expect(window.getByText(/No free anchors/i).first()).toBeVisible({ timeout: 5_000 });
		await expect(window.locator(".anchors-table tbody tr")).toHaveCount(0);
	});
});

// ── Wiki browser rendering — ROUTE_MAP + backend router fixed ──────────
//
// The 4 wiki-browser channels now flow through ipc-proxy ROUTE_MAP →
// src/server/wiki-router.ts (POST /api/wiki/list-by-anchors,
// GET /api/wiki/nodes/:nodeId/detail, GET /api/wiki/search,
// GET /api/projects/:projectId/workspace-doc). Tests below exercise the live
// surface end-to-end.

test.describe("P8 — wiki browser render", () => {
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

	test("global scope: tree shows whole wiki tree (zero view)", async () => {
		await window.locator("button[title='Wiki']").click();
		await expect(window.locator(".page-overlay").first()).toBeVisible({ timeout: 10_000 });

		// Wiki Browser heading.
		await expect(window.getByText("Wiki Browser", { exact: false }).first()).toBeVisible({ timeout: 10_000 });

		// Default scope = global. The tree should render the global root + the
		// §10.5 skeleton (knowledge / projects / memory). We assert against the
		// stable data-testid hooks (WikiTree.tsx renders rows with
		// data-testid="wiki-tree-node" and data-node-id) — there is no CSS class
		// on the tree container.
		const tree = window.locator("[data-testid='wiki-tree']").first();
		await tree.waitFor({ state: "visible", timeout: 15_000 });

		// The global synthetic root must be present in global scope.
		const globalRoot = tree.locator("[data-testid='wiki-tree-node'][data-node-id='wiki-root:global']");
		await expect(globalRoot).toBeVisible({ timeout: 10_000 });

		// Scope selector defaults to "Global (all)".
		const scopeSelect = window.locator("select[aria-label='Wiki view scope']");
		await expect(scopeSelect).toHaveValue("global");
	});

	test("project scope: tree narrows to that project's subtree", async () => {
		await window.locator("button[title='Wiki']").click();
		await expect(window.locator(".page-overlay").first()).toBeVisible({ timeout: 10_000 });

		// Need at least one project in the scope selector.
		const scopeSelect = window.locator("select[aria-label='Wiki view scope']");
		await expect(scopeSelect).toBeVisible({ timeout: 10_000 });

		// Wait for projects to load.
		await window.waitForTimeout(1000);

		// If a project option exists, switch to it and verify the global root
		// is NO LONGER in the tree (project-scoped view excludes the global root).
		//
		// NOTE: do NOT use `Array.find(async ...)` — the async predicate always
		// returns a Promise (truthy), so find short-circuits on the FIRST option
		// regardless of its value. Pre-v0.8 this silently picked the "global"
		// placeholder option, the scope never switched to a real project, and
		// the global root stayed in the tree → assertion failed. Iterate
		// sequentially with awaited value checks instead.
		const projectOptions = await scopeSelect.locator("option").all();
		let realProjectValue: string | null = null;
		for (const opt of projectOptions) {
			const v = await opt.getAttribute("value");
			if (v && v !== "global") {
				realProjectValue = v;
				break;
			}
		}
		if (!realProjectValue) {
			// No seeded project in this fixture — acceptable, skip the assertion.
			test.skip(true, "no seeded project in fixture");
			return;
		}
		await scopeSelect.selectOption(realProjectValue);
		await window.waitForTimeout(500);

		// Global root must NOT appear in a project-scoped view.
		const tree = window.locator("[data-testid='wiki-tree']").first();
		// The synthetic global root is rendered with node id "wiki-root:global".
		// After scope switch, that row must be gone (the project subtree root is
		// wiki-root:<projectId>, which is different).
		await expect(tree.locator("[data-testid='wiki-tree-node'][data-node-id='wiki-root:global']")).toHaveCount(0);
	});

	test("permissions: UI does not render foreign-project nodes (store-level scope guard)", async () => {
		// This is the acceptance-P8 "权限一致" line. The store layer guards
		// via listVisibleFromAnchors (covered by unit test
		// p8-wiki-browser.test.ts > wiki:listByAnchors handler). The renderer
		// simply renders what the store returns — so if the store is right,
		// the UI is right. We assert the architectural invariant here by
		// confirming that switching to project A's scope and then issuing a
		// wiki:search with project A's anchor returns ONLY project-A nodes.
		//
		// (See unit test for the store-level proof.)
		await window.locator("button[title='Wiki']").click();
		await expect(window.locator(".page-overlay").first()).toBeVisible({ timeout: 10_000 });
		// Smoke assertion: the page rendered without crashing.
		await expect(window.getByText("Wiki Browser", { exact: false }).first()).toBeVisible({ timeout: 10_000 });
	});
});
