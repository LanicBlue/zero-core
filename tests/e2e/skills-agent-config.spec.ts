// E2E 测试:skill-system sub-5/sub-8/sub-10 — per-agent skill 配置(SkillsSection)
//
// # 文件说明书
//
// ## 核心功能
// 验证 acceptance-5 用例 10-14 + sub-8 canAuthorSkills + sub-10 UI 对齐:
//   10. Skills 段挂载在 AgentEditor nav(邻近 工具)
//   11. 勾选某 skill → autosave → 关编辑器重开 → 仍勾选(持久化往返)
//   12. 取消勾选 → autosave → 重开 → 未勾选
//   13. 清空回归:取消全部 → 重开 → 仍空([] vs undefined)
//   14. 持久化值是 id(目录名)而非 display name
//   sub-10: toggle-switch 渲染 / 可点展开 detail panel / origin badge 渲染
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
//   - AgentEditor 段名/按钮文案变更同步本测试
//   - SkillsSection 的 DOM 结构(toggle-switch / tool-item / skill-origin-badge / skill-detail-panel)
//     变更同步本测试
//
// ## sub-10 UI 变更(checkbox → toggle-switch)
// sub-10 起 skill 启用 + canAuthorSkills 都用 toggle-switch(button.toggle-switch,带 `.on` 类表示启用)。
// 没有 `checked` 属性可断言了,改用 `.on` class 存在性判定启用状态。
// 选择器:
//   - skill 启用开关:button.skill-toggle-switch(aria-label="Toggle skill <name>")
//   - canAuthorSkills 开关:button.skill-author-toggle__switch(aria-label="允许此 agent 创建 skill")
//
// ## E2E fixture 限制(诚实声明,sub-5 同源)
// skill-scanner.scanSkills() 硬编码读 homedir() 下的 ~/.zero-core|~/.claude|~/.agents
// (sub-1 实现,本 sub-10 不动)。Playwright launcher 用 ZERO_CORE_DIR 重定向 DB/workspace,
// **不**重定向 homedir()。所以本测试对 skills 列表的断言依赖**真实 home 下已安装的 skill**
// (scanner 每次读盘 → 刷新即得)。若本机无任何 skill,11-14 主体用例自动 skip 并给出明确原因;
// 10(段挂载)与 sub-10 toggle-switch 渲染断言在任何环境下都跑(只要该段挂载且至少有 toggle 渲染)。

import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, waitForAppReady } from "./helpers/test-app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, "fixtures/simple-response.json");

// Helpers ───────────────────────────────────────────────────────────────────

// 打开 Agents overlay → 点第一个 agent → 等 AgentEditor ready。
async function openFirstAgentEditor(window: Awaited<ReturnType<typeof launchApp>>["window"]) {
	await window.locator("button[title='Agents']").click();
	await expect(window.locator(".page-overlay").first()).toBeVisible({ timeout: 10_000 });
	const agentItem = window.locator(".agents-list-item").first();
	await agentItem.waitFor({ state: "visible", timeout: 10_000 });
	await agentItem.click();
	await expect(window.locator(".agent-editor").first()).toBeVisible({ timeout: 10_000 });
}

// 关闭并重开 AgentEditor(回到 AgentsPage → 再点 agent),模拟 reload 往返。
async function reopenFirstAgentEditor(window: Awaited<ReturnType<typeof launchApp>>["window"]) {
	// 点 overlay 外(用 Agents 按钮切换出去再回来)。直接重进 Agents overlay。
	await window.locator("button[title='Chat']").click();
	await openFirstAgentEditor(window);
}

// 等待 autosave 落库。AgentEditor.toggleSkill → autoSave → agents:update(IPC 往返)。
// 给 600ms 缓冲(IPC + sqlite 写 + onDataChanged 回流)。
const AUTOSAVE_SETTLE_MS = 600;
async function waitForAutosave() {
	await new Promise((r) => setTimeout(r, AUTOSAVE_SETTLE_MS));
}

// 经 preload IPC 取第一个 agent 的 id(避免依赖 DOM data-attr,AgentsPage 未挂 data-agent-id)。
async function firstAgentId(window: Awaited<ReturnType<typeof launchApp>>["window"]): Promise<string> {
	const list: Array<{ id: string }> = await (window as any).evaluate(async () =>
		(await (window as any).api.agentsList()) ?? []
	);
	if (!list.length) throw new Error("no seeded agent found");
	return list[0].id;
}

// 经 preload IPC 读单个 agent 的完整记录(含 skillPolicy.enabledSkills)。
async function readAgent(window: Awaited<ReturnType<typeof launchApp>>["window"], id: string): Promise<any> {
	return await (window as any).evaluate(async (agentId: string) =>
		(await (window as any).api.agentsGet(agentId))
	, id);
}

// ── 用例 10:Skills 段挂载 ─────────────────────────────────────────────────

test.describe("sub-5 — SkillsSection mount + grouping", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.beforeEach(async () => {
		const app = await launchApp(FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
	});

	test.afterEach(async () => { await cleanup(); });

	test("用例10: AgentEditor nav 含 Skills 段(邻近 工具)", async () => {
		await openFirstAgentEditor(window);
		const nav = window.locator(".editor-nav");
		await expect(nav).toBeVisible();
		const navText = await nav.textContent({ timeout: 5_000 });
		expect(navText).toContain("Skills");
		// 工具 与 Skills 都在 nav。
		expect(navText).toContain("工具");

		// 切到 Skills 段,section 标题渲染。
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });
	});

	test("用例2(分组): 本软件 skills (source=app) 置顶,外部 (source=user) 其下", async () => {
		await openFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });

		// 分组标题渲染与否取决于本机是否装了 skill。
		const groupTitles = window.locator(".tool-group-title");
		const count = await groupTitles.count();
		// count===0 也接受(本机无 skill 时 SkillsSection 渲染"未检测到")。
		if (count === 0) return;

		// app 分组是否存在取决于本机是否有 source=app 的 skill(scanner 读真实 home,
		// 大多数开发机只有 ~/.claude skills = source=user,无 app-skill)。
		// 仅当 app 分组存在时,才断言它必须置顶(GROUP_ORDER=["app","user"])。
		const titles = await groupTitles.allTextContents();
		const hasApp = titles.some((t) => t.includes("本软件 skills"));
		if (!hasApp) {
			// 本机无 app-skill:置顶断言无意义(无 app 可置顶),合理跳过。
			test.skip(true, "本机无 source=app 的 skill(仅 user 源);app 置顶断言需 app-skill 才能验证");
			return;
		}
		// app 分组存在 → 它必须是第一个。
		const firstTitle = titles[0];
		expect(firstTitle).toContain("本软件 skills");
	});
});

// ── 用例 11-14:toggle-switch 往返 ────────────────────────────────────────────
//
// 这些用例需要本机已装 skill(scanner 读真实 home)。若无 skill,跳过并明示。
// sub-10: checkbox → toggle-switch(button.skill-toggle-switch,带 `.on` class)。
// 没了 `checked` 属性,启用状态改用 `.on` class 存在性判定。

test.describe("sub-5/sub-10 — SkillsSection toggle-switch round-trip (requires installed skill)", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.beforeEach(async () => {
		const app = await launchApp(FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
	});

	test.afterEach(async () => { await cleanup(); });

	test("用例11+12+14: 勾选→持久化(id 而非 name)→取消→重开未勾选", async () => {
		await openFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });

		// 拿第一个 skill toggle-switch。若本机无 skill → skip。
		const toggles = window.locator("button.skill-toggle-switch");
		const toggleCount = await toggles.count();
		if (toggleCount === 0) {
			test.skip(true, "本机无已安装 skill(scanner 读 homedir);11/12/14 需 skill 才能验证往返");
			return;
		}

		const firstToggle = toggles.first();
		// 通过同行 .tool-name 文本反查 display name;id 通过 IPC 读回验证。
		const skillRow = firstToggle.locator("xpath=ancestor::div[contains(@class,'tool-item')]");
		const displayName = (await skillRow.locator(".tool-name").textContent())?.trim() ?? "";

		// ── 用例 11:勾选 → autosave → 重开 → 仍勾选 ──
		// 起始状态可能是 on(legacy agent undefined=注入全部,但 form 归一化为 [] 全不勾);
		// 先确保 off,再点开,得到确定的"已启用"状态。
		const wasOn = await firstToggle.evaluate((el) => el.classList.contains("on"));
		if (wasOn) {
			await firstToggle.click();
			await waitForAutosave();
		}
		await firstToggle.click();
		await waitForAutosave();

		// 重开编辑器,验证持久化。
		await reopenFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });

		// 行顺序可能稳定(id 升序 + source 分组),但保险起见按 display name 定位。
		const toggleByName = window
			.locator(".tool-item", { hasText: displayName })
			.locator("button.skill-toggle-switch");
		await expect(toggleByName).toBeVisible({ timeout: 5_000 });
		// sub-10: 启用 = `.on` class 存在。
		await expect(toggleByName).toHaveClass(/on/, { timeout: 5_000 });

		// ── 用例 14:持久化的值是 id(目录名)而非 display name ──
		// 经 IPC 直接读 agent 记录的 skillPolicy.enabledSkills,断言含目录名 id。
		const agentId = await firstAgentId(window);
		const agent: any = await readAgent(window, agentId);
		const enabled: string[] = agent?.skillPolicy?.enabledSkills ?? [];
		expect(enabled.length).toBeGreaterThan(0);
		// 读回所有 skill 的 id 集合做区分。
		const skills: Array<{ id: string; name: string }> = await (window as any).evaluate(async () =>
			(await (window as any).api.skillsList()) ?? []
		);
		const idSet = new Set(skills.map((s) => s.id));
		// 持久化的每项必须落在 id 集合里(目录名),证明存的是 id。
		for (const v of enabled) {
			expect(idSet, `enabledSkills 应含 id(目录名),但 "${v}" 不在 id 集合中`).toContain(v);
		}

		// ── 用例 12:取消勾选 → autosave → 重开 → 未勾选 ──
		await toggleByName.click();
		await waitForAutosave();
		await reopenFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });
		const toggleAfterUncheck = window
			.locator(".tool-item", { hasText: displayName })
			.locator("button.skill-toggle-switch");
		// sub-10: 未启用 = 没有 `.on` class。
		const classAfter = await toggleAfterUncheck.evaluate((el) => el.className);
		expect(classAfter, `取消后 toggle 不应有 on class,实际: ${classAfter}`).not.toMatch(/on/);
	});

	test("用例13(关键): 清空全部勾选 → 重开 → 仍空([] vs undefined 回归)", async () => {
		// 回归守卫:清空 enabledSkills 必须显式发 [],不能 undefined。
		// JSON.stringify 丢 undefined → 后端 merge 留旧值 → 取消最后一个 skill 不持久化。
		// SkillsSection 的空数组透传由 AgentEditor.toggleSkill 保证(见该文件注释)。
		await openFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });

		const toggles = window.locator("button.skill-toggle-switch");
		const toggleCount = await toggles.count();
		if (toggleCount === 0) {
			test.skip(true, "本机无已安装 skill;13 在空列表下天然为空,无回归可测");
			return;
		}

		// 先全部启用(造出"非空"状态)。
		const allToggles = await toggles.all();
		for (const t of allToggles) {
			const isOn = await t.evaluate((el) => el.classList.contains("on"));
			if (!isOn) {
				await t.click();
				await waitForAutosave();
			}
		}

		// 确认已落库非空(否则回归测试本身不成立)。
		const agentId = await firstAgentId(window);
		const agentBefore: any = await readAgent(window, agentId);
		const before = agentBefore?.skillPolicy?.enabledSkills ?? [];
		expect(before.length, "勾选后 enabledSkills 应非空(否则回归测试前提不成立)").toBeGreaterThan(0);

		// 全部取消(此即"清空到 [] "的回归场景)。
		for (const t of await toggles.all()) {
			const isOn = await t.evaluate((el) => el.classList.contains("on"));
			if (isOn) {
				await t.click();
				await waitForAutosave();
			}
		}

		// 重开编辑器,验证所有 toggle 仍未启用(清空持久化,旧值没残留)。
		await reopenFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });
		const reopenedToggles = window.locator("button.skill-toggle-switch");
		const reopenedCount = await reopenedToggles.count();
		for (let i = 0; i < reopenedCount; i++) {
			const cls = await reopenedToggles.nth(i).evaluate((el) => el.className);
			expect(cls, `清空后 toggle#${i} 不应有 on class,实际: ${cls}`).not.toMatch(/on/);
		}

		// 直接读 IPC 验证 enabledSkills === [](而非残留旧数组,也非 undefined)。
		const agentAfter: any = await readAgent(window, agentId);
		const after = agentAfter?.skillPolicy?.enabledSkills;
		// 必须是数组(非 undefined)且为空 —— 这是 feedback-unique-message-keys 同类陷阱的关键断言。
		expect(Array.isArray(after), `enabledSkills 必须是数组,实际: ${typeof after}`).toBe(true);
		expect(after.length, "清空后 enabledSkills 必须是 [],旧值不能残留").toBe(0);
	});
});

// ── sub-10: UI 对齐 ToolsSection 验证(toggle-switch + 可点展开 + origin badge) ──
//
// 这些用例不依赖本机装 skill 之外的状态:有 skill 才能验证 badge/展开交互;
// 无 skill 时 toggle-switch 渲染断言仍能跑(canAuthorSkills toggle 永远渲染)。

test.describe("sub-10 — SkillsSection UI 对齐 (toggle-switch + 展开 + origin badge)", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.beforeEach(async () => {
		const app = await launchApp(FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
	});

	test.afterEach(async () => { await cleanup(); });

	test("sub-10: canAuthorSkills 用 toggle-switch 渲染(非 checkbox)", async () => {
		await openFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });

		// canAuthorSkills 开关 = button.skill-author-toggle__switch(toggle-switch)。
		// 不应是 <input checkbox>。
		const authorToggle = window.locator("button.skill-author-toggle__switch.toggle-switch");
		await expect(authorToggle).toBeVisible({ timeout: 5_000 });
		const tagName = await authorToggle.evaluate((el) => el.tagName.toLowerCase());
		expect(tagName).toBe("button");

		// 旧的 checkbox 选择器必须不存在(sub-10 已移除)。
		const legacyCheckbox = window.locator("input.skill-author-toggle__checkbox");
		await expect(legacyCheckbox).toHaveCount(0);
	});

	test("sub-10: 每个 skill 用 toggle-switch 渲染(非 checkbox);有 skill 时还验 badge", async () => {
		await openFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });

		const toggles = window.locator("button.skill-toggle-switch");
		const count = await toggles.count();
		// 无 skill 时只验"canAuthorSkills toggle 是 toggle-switch"(上个用例已覆盖),这里 skip。
		if (count === 0) {
			test.skip(true, "本机无已安装 skill;skill toggle-switch / badge 需 skill 才能验证");
			return;
		}

		// 第一个 skill toggle 必须是 toggle-switch + button。
		const firstToggle = toggles.first();
		const tagName = await firstToggle.evaluate((el) => el.tagName.toLowerCase());
		expect(tagName).toBe("button");
		await expect(firstToggle).toHaveClass(/toggle-switch/);

		// 旧 checkbox 选择器必须不存在。
		const legacyCheckbox = window.locator("input.skill-checkbox");
		await expect(legacyCheckbox).toHaveCount(0);

		// 每个 skill 行都有 origin badge(skill-origin-badge)。
		const badges = window.locator(".skill-origin-badge");
		const badgeCount = await badges.count();
		expect(badgeCount, "skill 行数应与 origin badge 数一致").toBe(count);

		// 每个 badge 文本必须是已知 origin label 之一(防止 origin 未 stamp 显示空/undefined)。
		const validLabels = new Set(["ZERO-CORE", "CLAUDE", "AGENTS"]);
		for (let i = 0; i < badgeCount; i++) {
			const text = (await badges.nth(i).textContent())?.trim() ?? "";
			expect(validLabels, `origin badge #${i} 文本 "${text}" 不在合法集合`).toContain(text);
		}
	});

	test("sub-10: 点 skill tool-info 展开详情面板(完整 description + id + origin)", async () => {
		await openFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });

		const toggles = window.locator("button.skill-toggle-switch");
		const count = await toggles.count();
		if (count === 0) {
			test.skip(true, "本机无已安装 skill;展开交互需 skill 才能验证");
			return;
		}

		// 初始无 detail panel。
		const detailPanels = window.locator(".skill-detail-panel");
		await expect(detailPanels).toHaveCount(0);

		// 点第一个 skill 的 tool-info → 展开。
		const firstRow = toggles.first().locator("xpath=ancestor::div[contains(@class,'tool-item')]");
		await firstRow.locator(".tool-info").click();

		// 出现 1 个 skill-detail-panel(复用 tool-detail-panel 外壳)。
		await expect(detailPanels).toHaveCount(1, { timeout: 5_000 });

		// 详情含 id(<code>)与 origin badge(skill-detail-origin)。
		await expect(detailPanels.locator(".skill-detail-id code")).toBeVisible();
		await expect(detailPanels.locator(".skill-detail-origin")).toBeVisible();
		const originText = (await detailPanels.locator(".skill-detail-origin").textContent())?.trim() ?? "";
		expect(["ZERO-CORE", "CLAUDE", "AGENTS"], `详情 origin "${originText}" 不合法`).toContain(originText);

		// 再点 → 收起。
		await firstRow.locator(".tool-info").click();
		await expect(detailPanels).toHaveCount(0);
	});
});

// ── sub-8 (acceptance-8 用例 11): canAuthorSkills toggle 往返 ──────────────
//
// SkillsSection 顶部的「允许此 agent 创建 skill」toggle-switch,aria-label 唯一可定位
// (区别于 skill 启用 toggle,后者 aria-label="Toggle skill <name>")。
// 往返:启用 → autosave → 关重开 → 仍启用;取消 → 关重开 → 未启用。读 IPC 验证
// 持久化值是 boolean(显式 true/false,非 undefined — 同 enabledSkills=[] 回归同类陷阱)。
// sub-10: checkbox → toggle-switch;启用状态改用 `.on` class 判定。

test.describe("sub-8/sub-10 — SkillsSection canAuthorSkills toggle round-trip", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.beforeEach(async () => {
		const app = await launchApp(FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
	});

	test.afterEach(async () => { await cleanup(); });

	test("用例11: 启用「允许创建 skill」→ autosave → 关重开 → 仍启用;取消 → 未启用", async () => {
		await openFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });

		const authorToggle = window.locator("button.skill-author-toggle__switch.toggle-switch");
		await expect(authorToggle).toBeVisible({ timeout: 5_000 });

		// 起始可能启用(legacy agent);先确保关闭,得到确定的"未启用"起点。
		const wasOn = await authorToggle.evaluate((el) => el.classList.contains("on"));
		if (wasOn) {
			await authorToggle.click();
			await waitForAutosave();
		}

		// ── 启用 → autosave → 关重开 → 仍启用 ──
		await authorToggle.click();
		await waitForAutosave();
		await reopenFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });
		const authorToggleAfter = window.locator("button.skill-author-toggle__switch.toggle-switch");
		await expect(authorToggleAfter).toHaveClass(/on/, { timeout: 5_000 });

		// 持久化值 = true(显式 boolean,非 undefined)。
		const agentId = await firstAgentId(window);
		const agentOn: any = await readAgent(window, agentId);
		expect(agentOn?.skillPolicy?.canAuthorSkills, "勾选后 canAuthorSkills 必须 === true").toBe(true);

		// ── 取消 → autosave → 关重开 → 未启用 ──
		await authorToggleAfter.click();
		await waitForAutosave();
		await reopenFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });
		const authorToggleFinal = window.locator("button.skill-author-toggle__switch.toggle-switch");
		const classFinal = await authorToggleFinal.evaluate((el) => el.className);
		expect(classFinal, `取消后 toggle 不应有 on class,实际: ${classFinal}`).not.toMatch(/on/);

		// 持久化值 = false(显式 boolean,非 undefined — 同 enabledSkills=[] 回归陷阱:
		// JSON.stringify 丢 undefined → 后端 merge 留旧值 → 取消不持久化)。
		const agentOff: any = await readAgent(window, agentId);
		expect(agentOff?.skillPolicy?.canAuthorSkills, "取消后 canAuthorSkills 必须 === false(显式,非 undefined)").toBe(false);
	});
});
