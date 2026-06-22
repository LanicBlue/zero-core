// E2E:工具接线 + 行为评价(真实路径,无静态 seed)
//
// # 文件说明书
//
// ## 核心功能
// 驱动**真实的 zero agent**(fresh-db-seed 播的,带 management toolPolicy)调用
// 四个 action 工具(Project/AgentRegistry/Cron/Wiki),验证:
//   1. 工具在 zero 的工具集里(注入未断 → 有 .tool-block)
//   2. args 正确到达执行层(union schema 未坏 → .tool-done 非 .tool-error)
//   3. 输出内容符合 per-tool 行为规约(tool-evaluator.ts)
//
// ## 真实路径(无 test-seed 依赖)
// launchAppFresh 不设 ZERO_CORE_TEST_FIXTURE → test-seed 不跑 → fresh-db-seed
// 播真实 zero + software-dev wiki。测试运行时经真实 IPC 自举:
//   - providersCreate:建 Mock provider(LLM 测试替身,不可避免)
//   - agentsUpdate(zero):给 zero 显式挂 Mock provider(绕开运行时默认不刷新)
//   - projectsCreate:建一个真项目,供 Project list 返回
// 其余(agent 身份、wiki 内容)都是 fresh-db-seed 的真实产物。
//
// ## 它能抓住的回归
// - roleTag/policy 注入断(工具不进集合)→ 无 .tool-block
// - 顶层 schema 坏(union)→ .tool-error(注:union 可读性回归由单测兜)
//
// ## 定位
// tests/e2e/ — Playwright spec
//

import { test, expect, type Page } from "@playwright/test";
import { launchAppFresh, waitForAppReady, sendChatMessage, selectAgentByName, writeFixture } from "./helpers/test-app.js";
import { TOOL_CASES } from "./helpers/tool-evaluator.js";

// Mock provider 创建输入 — 镜像 test-seed.ts 的 Mock provider 形状。type:"mock"
// 让 provider-factory 走 MockLanguageModel,b baseUrl 指向 fixture JSON。
function mockProviderInput(fixturePath: string) {
	return {
		name: "Mock",
		type: "mock" as const,
		apiKey: "test",
		baseUrl: fixturePath,
		models: [{ id: "mock-1", name: "Mock Model", group: "Mock", contextWindow: 128000, maxTokens: 16384 }],
		enabled: true,
		isSystem: false,
	};
}

// 自举:建 Mock provider → 给 zero 挂上。全走真实 IPC,无静态 seed。评价器验
// 「执行成功 + 结构正确」,不绑定特定数据,故无需预建 project 等。
async function bootstrapRealistic(window: Page, fixturePath: string): Promise<void> {
	// 1. Mock provider(LLM 替身,不可避免)
	await window.evaluate((input) => (window as any).api.providersCreate(input), mockProviderInput(fixturePath));
	// 2. zero 显式挂 Mock provider/model。agentService 的默认 provider 是启动时
	//    一次性加载的,运行时 configUpdate 改 DB 不刷新内存默认;故直接 agentsUpdate,
	//    createLoopForSession 读 agent.provider 即生效。
	const zero = await window.evaluate(async () => {
		const list = await (window as any).api.agentsList();
		return list.find((a: any) => a.name === "zero");
	});
	expect(zero, "fresh-db-seed should have planted the real zero agent").toBeTruthy();
	await window.evaluate(
		({ id, input }) => (window as any).api.agentsUpdate(id, input),
		{ id: zero.id, input: { provider: "Mock", model: "mock-1" } },
	);
}

for (const tc of TOOL_CASES) {
	test(`tool-wiring: ${tc.label}`, async () => {
		const fixturePath = writeFixture(
			[{ type: "tool-call", toolName: tc.toolName, input: tc.args }, { type: "finish", finishReason: "stop" }],
		);
		const app = await launchAppFresh();
		const window = app.window;
		try {
			await waitForAppReady(window);
			await bootstrapRealistic(window, fixturePath);
			// 驱动真实 zero(fresh-db-seed 播,带 management 工具)。
			await selectAgentByName(window, "zero");
			await sendChatMessage(window, "run");

			// 回归信号 #1:工具必须在集合里(注入断则无 .tool-block)
			const block = window.locator(".tool-block").first();
			await block.waitFor({ state: "visible", timeout: 30_000 });

			// 回归信号 #2:args 必须完整到达(union 坏 → .tool-error)
			await expect(block.locator(".tool-block-name")).toContainText(tc.toolName, { timeout: 30_000 });
			await expect(block).toHaveClass(/tool-done/, { timeout: 30_000 });
			await expect(block).not.toHaveClass(/tool-error/);

			// 展开读结果,跑 per-tool 内容评价器
			await block.locator(".tool-block-header").click();
			const resultEl = block.locator(".tool-block-result");
			await resultEl.waitFor({ state: "visible", timeout: 10_000 });
			const resultText = (await resultEl.innerText()).trim();
			const verdict = tc.check(resultText);
			expect(verdict.pass, verdict.detail ?? `evaluator failed for ${tc.toolName}`).toBe(true);
		} finally {
			await app.cleanup();
		}
	});
}
