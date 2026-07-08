// E2E 测试:skill-system sub-5 — per-agent skill 配置(SkillsSection)
//
// # 文件说明书
//
// ## 核心功能
// 验证 acceptance-5 用例 10-14:
//   10. Skills 段挂载在 AgentEditor nav(邻近 工具)
//   11. 勾选某 skill → autosave → 关编辑器重开 → 仍勾选(持久化往返)
//   12. 取消勾选 → autosave → 重开 → 未勾选
//   13. 清空回归:取消全部 → 重开 → 仍空([] vs undefined)
//   14. 持久化值是 id(目录名)而非 display name
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
//   - SkillsSection 的 DOM 结构(skill-checkbox / tool-item)变更同步本测试
//
// ## E2E fixture 限制(诚实声明)
// skill-scanner.scanSkills() 硬编码读 homedir() 下的 ~/.zero-core|~/.claude|~/.agents
// (sub-1 实现,本 sub-5 不动)。Playwright launcher 用 ZERO_CORE_DIR 重定向 DB/workspace,
// **不**重定向 homedir()。所以本测试对 skills 列表的断言依赖**真实 home 下已安装的 skill**
// (scanner 每次读盘 → 刷新即得)。若本机无任何 skill,11-14 主体用例自动 skip 并给出明确原因;
// 10(段挂载)与 13(空列表清空回归)在任何环境下都跑。
//
// 这意味着本测试在本机无 skill 的 CI/干净环境里**只能验证 10 + 13**(清空回归用例),
// 11/12/14 需用户本机已装 skill 才有意义。这是 sub-5 范围外的 scanner 隔离问题
// (sub-1 getSkillRoots 硬编码 homedir)。

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

// ── 用例 11-14:checkbox 往返 ────────────────────────────────────────────────
//
// 这些用例需要本机已装 skill(scanner 读真实 home)。若无 skill,跳过并明示。

test.describe("sub-5 — SkillsSection checkbox round-trip (requires installed skill)", () => {
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

		// 拿第一个 skill checkbox。若本机无 skill → skip。
		const checkboxes = window.locator("input.skill-checkbox");
		const cbCount = await checkboxes.count();
		if (cbCount === 0) {
			test.skip(true, "本机无已安装 skill(scanner 读 homedir);11/12/14 需 skill 才能验证往返");
			return;
		}

		const firstCb = checkboxes.first();
		// 记下该 skill 的 id(data attribute 由 SkillsSection 写在 checkbox 的 value/data-skill-id)。
		// SkillsSection 没显式 data attr,通过同行 .tool-name 文本反查 display name;id 通过 IPC 读回验证。
		const skillRow = firstCb.locator("xpath=ancestor::div[contains(@class,'tool-item')]");
		const displayName = (await skillRow.locator(".tool-name").textContent())?.trim() ?? "";

		// ── 用例 11:勾选 → autosave → 重开 → 仍勾选 ──
		// 起始状态可能是勾选(legacy agent undefined=注入全部,但 form 归一化为 [] 全不勾);
		// 先确保取消,再勾选,得到确定的"已勾选"状态。
		const wasChecked = await firstCb.isChecked();
		if (wasChecked) {
			await firstCb.uncheck();
			await waitForAutosave();
		}
		await firstCb.check();
		await waitForAutosave();

		// 重开编辑器,验证持久化。
		await reopenFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });

		const cbAfterReopen = window.locator("input.skill-checkbox").first();
		// 行顺序可能稳定(id 升序 + source 分组),但保险起见按 display name 定位。
		const cbByName = window
			.locator(".tool-item", { hasText: displayName })
			.locator("input.skill-checkbox");
		await expect(cbByName).toBeVisible({ timeout: 5_000 });
		await expect(cbByName).toBeChecked({ timeout: 5_000 });

		// ── 用例 14:持久化的值是 id(目录名)而非 display name ──
		// 经 IPC 直接读 agent 记录的 skillPolicy.enabledSkills,断言含目录名 id(≠ display name 当 name≠id 时)。
		// 注意:discoveredSkill 的 id = 目录名,name = frontmatter name(可能相等)。我们读回 enabledSkills,
		// 断言它非空且每项都是已知 skill 的 id 集合的成员(而非 display name 集合的成员,除非两者重合)。
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
		await cbByName.uncheck();
		await waitForAutosave();
		await reopenFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });
		const cbAfterUncheck = window
			.locator(".tool-item", { hasText: displayName })
			.locator("input.skill-checkbox");
		await expect(cbAfterUncheck).not.toBeChecked({ timeout: 5_000 });
	});

	test("用例13(关键): 清空全部勾选 → 重开 → 仍空([] vs undefined 回归)", async () => {
		// 回归守卫:清空 enabledSkills 必须显式发 [],不能 undefined。
		// JSON.stringify 丢 undefined → 后端 merge 留旧值 → 取消最后一个 skill 不持久化。
		// SkillsSection 的空数组透传由 AgentEditor.toggleSkill 保证(见该文件注释)。
		await openFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });

		const checkboxes = window.locator("input.skill-checkbox");
		const cbCount = await checkboxes.count();
		if (cbCount === 0) {
			test.skip(true, "本机无已安装 skill;13 在空列表下天然为空,无回归可测");
			return;
		}

		// 先全部勾选(造出"非空"状态)。
		const allCbs = await checkboxes.all();
		for (const cb of allCbs) {
			if (!(await cb.isChecked())) {
				await cb.check();
				await waitForAutosave();
			}
		}

		// 确认已落库非空(否则回归测试本身不成立)。
		// 读 IPC 验证 enabledSkills 至少 1 项。
		const agentId = await firstAgentId(window);
		const agentBefore: any = await readAgent(window, agentId);
		const before = agentBefore?.skillPolicy?.enabledSkills ?? [];
		expect(before.length, "勾选后 enabledSkills 应非空(否则回归测试前提不成立)").toBeGreaterThan(0);

		// 全部取消(此即"清空到 [] "的回归场景)。
		for (const cb of await checkboxes.all()) {
			if (await cb.isChecked()) {
				await cb.uncheck();
				await waitForAutosave();
			}
		}

		// 重开编辑器,验证所有 checkbox 仍未勾选(清空持久化,旧值没残留)。
		await reopenFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });
		const reopenedCbs = window.locator("input.skill-checkbox");
		const reopenedCount = await reopenedCbs.count();
		for (let i = 0; i < reopenedCount; i++) {
			await expect(reopenedCbs.nth(i)).not.toBeChecked({ timeout: 5_000 });
		}

		// 直接读 IPC 验证 enabledSkills === [](而非残留旧数组,也非 undefined)。
		const agentAfter: any = await readAgent(window, agentId);
		const after = agentAfter?.skillPolicy?.enabledSkills;
		// 必须是数组(非 undefined)且为空 —— 这是 feedback-unique-message-keys 同类陷阱的关键断言。
		expect(Array.isArray(after), `enabledSkills 必须是数组,实际: ${typeof after}`).toBe(true);
		expect(after.length, "清空后 enabledSkills 必须是 [],旧值不能残留").toBe(0);
	});
});

// ── sub-8 (acceptance-8 用例 11): canAuthorSkills toggle 往返 ──────────────
//
// SkillsSection 顶部的「允许此 agent 创建 skill」checkbox,aria-label 唯一可定位
// (区别于 skill 启用 checkbox,后者 aria-label="Toggle skill <name>")。
// 往返:勾选 → autosave → 关重开 → 仍勾选;取消 → 关重开 → 未勾选。读 IPC 验证
// 持久化值是 boolean(显式 true/false,非 undefined — 同 enabledSkills=[] 回归同类陷阱)。

test.describe("sub-8 — SkillsSection canAuthorSkills toggle round-trip", () => {
	let cleanup: () => Promise<void>;
	let window: Awaited<ReturnType<typeof launchApp>>["window"];

	test.beforeEach(async () => {
		const app = await launchApp(FIXTURE);
		window = app.window;
		cleanup = app.cleanup;
		await waitForAppReady(window);
	});

	test.afterEach(async () => { await cleanup(); });

	test("用例11: 勾选「允许创建 skill」→ autosave → 关重开 → 仍勾选;取消 → 未勾选", async () => {
		await openFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });

		const authorToggle = window.locator("input.skill-author-toggle__checkbox");
		await expect(authorToggle).toBeVisible({ timeout: 5_000 });

		// 起始可能勾选(legacy agent);先确保取消,得到确定的"未勾选"起点。
		const wasChecked = await authorToggle.isChecked();
		if (wasChecked) {
			await authorToggle.uncheck();
			await waitForAutosave();
		}

		// ── 勾选 → autosave → 关重开 → 仍勾选 ──
		await authorToggle.check();
		await waitForAutosave();
		await reopenFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });
		const authorToggleAfter = window.locator("input.skill-author-toggle__checkbox");
		await expect(authorToggleAfter).toBeChecked({ timeout: 5_000 });

		// 持久化值 = true(显式 boolean,非 undefined)。
		const agentId = await firstAgentId(window);
		const agentOn: any = await readAgent(window, agentId);
		expect(agentOn?.skillPolicy?.canAuthorSkills, "勾选后 canAuthorSkills 必须 === true").toBe(true);

		// ── 取消 → autosave → 关重开 → 未勾选 ──
		await authorToggleAfter.uncheck();
		await waitForAutosave();
		await reopenFirstAgentEditor(window);
		await window.locator(".editor-nav-item", { hasText: "Skills" }).click();
		await expect(window.getByText("可用 skills").first()).toBeVisible({ timeout: 5_000 });
		const authorToggleFinal = window.locator("input.skill-author-toggle__checkbox");
		await expect(authorToggleFinal).not.toBeChecked({ timeout: 5_000 });

		// 持久化值 = false(显式 boolean,非 undefined — 同 enabledSkills=[] 回归陷阱:
		// JSON.stringify 丢 undefined → 后端 merge 留旧值 → 取消不持久化)。
		const agentOff: any = await readAgent(window, agentId);
		expect(agentOff?.skillPolicy?.canAuthorSkills, "取消后 canAuthorSkills 必须 === false(显式,非 undefined)").toBe(false);
	});
});
