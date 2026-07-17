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

const MINIMUM_NODE = [24, 14, 0] as const;
const runningNode = process.versions.node.split(".").map(Number);
let nodeIsSupported = true;
for (let index = 0; index < MINIMUM_NODE.length; index++) {
	const current = runningNode[index] ?? 0;
	if (current === MINIMUM_NODE[index]) continue;
	nodeIsSupported = current > MINIMUM_NODE[index];
	break;
}

if (!nodeIsSupported) {
	throw new Error(
		`zero-core tests require Node >=${MINIMUM_NODE.join(".")}; running ${process.versions.node}. ` +
		"Older Windows Node releases crash in fs.rmSync on non-ASCII paths.",
	);
}

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
	test: {
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
		globals: false,
		// Windows: use process workers for native SQLite isolation. With the
		// supported Node 24.14 runtime, threads still exit intermittently with
		// 0xC0000005 during the SQLite-heavy suite; forks complete the full suite
		// cleanly. Bound concurrency because each worker loads a large module
		// graph and creates real temporary databases. Other platforms retain
		// lower-overhead threads.
		pool: process.platform === "win32" ? "forks" : "threads",
		maxWorkers: process.platform === "win32" ? 2 : undefined,
	},
});
