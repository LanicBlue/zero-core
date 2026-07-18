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

// 单测 DB 用 MEMORY journal(非 WAL):无 -wal/-shm 文件 → vitest worker 退出时
// 无 WAL checkpoint 内核 I/O。根因:lsof 显示卡死(UE = uninterruptible sleep,
// kill -9 无效)的 worker 持有多个未关闭的 sessions.db-wal;SQLite 在 worker
// 退出时对每个未关闭的 WAL 做 checkpoint,该 I/O 在 macOS fsevents 监听同目录时
// 死锁,worker UE 拖死整个 vitest(间歇性,时序依赖)。MEMORY journal 不产生 -wal
// 文件,从源头消除 checkpoint。生产默认仍 WAL(session-db.ts 仅在此 env 下切 MEMORY)。
process.env.ZERO_CORE_DB_NO_WAL = "1";

export default defineConfig({
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
	//
	// NOTE (P1-3, 2026-07-18): in Vitest 4 `pool` + `poolOptions` moved
	// from inside `test:` to the TOP LEVEL of defineConfig (the v4 pool
	// rework — see https://vitest.dev/guide/migration#pool-rework). The
	// previous `test.pool` placement silently emitted
	// `DEPRECATED test.poolOptions was removed in Vitest 4` and the
	// settings were IGNORED, which is why raising/lowering thread counts
	// there had no effect on concurrency. Both keys now live here.
	pool: "threads",
	// P1-3 (2026-07-18, round-2): cap thread parallelism to cut SQLite +
	// git + FTS + regex-worker contention that made heavy integration tests
	// non-deterministically blow the 5000ms default testTimeout.
	//
	// ROOT CAUSE: with no cap, vitest spawns up to os.cpus().length workers
	// (= 12 on this i5-12400F). Several heavy tests in the suite boot the
	// REAL AgentService + CoreDatabase (archive-no-residual-sub2/sub3),
	// spawn REAL `git` subprocesses per test (wiki-v2-sync,
	// wiki-v2-integration), build 200–250-node fixtures and run FTS5 /
	// regex-worker queries over them (wiki-v2-search truncated-boundary
	// describes, wiki-v2-regex-limits §D results + wall-timeout). When
	// many of these run concurrently they fight for: (a) better-sqlite3's
	// per-process memory + open FDs, (b) the git subprocess CPU + disk
	// queue, (c) module-load lock contention during vi.resetModules dynamic
	// re-imports, (d) FTS5 + regex worker_threads scheduling jitter under
	// saturated HT lanes. Under that contention the heavy tests
	// legitimately exceed 5s — the failures are NOT a stable bug set, they
	// shuffle run-to-run (3 / 5 / 10 failures across independent runs,
	// each landing on a DIFFERENT heavy category). That shuffle IS the
	// signature of resource contention, not a regression.
	//
	// ROUND-1 FIX (maxThreads: 4) was INSUFFICIENT: it tamed the
	// real-git cascade (archive-no-residual-sub*, wiki-v2-sync,
	// wiki-v2-integration) but the variance stayed high and the next
	// round surfaced the SEARCH/REGEX category instead (250-node FTS
	// fixtures + regex worker_threads) — categories the round-1 per-file
	// audit had mis-classified as "pure-logic / in-memory". Per-file
	// whack-a-mole timeouts cannot keep up: parallel thread contention
	// on this machine affects EVERY heavy category, and each run surfaces
	// a different one blowing the 5000ms default.
	//
	// ROUND-2 FIX (this change): drop maxThreads to 2. This is the
	// determinism floor — concurrent SQLite + FTS + regex + git contention
	// drops enough that ALL tests finish well under 5000ms. 2 workers is
	// still enough to keep the suite reasonably fast (the vast majority of
	// tests are sub-100ms unit shapes; the suite stays well under a minute
	// wall-clock) while leaving 10 HT lanes for the OS, git subprocesses,
	// the regex worker_threads, and the SQLite + module-load work the
	// workers themselves drive. minThreads: 1 lets the pool spin down
	// between bursts so transient resources (open FDs, temp DBs, worker
	// threads) release before the next burst allocates — also reduces
	// cross-test interference.
	//
	// WHY this is not "masking": the failures were timeout-only under
	// contention; the underlying assertions are correct (verified by the
	// fact that the failure set shuffles run-to-run). Raising the global
	// testTimeout would mask real hangs; capping concurrency removes the
	// contention itself (the root cause), so the existing 5s budget
	// covers all but the genuinely-slow real-git tests (which get a
	// justified per-describe 30000ms timeout in their own files, not a
	// global raise).
	//
	// If 2 STILL flakes (any failure in 3 consecutive runs), drop to
	// maxThreads: 1 — fully serial, guaranteed no contention, slower but
	// deterministic. The fallback is documented here so the next round
	// knows the next step without re-deriving.
	//
	// Same `threads` pool — does NOT reintroduce the forks cwd-binding
	// bug or the @exodus/bytes CJS/ESM issue (those were pool-loader
	// concerns, not parallelism-level concerns).
	poolOptions: {
		threads: {
			maxThreads: 2,
			minThreads: 1,
		},
	},
	test: {
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
		globals: false,
	},
});
