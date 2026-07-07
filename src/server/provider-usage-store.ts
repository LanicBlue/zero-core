// provider_usage 持久化 (platform-observability ②.2 / sub-2)
//
// # 文件说明书
//
// ## 核心功能
// provider 层用量累积表,与 session 指标**独立**各记各的。按
// (provider, model, hour_bucket, source) 累加 calls / tokens / errors。
// 喂 sub-5 平台观测 + sub-6 看板图表。
//
// ## 为什么独立于 session 指标
// - provider 可 mid-session 切换(一个 session 历史上可能用过多个 provider);
//   按 session 当前 provider 聚合会错配。本表按 step 落地时已知的
//   provider/model 归因,所以中途切换产生不同行(归因正确,这是本表目的)。
// - source(user/work/cron/background,sub-1 turn-source marker)是 key 一部分,
//   喂后续 sub-3 优先级统计 + 看板按来源切。
//
// ## 输入
// - 构造时注入 better-sqlite3 Database(由 SessionDB.getDb() 提供)
// - upsert 接收 { provider, model, hourBucket, source, calls?, tokens, error? }
//
// ## 输出
// - upsert:同桶(provider+model+hour+source)命中 → 累加;否则 INSERT。
// - cumulative(provider?, model?):SUM 全表(可按 provider/model 过滤)。
// - series(provider, granularity, range, model?):GROUP BY hour_bucket / date(hour_bucket)。
// - cleanOld(maxAgeMs):删 hour_bucket 早于 cutoff 的行(留存 ≥30d)。
//
// ## 定位
// src/server/ 数据层。由 session-manager(runtime usage/error 事件经
// metrics-events 适配器路由)写入;由 sub-5/sub-6 经查询接口读取。
//
// ## 依赖
// - better-sqlite3
// - TurnSource(type-only,跨层 type import 无运行期环)
//
// ## 维护规则
// - 表 schema 在 session-db.ts initSchema 创建(IF NOT EXISTS,自管,
//   不进 db-migration.ts 的 *_COLUMNS —— 同 turn_state/tool_telemetry)。
// - 留存清理在 recovery.ts scanIncompleteTurns 启动时调用(30d)。
// - hour_bucket 必须是 hour-floor ISO UTC,由调用方算好传入(单一真相源,
//   避免本 store 内部时区/格式分歧)。
//

import type Database from "better-sqlite3";
import type { TurnSource } from "../runtime/types.js";

/** Hour-floor ISO UTC bucket key, e.g. "2026-07-07T09:00:00.000Z". */
export type HourBucket = string;

export interface ProviderUsageUpsert {
	provider: string;
	model: string;
	/** Hour-floor ISO UTC. */
	hourBucket: HourBucket;
	source: TurnSource;
	calls?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** +1 to the bucket's error counter (failed step). */
	error?: boolean;
}

export interface ProviderUsageRow {
	provider: string;
	model: string;
	hourBucket: HourBucket;
	source: TurnSource;
	calls: number;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	errors: number;
	createdAt: string;
	updatedAt: string;
}

export interface ProviderUsageCumulative {
	calls: number;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	errors: number;
}

export type SeriesGranularity = "hour" | "day";
export type SeriesRange = "24h" | "30d";

export interface ProviderUsageSeriesPoint {
	/** Bucket label — ISO hour for granularity=hour, ISO date (YYYY-MM-DD) for day. */
	bucket: string;
	calls: number;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	errors: number;
}

const RANGE_MS: Record<SeriesRange, number> = {
	"24h": 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Floor an epoch-ms timestamp to the top of its UTC hour, returned as ISO UTC.
 * E.g. 2026-07-07T09:37:45.123Z → "2026-07-07T09:00:00.000Z".
 * Exported so callers (session-manager) and tests share one definition.
 */
export function floorToHourBucket(epochMs: number): HourBucket {
	const d = new Date(epochMs);
	d.setUTCMinutes(0, 0, 0);
	return d.toISOString();
}

export class ProviderUsageStore {
	private db: Database.Database;
	private upsertStmt: Database.Statement;

	constructor(db: Database.Database) {
		this.db = db;
		// Table is created by session-db.ts initSchema (CREATE TABLE IF NOT
		// EXISTS provider_usage). We don't re-create here to keep schema owner
		//单一 (same convention as turn_state).
		//
		// Atomic upsert via ON CONFLICT — better than SELECT-then-INSERT/UPDATE
		// because two sessions hitting the same bucket concurrently can't race
		// (each statement is its own txn in better-sqlite3, but ON CONFLICT
		// makes the insert-or-add a single atomic step).
		this.upsertStmt = this.db.prepare(
			`INSERT INTO provider_usage
				(provider, model, hour_bucket, source, calls, input_tokens, output_tokens, cache_read, cache_write, errors, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(provider, model, hour_bucket, source) DO UPDATE SET
				calls = calls + excluded.calls,
				input_tokens = input_tokens + excluded.input_tokens,
				output_tokens = output_tokens + excluded.output_tokens,
				cache_read = cache_read + excluded.cache_read,
				cache_write = cache_write + excluded.cache_write,
				errors = errors + excluded.errors,
				updated_at = excluded.updated_at`,
		);
	}

	/**
	 * Accumulate one step's usage into its (provider, model, hour, source)
	 * bucket. Creates the row if first hit, otherwise adds. Atomic via
	 * INSERT ... ON CONFLICT. Always-1 calls is the norm (one step = one call).
	 */
	upsert(input: ProviderUsageUpsert): void {
		const now = new Date().toISOString();
		const calls = Math.max(0, Math.floor(input.calls ?? 1));
		const inputTokens = Math.max(0, Math.floor(input.inputTokens ?? 0));
		const outputTokens = Math.max(0, Math.floor(input.outputTokens ?? 0));
		const cacheRead = Math.max(0, Math.floor(input.cacheRead ?? 0));
		const cacheWrite = Math.max(0, Math.floor(input.cacheWrite ?? 0));
		const errors = input.error ? 1 : 0;
		this.upsertStmt.run(
			input.provider, input.model, input.hourBucket, input.source,
			calls, inputTokens, outputTokens, cacheRead, cacheWrite, errors,
			now, now,
		);
	}

	/**
	 * SUM across the whole table, optionally narrowed by provider and/or model.
	 * Returns zeros (not null) when no rows match — callers can render directly.
	 */
	cumulative(provider?: string, model?: string): ProviderUsageCumulative {
		const where: string[] = [];
		const params: any[] = [];
		if (provider) { where.push("provider = ?"); params.push(provider); }
		if (model) { where.push("model = ?"); params.push(model); }
		const clause = where.length ? "WHERE " + where.join(" AND ") : "";
		const row = this.db.prepare(
			`SELECT
				COALESCE(SUM(calls), 0)         AS calls,
				COALESCE(SUM(input_tokens), 0)  AS inputTokens,
				COALESCE(SUM(output_tokens), 0) AS outputTokens,
				COALESCE(SUM(cache_read), 0)    AS cacheRead,
				COALESCE(SUM(cache_write), 0)   AS cacheWrite,
				COALESCE(SUM(errors), 0)        AS errors
			 FROM provider_usage ${clause}`,
		).get(...params) as any;
		return {
			calls: row.calls ?? 0,
			inputTokens: row.inputTokens ?? 0,
			outputTokens: row.outputTokens ?? 0,
			cacheRead: row.cacheRead ?? 0,
			cacheWrite: row.cacheWrite ?? 0,
			errors: row.errors ?? 0,
		};
	}

	/**
	 * Time series for one provider (required — series is per-provider by design;
	 * cross-provider series isn't useful for the chart and would double-count).
	 * granularity=hour → GROUP BY hour_bucket; granularity=day → GROUP BY
	 * date(hour_bucket) (no separate day-bucket column — day view is derived
	 * from the hourly rollup, per design ②.2). range controls the cutoff.
	 * Optional model filter. Points are ordered by bucket ascending.
	 */
	series(
		provider: string,
		granularity: SeriesGranularity,
		range: SeriesRange,
		model?: string,
	): ProviderUsageSeriesPoint[] {
		const cutoff = new Date(Date.now() - RANGE_MS[range]).toISOString();
		const modelClause = model ? " AND model = ?" : "";
		const params: any[] = [provider, cutoff];
		if (model) params.push(model);

		const bucketExpr = granularity === "day"
			? `substr(hour_bucket, 1, 10)`  // "YYYY-MM-DD"
			: `hour_bucket`;

		const rows = this.db.prepare(
			`SELECT
				${bucketExpr} AS bucket,
				COALESCE(SUM(calls), 0)         AS calls,
				COALESCE(SUM(input_tokens), 0)  AS inputTokens,
				COALESCE(SUM(output_tokens), 0) AS outputTokens,
				COALESCE(SUM(cache_read), 0)    AS cacheRead,
				COALESCE(SUM(cache_write), 0)   AS cacheWrite,
				COALESCE(SUM(errors), 0)        AS errors
			 FROM provider_usage
			 WHERE provider = ? AND hour_bucket >= ?${modelClause}
			 GROUP BY ${bucketExpr}
			 ORDER BY ${bucketExpr} ASC`,
		).all(...params) as any[];

		return rows.map(r => ({
			bucket: r.bucket,
			calls: r.calls ?? 0,
			inputTokens: r.inputTokens ?? 0,
			outputTokens: r.outputTokens ?? 0,
			cacheRead: r.cacheRead ?? 0,
			cacheWrite: r.cacheWrite ?? 0,
			errors: r.errors ?? 0,
		}));
	}

	/** Raw row read — useful for tests + sub-5 observation diagnostics. */
	listAll(): ProviderUsageRow[] {
		const rows = this.db.prepare(
			`SELECT * FROM provider_usage ORDER BY hour_bucket ASC, provider ASC, model ASC`,
		).all() as any[];
		return rows.map(r => this.rowToRecord(r));
	}

	/**
	 * Retention — delete buckets older than maxAgeMs. Cutoff compared against
	 * hour_bucket directly. Mirrors session-db.cleanOldProviderUsage; exposed
	 * here so a future scheduled cleanup (not just startup) can call the store
	 * directly. Startup path still goes through session-db.cleanOldProviderUsage
	 * (single sweep alongside turn_state cleanup).
	 */
	cleanOld(maxAgeMs: number): number {
		const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
		const info = this.db.prepare(
			`DELETE FROM provider_usage WHERE hour_bucket < ?`,
		).run(cutoff);
		return info.changes ?? 0;
	}

	private rowToRecord(r: any): ProviderUsageRow {
		return {
			provider: r.provider,
			model: r.model,
			hourBucket: r.hour_bucket,
			source: (r.source ?? "background") as TurnSource,
			calls: r.calls,
			inputTokens: r.input_tokens,
			outputTokens: r.output_tokens,
			cacheRead: r.cache_read,
			cacheWrite: r.cache_write,
			errors: r.errors,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		};
	}
}
