// Playwright E2E 测试配置
//
// # 文件说明书
//
// ## 核心功能
// Playwright E2E 测试配置，定义测试目录、超时和并行设置。
//
// ## 输入
// - Playwright 测试命令
//
// ## 输出
// - 测试运行配置
//
// ## 定位
// 测试配置文件，被 Playwright 使用。
//
// ## 依赖
// - @playwright/test - Playwright 测试框架
//
// ## 维护规则
// - 测试需求变更时需更新
// - 保持超时设置合理
//
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 60_000,
	expect: { timeout: 10_000 },
	// Electron app holds state; parallel runs would fight over the same temp dir / window
	fullyParallel: false,
	workers: 1,
	reporter: process.env.CI ? "line" : "list",
	use: {
		actionTimeout: 10_000,
		trace: "retain-on-failure",
	},
});
