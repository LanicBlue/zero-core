// Wiki 数据库占位类型（wiki-system-redesign plan-00 §3）
//
// # 文件说明书
//
// ## 核心功能
// `WikiDatabase` 类型占位：plan-00 只锁定 DatabaseManager 的接口形状，
// 不实现 wiki 逻辑。Plan 01 起会用真实实现替换本文件（独立 SQLite，位于
// `${ZERO_CORE_DIR}/db/wiki.db`）。
//
// ## 维护规则
// - Plan 00 阶段：本文件保持为类型占位（无运行时实现）。
// - Plan 01：在此添加真实 `WikiDatabase` class（打开 wikiDbPath、own schema、
//   独立 WAL checkpoint）。DatabaseManager 的 `wiki`/`checkpointWiki`/
//   `backupWiki` 随之从 placeholder 切到真实实现。
// - Plan 08：补 `backupWiki` 的 snapshot 实现。
//
// plan-00 §3 接口锁定：core 与 wiki 形状对称（各自 open/close/health/
// checkpoint/backup），DatabaseManager 不提供跨库 transaction。

/**
 * Plan-00 占位类型。Plan 01 用真实 class 替换。
 *
 * 注意：本标记类型故意为空 —— 任何对 wiki 的运行时访问在 DatabaseManager
 * 里都会 throw `WIKI_DB_NOT_IMPLEMENTED_IN_PLAN_00`，确保 plan-00 阶段
 * 没有代码路径误以为 wiki 已就绪。
 */
export type WikiDatabase = {
	// plan-00 placeholder — 在 DatabaseManager 的 wiki getter 里 throw。
	// Plan 01 把它换成真实 class，再在 DatabaseManager.open() 末尾实例化。
	readonly __plan00Placeholder: true;
};
