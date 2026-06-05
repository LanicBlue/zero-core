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

interface PendingEntry {
	resolve: (value: Record<string, string>) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

class PendingResponseManager {
	private pending = new Map<string, PendingEntry>();
	private static TIMEOUT_MS = 300000; // 5 minutes

	createRequest(id: string): Promise<Record<string, string>> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error("User response timed out (5 minutes)"));
				}
			}, PendingResponseManager.TIMEOUT_MS);

			this.pending.set(id, { resolve, reject, timer });
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

	get size(): number {
		return this.pending.size;
	}
}

export const pendingResponses = new PendingResponseManager();
