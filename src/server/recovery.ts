// 会话恢复与启动清理
//
// # 文件说明书
//
// ## 核心功能
// 启动时扫描中断的会话轮次，清理过期记录，辅助 AgentService 恢复未完成会话
//
// ## 输入
// SessionDB 实例
//
// ## 输出
// 不完整轮次列表（sessionId、turnSeq、phase）
//
// ## 定位
// src/server/ — 服务层，应用启动时的数据恢复机制
//
// ## 依赖
// session-db.ts、core/logger.ts
//
// ## 维护规则
// 新增中断场景需在此添加扫描逻辑
//
import type { SessionDB } from "./session-db.js";
import { log } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Startup recovery — scan for interrupted turns and clean up stale records.
// Actual resume is driven by AgentService.recoverIncompleteSessions().
// Runs once at app startup after the database is initialized.
// ---------------------------------------------------------------------------

export function scanIncompleteTurns(sessionDb: SessionDB): Array<{ sessionId: string; turnSeq: number; phase: string }> {
	// Clean up old turn_state records (older than 24 hours)
	sessionDb.cleanOldTurnState(24 * 60 * 60 * 1000);

	const incomplete = sessionDb.getIncompleteTurns();
	if (incomplete.length === 0) {
		log.debug("recovery", "No interrupted turns found");
	} else {
		log.db(`Found ${incomplete.length} interrupted turn(s)`);
	}
	return incomplete;
}
