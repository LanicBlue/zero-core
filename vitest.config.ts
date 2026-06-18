// Vitest 单元测试配置
//
// # 文件说明书
//
// ## 核心功能
// 配置 Vitest 测试框架的测试文件范围、运行环境和全局设置
//
// ## 输入
// Vitest 配置参数（include、environment、globals）
//
// ## 输出
// Vitest 运行配置，指定 tests/unit/ 下的测试文件在 Node 环境执行
//
// ## 定位
// 项目根目录 — 单元测试框架配置入口
//
// ## 依赖
// vitest/config
//
// ## 维护规则
// 测试文件路径变更需更新 include 模式
// 新增测试环境（如 jsdom）需在此文件中配置
//
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
		globals: false,
		// v0.8 (sub2 P1): Vitest 4.x default `threads` pool fails to inject
		// `globalThis.__vitest_worker__` on Node 24 + Windows, surfacing as
		// "Cannot read properties of undefined (reading 'config')" at the first
		// `describe(...)` call. The `vmThreads` pool runs tests in the main
		// thread's VM context where the worker state IS available. Tracked at
		// cloudflare/workers-sdk#10977 / vitest-dev/vitest (Node 24 worker
		// pool regression). Swap back to `threads` once Vitest fixes it.
		pool: "vmThreads",
	},
});
