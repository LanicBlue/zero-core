// 对话检查点管理器
//
// # 文件说明书
//
// ## 核心功能
// 管理 agent 对话的检查点（checkpoint），支持增量保存和回滚
//
// ## 输入
// ISessionStore 实例、工具调用消息
//
// ## 输出
// 检查点数据写入 session store
//
// ## 定位
// src/runtime/ — 运行时层，为 agent-loop 提供对话持久化
//
// ## 依赖
// session-store-interface.ts、turn-recorder.ts、core/logger.ts
//
// ## 维护规则
// 检查点格式变更需考虑与历史数据的兼容性
//
/** @deprecated Replaced by turn-hooks.ts. Retained for reference only; not actively imported. */

import type { ISessionStore } from "./session-store-interface.js";
import { TurnRecorder } from "./turn-recorder.js";
import { log } from "../core/logger.js";

export class CheckpointManager {
	private db: ISessionStore | undefined;
	private pendingToolCalls = new Map<string, { name: string; args: any }>();
	private incrementalTurnSeq = -1;

	constructor(db?: ISessionStore) {
		this.db = db;
	}

	reset(): void {
		this.pendingToolCalls.clear();
		this.incrementalTurnSeq = -1;
	}

	resetStreamState(): void {
		this.pendingToolCalls.clear();
	}

	get turnSeq(): number {
		return this.incrementalTurnSeq;
	}

	recordToolCall(tcId: string, name: string, args: any): void {
		this.pendingToolCalls.set(tcId, { name, args });
	}

	saveUserTurn(sessionId: string | null | undefined, recorder: TurnRecorder, text: string): void {
		if (!this.db || !sessionId) return;
		recorder.saveUserTurn(this.db, sessionId, text);
	}

	saveAssistantTurn(sessionId: string | null | undefined, recorder: TurnRecorder): void {
		if (!this.db || !sessionId) return;
		if (recorder.blocks.length === 0) return;
		const blocksJson = JSON.stringify(recorder.blocks);
		if (this.incrementalTurnSeq >= 0) {
			this.db.updateTurnContent(sessionId, this.incrementalTurnSeq, blocksJson);
			return;
		}
		const seq = this.db.getTurnCount(sessionId);
		this.db.appendTurn(sessionId, seq, "assistant", blocksJson);
	}

	saveIncrementalCheckpoint(
		sessionId: string | null | undefined,
		recorder: TurnRecorder,
		_sessionMessages: any[],
		toolCallId: string,
		_output: any,
	): void {
		if (!this.db || !sessionId) return;

		const tc = this.pendingToolCalls.get(toolCallId);
		if (!tc) return;

		// Save turn blocks to turns table only (not messages table).
		// The messages table is updated once at the end by finalizeStream's saveToDb.
		recorder.sealStep();
		const blocksJson = JSON.stringify(recorder.blocks);
		try {
			if (this.incrementalTurnSeq < 0) {
				this.incrementalTurnSeq = this.db.getTurnCount(sessionId);
				this.db.appendTurn(sessionId, this.incrementalTurnSeq, "assistant", blocksJson);
			} else {
				this.db.updateTurnContent(sessionId, this.incrementalTurnSeq, blocksJson);
			}
		} catch (err) {
			log.error("loop", "Incremental checkpoint turn save failed:", (err as Error).message);
		}

		this.pendingToolCalls.delete(toolCallId);
		log.debug("loop", "Incremental checkpoint saved, tool:", tc.name);
	}

	deletePartialTurn(sessionId: string | null | undefined): void {
		if (this.incrementalTurnSeq >= 0 && this.db && sessionId) {
			try { this.db.deleteTurn(sessionId, this.incrementalTurnSeq); } catch (err) { log.warn("loop", "deleteTurn during retry cleanup failed:", (err as Error).message); }
		}
		this.incrementalTurnSeq = -1;
	}

	loadResumedTurns(sessionId: string | null | undefined, _recorder: TurnRecorder, turnSeq?: number): void {
		if (turnSeq === undefined || !this.db || !sessionId) return;
		// NOTE: recorder.blocks is now a read-only getter (step-level storage).
		// Direct assignment is no longer possible. This deprecated method
		// would need a full rewrite to support step-level storage.
		this.incrementalTurnSeq = turnSeq;
	}
}
