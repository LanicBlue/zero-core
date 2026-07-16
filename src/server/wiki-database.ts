// WikiDatabase 占位 → 真实实现的兼容 re-export（wiki-system-redesign plan-01）
//
// # 文件说明书
//
// ## 核心功能
// sub-00 的占位类型 `WikiDatabase` 已被 plan-01 的真实 class 取代。真实实现
// 位于 `src/server/wiki/wiki-database.ts`(plan-01 §1 模块布局)。
//
// 本文件保留为薄 re-export shim,避免破坏任何潜在的外部引用;plan-05–08
// clean cutover 阶段会移除它。**新代码不应**从此处 import —— 直接从
// `src/server/wiki/wiki-database.ts` 或 `src/server/wiki/index.ts` import。
//
// ## 维护规则
//   - plan-05–08:clean cutover 完成后删除本文件。
//   - 不得在此添加新逻辑(只做 re-export)。
//
// 参见:
//   - src/server/wiki/wiki-database.ts(真实实现)
//   - src/server/wiki/index.ts(barrel)

export { WikiDatabase } from "./wiki/wiki-database.js";
export type { WikiDatabaseHealth } from "./wiki/wiki-database.js";
