// 异步用户响应等待管理器
//
// # 文件说明书
//
// ## 核心功能
// 管理 ask-user 工具的异步响应，桥接工具执行与用户回复
//
// ## 输入
// 工具调用 ID、用户回复数据
//
// ## 输出
// Promise resolve/reject 机制，支持超时自动清理
//
// ## 定位
// src/runtime/ — 运行时层，为 ask-user 工具提供异步等待能力
//
// ## 依赖
// 无外部依赖
//
// ## 维护规则
// 超时策略变更需确保不阻塞 agent 主循环
//

// ---------------------------------------------------------------------------
// PendingResponseManager — bridges tool execution and user responses
// ---------------------------------------------------------------------------

/** AskUser 问题形状(与 ask-user 工具的 zod schema / 前端 AskUserQuestion 对齐)。 */
export interface PendingAskUserQuestion {
	question: string;
	header?: string;
	options?: Array<{ label: string; description?: string }>;
	multiSelect?: boolean;
}

interface PendingEntry {
	resolve: (value: Record<string, string>) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	/** 该请求所属 session —— 前端按 sessionId 路由 AskUser 卡片(同 agent 多 session
	 *  不再串显),也供 session init payload 在显示时拉回未决问题。 */
	sessionId?: string;
	questions?: PendingAskUserQuestion[];
}

class PendingResponseManager {
	private pending = new Map<string, PendingEntry>();
	private static TIMEOUT_MS = 300000; // 5 minutes

	createRequest(
		id: string,
		meta?: { sessionId?: string; questions?: PendingAskUserQuestion[] },
	): Promise<Record<string, string>> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error("User response timed out (5 minutes)"));
				}
			}, PendingResponseManager.TIMEOUT_MS);

			this.pending.set(id, { resolve, reject, timer, sessionId: meta?.sessionId, questions: meta?.questions });
		});
	}

	resolveRequest(id: string, value: Record<string, string>): void {
		const entry = this.pending.get(id);
		if (entry) {
			clearTimeout(entry.timer);
			entry.resolve(value);
			this.pending.delete(id);
		}
	}

	rejectRequest(id: string, error: string): void {
		const entry = this.pending.get(id);
		if (entry) {
			clearTimeout(entry.timer);
			entry.reject(new Error(error));
			this.pending.delete(id);
		}
	}

	has(id: string): boolean {
		return this.pending.has(id);
	}

	/**
	 * 返回某 session 当前未决的 AskUser 问题(若有)。前端"显示时 pull"用:切到
	 * 一个 session 才发现它在等用户回答时,把卡片拉出来。按 sessionId 取(不按
	 * agentId)——同 agent 多 session 各自独立。
	 */
	getPendingForSession(sessionId: string): { requestId: string; questions: PendingAskUserQuestion[] } | null {
		for (const [id, entry] of this.pending) {
			if (entry.sessionId === sessionId && entry.questions) {
				return { requestId: id, questions: entry.questions };
			}
		}
		return null;
	}

	get size(): number {
		return this.pending.size;
	}
}

export const pendingResponses = new PendingResponseManager();
