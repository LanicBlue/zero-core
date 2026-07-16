// 数据库路径中央模块（wiki-system-redesign plan-00 §1）
//
// # 文件说明书
//
// ## 核心功能
// 唯一暴露 zero-core 各 SQLite 数据库的物理路径与备份目录。生产代码、脚本、
// 测试都必须从这里取路径，**不得自行拼接** `sessions.db` / `knowledge.db` /
// `wiki.db` / `core.db` 等文件名（避免布局漂移）。
//
// ## 布局
//
// ```text
// ${ZERO_CORE_DIR}/
// ├── db/
// │   ├── core.db
// │   ├── core.db-wal
// │   ├── core.db-shm
// │   └── wiki.db          # Plan 01 才创建
// ├── wiki/
// │   └── attachments/
// └── backups/
//     ├── core/
//     └── wiki/
// ```
//
// ## 历史背景
// - `sessions.db` 已改名为 `db/core.db`（plan-00 §4 启动切换）。
// - `knowledge.db` 已退役并删除（plan-00 §5）。
// - 旧的根目录 `sessions.db` 仅在启动切换时被一次性消费，不再作为活动路径。
//
// ## 维护规则
// - 新增 DB：在这里加 `xxxDBPath`，禁止在业务代码里硬编码文件名。
// - 改布局：只改这里；所有消费者零改动。

import { join } from "node:path";
import { ZERO_CORE_DIR } from "./config.js";

/** `db/` 目录（core.db、wiki.db 的容器）。 */
export const DB_DIR: string = join(ZERO_CORE_DIR, "db");

/** Core DB 主路径：`${ZERO_CORE_DIR}/db/core.db`。承载 sessions/agents/projects 等核心状态。 */
export const coreDbPath: string = join(DB_DIR, "core.db");

/** Wiki DB 主路径：`${ZERO_CORE_DIR}/db/wiki.db`。Plan 01 起才创建；Plan 00 不创建。 */
export const wikiDbPath: string = join(DB_DIR, "wiki.db");

/** `backups/` 根目录。 */
export const BACKUP_DIR: string = join(ZERO_CORE_DIR, "backups");

/** Core DB 一次性备份目录：`${ZERO_CORE_DIR}/backups/core/`。 */
export const coreBackupDir: string = join(BACKUP_DIR, "core");

/** Wiki DB 一次性备份目录：`${ZERO_CORE_DIR}/backups/wiki/`。 */
export const wikiBackupDir: string = join(BACKUP_DIR, "wiki");

/**
 * 历史遗留 Core DB 路径（pre-layout-v1）：`${ZERO_CORE_DIR}/sessions.db`。
 * 仅在 plan-00 §4 启动切换流程中作为**源**被读取一次；切换完成后该路径不再
 * 作为活动事实源。生产代码不得在日常读写里使用它。
 */
export const legacyCoreDbPath: string = join(ZERO_CORE_DIR, "sessions.db");

/**
 * 布局标记文件：`${ZERO_CORE_DIR}/db/layout-v1.json`。切换流程写、启动冲突
 * 检测读。包含 source/target/hash/time/version/check 结果和 complete 状态。
 */
export const layoutMarkerPath: string = join(DB_DIR, "layout-v1.json");
