// 并发队列
//
// # 文件说明书
//
// ## 核心功能
// 信号量,控制每个 Provider 的并发 API 请求数。
//
// platform-observability ②.3 (sub-3):
//   - waiter 携带身份 { sessionId, agentId, tier, waitedSince };
//   - acquire(opts?) 接 AbortSignal + 身份;
//   - getWaiting() 返当前排队清单(身份 + tier + 等了多久),getWaitingCount 保留。
//
// platform-observability ②.4 (sub-3):
//   - release() / setMax() 按 tier 严格优先级出队(小=高优先),同 tier FIFO(按 waitedSince)。
//   - 严格优先级:P1 > P2 > P3。background(P3) 可饿死 —— 本期接受(aging 后续)。
//
// ## 输入
// - 最大并发数
// - acquire/release 调用
//
// ## 输出
// - acquire 返回 Promise
// - getWaiting/getWaitingCount/getActiveCount 观测
//
// ## 定位
// Runtime 并发控制,被 provider-factory 使用。
//
// ## 依赖
// 无(纯逻辑;tier 数字由调用方传入,本文件不 import turnSourceToTier,保持解耦)
//
// ## 维护规则
// - 并发逻辑变更时需更新
// - release/setMax 出队策略变更必须同步 sub-3 文档
// - 未指定 tier 的 acquire 默认 P3(Number.MAX_SAFE_INTEGER 也可,但 P3 让观测一致)
//

export interface AcquireOptions {
	signal?: AbortSignal;
	/** 当前 turn 的 session(undefined=无 loop 上下文,如测试)。 */
	sessionId?: string;
	/** 当前 turn 的 agent。 */
	agentId?: string;
	/**
	 * 优先级档(小=高优先)。来自 turnSourceToTier。省略时按 P3 处理
	 * (等价旧 FIFO 行为 —— 全部同档即全部 FIFO)。
	 */
	tier?: number;
}

/** waiter 上的身份快照(getWaiting 直接返此 shape 去掉回调)。 */
export interface WaitingEntry {
	sessionId?: string;
	agentId?: string;
	tier: number;
	/** 进队时间(ms epoch),同 tier FIFO 用。 */
	waitedSince: number;
}

interface Waiter extends WaitingEntry {
	resolve: () => void;
	reject: (reason: Error) => void;
	abortHandler: () => void;
}

/** 默认 tier:未指定 source 的旧路径走 P3(=旧行为 FIFO 同档)。 */
const DEFAULT_TIER = 3;

/**
 * Semaphore for controlling concurrent API requests per provider.
 *
 * 出队策略(sub-3 ②.4):tier 最小(最高优先)的 waiter 先出;同 tier 内按
 * waitedSince 升序(最早进队的先出)。release 与 setMax 共用同一选人逻辑。
 */
export class ConcurrencyQueue {
	private active = 0;
	private max: number;
	private waiters: Waiter[] = [];

	constructor(max: number) {
		this.max = max;
	}

	acquire(opts?: AbortSignal | AcquireOptions): Promise<void> {
		// 兼容旧签名 acquire(signal?) 与新签名 acquire(opts?)。AbortSignal 自身
		// 也是 object,用 instanceof 反判:裸 AbortSignal → 旧路径;否则当 opts。
		const isOpts = !!opts && !(opts instanceof AbortSignal);
		const sig = isOpts ? (opts as AcquireOptions).signal : (opts as AbortSignal | undefined);
		const sessionId = isOpts ? (opts as AcquireOptions).sessionId : undefined;
		const agentId = isOpts ? (opts as AcquireOptions).agentId : undefined;
		const tier =
			isOpts && typeof (opts as AcquireOptions).tier === "number"
				? (opts as AcquireOptions).tier!
				: DEFAULT_TIER;

		if (this.active < this.max) {
			this.active++;
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			let cleaned = false;
			const waiter: Waiter = {
				resolve: () => {
					this.active++;
					cleaned = true;
					cleanup();
					resolve();
				},
				reject: (err: Error) => {
					cleaned = true;
					cleanup();
					reject(err);
				},
				abortHandler: () => {
					const idx = this.waiters.indexOf(waiter);
					if (idx >= 0) this.waiters.splice(idx, 1);
					cleaned = true;
					cleanup();
					reject(new DOMException("Aborted", "AbortError"));
				},
				sessionId,
				agentId,
				tier,
				waitedSince: Date.now(),
			};

			const cleanup = () => {
				if (sig) sig.removeEventListener("abort", waiter.abortHandler);
			};

			if (sig?.aborted) {
				reject(new DOMException("Aborted", "AbortError"));
				return;
			}

			if (sig) sig.addEventListener("abort", waiter.abortHandler, { once: true });
			this.waiters.push(waiter);
		});
	}

	/**
	 * 出队一个 waiter(按 tier 升序 + waitedSince 升序)。返回 waiter 或
	 * undefined(空)。摘除后从 waiters[] 移除 —— 调用方负责调用 .resolve()。
	 *
	 * release 与 setMax 共用,保证两条唤醒路径走同一优先级策略。
	 */
	private dequeueNext(): Waiter | undefined {
		if (this.waiters.length === 0) return undefined;
		let bestIdx = 0;
		for (let i = 1; i < this.waiters.length; i++) {
			const cur = this.waiters[i];
			const best = this.waiters[bestIdx];
			// tier 升序;同 tier 按 waitedSince 升序(早优先)
			if (cur.tier < best.tier || (cur.tier === best.tier && cur.waitedSince < best.waitedSince)) {
				bestIdx = i;
			}
		}
		const [picked] = this.waiters.splice(bestIdx, 1);
		return picked;
	}

	/**
	 * 释放一个槽位并唤醒一个 waiter(按 tier + FIFO)。若 abort 已把 waiter
	 * 摘掉,active 已被 release 减;这里只在 waiters 非空时唤醒。
	 */
	release(): void {
		if (this.active > 0) this.active--;
		const next = this.dequeueNext();
		if (next) next.resolve();
	}

	/**
	 * 调整并发上限。新上限比当前 active 大时,按 tier + FIFO 唤醒多余槽位。
	 * 与 release 走同一 dequeueNext,保证 setMax 提升也优先高档。
	 */
	setMax(n: number): void {
		this.max = n;
		while (this.active < this.max) {
			const next = this.dequeueNext();
			if (!next) break;
			next.resolve();
		}
	}

	getActiveCount(): number { return this.active; }
	getWaitingCount(): number { return this.waiters.length; }
	/**
	 * Configured max concurrency. Read-only accessor for platform-observability
	 * ② (sub-5) — the providerStats resource + provider:stats IPC surface
	 * "in-flight/max". Was private; exposed without behavioral change.
	 */
	getMax(): number { return this.max; }

	/**
	 * 当前排队清单(身份 + tier + 等了多久)。按 tier 升序返回(观测友好);
	 * 不暴露回调。快照是浅拷贝,调用方拿到后队列变化不影响已返副本。
	 */
	getWaiting(): WaitingEntry[] {
		return this.waiters
			.slice()
			.sort((a, b) => a.tier - b.tier || a.waitedSince - b.waitedSince)
			.map(({ sessionId, agentId, tier, waitedSince }) => ({ sessionId, agentId, tier, waitedSince }));
	}
}
