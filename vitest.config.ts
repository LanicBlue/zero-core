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
		// sub-11 (2026-07-07): pool is `threads` (was `forks`).
		//
		// ROOT CAUSE being defended against: Vitest 4.x on Windows + the
		// `forks` pool has a process-cwd binding bug — when the runner's cwd
		// is exactly the project root (the normal case: VS Code opens this
		// dir, or `npm run test:unit` is invoked here), the fork-worker IPC
		// channel can fail to initialize on some machine states (e.g. when a
		// file-watcher holds the dir), so the runtime config never reaches the
		// child and every `describe(...)` throws
		// `Cannot read properties of undefined (reading 'config')`. This is
		// INTERMITTENT (cwd lock / timing dependent) — it does not fire on
		// every run, which made it hard to reproduce. `--root=<sibling dir>`
		// (running the same code from another cwd) was always green, proving
		// the bug is pool+cwd-specific, not a code regression.
		//
		// FIX: switch to the `threads` pool. Threads workers do not bind
		// their IPC to process.cwd() the way forks does, so the cwd-binding
		// failure mode cannot occur. `isolate: true` (default) keeps each test
		// file in its own module registry — required because the mixed
		// ESM/CJS graph (jsdom → @exodus/bytes) is sensitive to module state
		// leaking between files.
		//
		// WHY NOT vmThreads (the earlier workaround): vmThreads runs tests
		// under Vite's CJS-interop loader, which breaks on @exodus/bytes
		// (shipped as ESM, require()'d via CJS by html-encoding-sniffer, a
		// transitive dep of jsdom via fetch-tools → config-router). The plain
		// `threads` pool uses Node's native module loader and handles the
		// mixed graph correctly — verified: no @exodus/bytes error with
		// threads.
		//
		// WHY NOT keep forks: forks is the pool with the cwd-binding bug.
		// Keeping it would leave the intermittent failure latent. Switching
		// to threads removes the failure mode entirely while preserving
		// correct module loading (the original reason forks was chosen).
		//
		// Re-evaluate if a future Vitest patch fixes the forks cwd binding
		// and threads shows its own regression.
		pool: "threads",
	},
});
