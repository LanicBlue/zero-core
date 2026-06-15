// 测试环境辅助的 thin re-export。
//
// # 文件说明书
//
// ## 核心功能
// 将测试环境判定与种子逻辑从 ../core/test-seed.js 透传给 src/main 域：
//   - isTestMode：是否处于 ZERO_CORE_TEST_FIXTURE 等测试模式；
//   - seedTestEnvironment：在干净 DB 中播种测试 fixture；
//   - TestSeedResult：种子结果类型。
//
// ## 输入
// - 无运行时输入（仅做命名导出转发）
//
// ## 输出
// - isTestMode / seedTestEnvironment / TestSeedResult 三个 re-export
//
// ## 定位
// src/main 入口侧的测试入口 facade；实际逻辑集中在 src/core/test-seed.ts，
// 此文件存在是为了让 main 进程在不直接依赖 server 实现细节的前提下引用测试工具。
//
// ## 依赖
// - ../core/test-seed.js（实际实现）
//
// ## 维护规则
// - 实现变更必须在 ../core/test-seed.ts 中进行，本文件只做透传
// - 新增测试工具若需要被 main 进程引用，请在此追加 re-export 而不是在 main 内复写

// Re-export from shared location
export { isTestMode, seedTestEnvironment } from "../core/test-seed.js";
export type { TestSeedResult } from "../core/test-seed.js";
