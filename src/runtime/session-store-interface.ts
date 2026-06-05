// 会话存储抽象接口
//
// # 文件说明书
//
// ## 核心功能
// 定义会话和消息持久化的最小接口，解耦运行时层与具体数据库实现
//
// ## 输入
// 会话 ID、消息数据
//
// ## 输出
// ISessionStore 接口，提供消息读写和轮次管理
//
// ## 定位
// src/runtime/ — 运行时层接口定义，由 server/SessionDB 实现
//
// ## 依赖
// core/kv-store-interface.ts
//
// ## 维护规则
// 接口变更需确保 SessionDB 实现方同步更新
//
import type { IKVStore } from "../core/kv-store-interface.js";

/**
 * Interface for session/message persistence.
 * Runtime layer uses this instead of depending on server/SessionDB.
 */
export interface ISessionStore {
	getMessages(sessionId: string): any[];
	saveTurn(sessionId: string, messages: any[]): void;
	getTurns(sessionId: string): Array<{ seq: number; role: string; content: string | null }>;
	appendTurn(sessionId: string, seq: number, role: string, content: string | null): void;
	getTurnCount(sessionId: string): number;
	getMainSession(agentId: string): { id: string; agentId: string; isMain: boolean; title: string | null; createdAt: string; updatedAt: string } | undefined;
	createSession(agentId: string, title?: string): { id: string; agentId: string; isMain: boolean; title: string | null; createdAt: string; updatedAt: string };
	setMainSession(agentId: string, sessionId: string): void;
	listSessions(agentId: string): Array<{ id: string; agentId: string; isMain: boolean; title: string | null; createdAt: string; updatedAt: string }>;
	deleteSession(sessionId: string): void;
	updateTurnContent(sessionId: string, seq: number, content: string): void;
	deleteTurn(sessionId: string, seq: number): void;
	getKVStore(): IKVStore;
	getMemoryStore(): any;
	recordToolExecution(exec: {
		sessionId: string;
		agentId: string;
		toolName: string;
		success: boolean;
		errorMessage?: string;
		inputPreview?: string;
		outputPreview?: string;
		durationMs: number;
		turnSeq?: number;
	}): void;
}
