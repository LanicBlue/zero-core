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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate ZERO_CORE_DIR for unit tests. WIKI_DISK_ROOT (= ZERO_CORE_DIR/wiki)
// is a GLOBAL path resolved at module load (core/config.ts), independent of each
// test's temp SQLite DB — so without this, every unit test that creates a wiki
// node leaks its body file into the REAL ~/.zero-core/wiki/, keyed by a fresh
// nodeId that outlives the throwaway test DB. This accumulated 447 orphan files
// + 164 orphan project dirs in ~/.zero-core (cleaned 2026-06). Pinning ZERO_CORE_DIR
// to a per-run temp dir here (before any test module imports config.ts) routes
// those files to OS temp instead. Set only when not already overridden.
if (!process.env.ZERO_CORE_DIR) {
	process.env.ZERO_CORE_DIR = mkdtempSync(join(tmpdir(), "zc-unit-"));
}

export default defineConfig({
	test: {
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
		globals: false,
		// v0.8 (sub2 P1, updated §11.5 cleanup): pool is `forks`. The earlier
		// `vmThreads` choice worked around a Vitest 4.x / Node 24 worker-
		// injection regression, but vmThreads runs tests under Vite's CJS-
		// interop loader which chokes on @exodus/bytes (shipped as ESM,
		// require()'d via CJS by html-encoding-sniffer — a transitive dep of
		// jsdom, pulled in through fetch-tools → config-router). The `forks`
		// pool uses Node's native module loader and handles the mixed ESM/CJS
		// graph correctly, which also unblocks the rest-routers memory-config
		// tests. Re-evaluate if the original Node 24 worker regression
		// resurfaces (cloudflare/workers-sdk#10977).
		pool: "forks",
	},
});
