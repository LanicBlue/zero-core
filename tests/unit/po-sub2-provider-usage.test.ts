// platform-observability sub-2 (provider_usage 表 + 记录) 单测。
//
// 验证 agent(本文件)对抗式校验 acceptance-2.md 九条。覆盖路径:
//   1. 表存在        — 经真实 SessionDB.initSchema 验证(migration/fresh DB)。
//   2. 打点正确      — provider X / model Y / source user / calls=1 / tokens 累加。
//   3. 同桶累加      — 同 (provider,model,hour,source) 多次 upsert → 单行,值累加。
//   4. mid-session 切 provider — X/Y 各自独立行。
//   5. source 维度   — 不同 source → 不同行(PK 含 source)。
//   6. 天视图        — series(day) GROUP BY date(hour_bucket)。
//   7. 小时视图      — series(hour,24h) 返近 24 桶。
//   8. 留存          — 30d 前清理,近 30d 保留。
//   9. error 计      — 失败 step 对应桶 errors +1(经 SessionManager.recordProviderUsage)。
//
// # 文件说明书
//
// ## 核心功能
// 对抗式校验 provider_usage 表 + ProviderUsageStore + 记录路径(acceptance-2)。
//
// ## 输入
// 临时 SessionDB(走 initSchema)+ ProviderUsageStore + SessionManager(测 error 路径)。
//
// ## 输出
// Vitest 用例集。
//
// ## 定位
// tests/unit/ — 仅 sub-2 验证。归验证 agent,不归实现者。
//

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../../src/server/session-db.js";
import { SessionManager } from "../../src/server/session-manager.js";
import {
	ProviderUsageStore,
	floorToHourBucket,
} from "../../src/server/provider-usage-store.js";

// helper:取一行(精确匹配 4-tuple key)
function getRow(
	db: ReturnType<SessionDB["getDb"]>,
	provider: string,
	model: string,
	hourBucket: string,
	source: string,
): any {
	return db
		.prepare(
			`SELECT * FROM provider_usage
			 WHERE provider = ? AND model = ? AND hour_bucket = ? AND source = ?`,
		)
		.get(provider, model, hourBucket, source) as any | undefined;
}

function rowCount(db: ReturnType<SessionDB["getDb"]>): number {
	return (
		db.prepare(`SELECT COUNT(*) AS n FROM provider_usage`).get() as any
	).n;
}

describe("platform-observability sub-2: provider_usage", () => {
	let dir: string;
	let sessionDb: SessionDB;
	let db: ReturnType<SessionDB["getDb"]>;
	let store: ProviderUsageStore;
	let nowHour: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "po-sub2-"));
		sessionDb = new SessionDB(join(dir, "sessions.db"));
		db = sessionDb.getDb();
		store = new ProviderUsageStore(db);
		// Pin "now" to a fixed hour so deterministic assertions don't drift
		// across a slow test run. We floor once per test to match what
		// recordProviderUsage would compute mid-test.
		nowHour = floorToHourBucket(Date.now());
	});

	afterEach(() => {
		try {
			sessionDb.close();
		} catch {
			/* best-effort */
		}
		rmSync(dir, { recursive: true, force: true });
	});

	// ─── 1. 表存在(migration / fresh DB 后) ──────────────────────
	test("1. provider_usage table exists after fresh-DB initSchema", () => {
		const tables = db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type='table' AND name='provider_usage'`,
			)
			.all() as { name: string }[];
		expect(tables.length).toBe(1);
		expect(tables[0].name).toBe("provider_usage");

		// PK 必须是 4-tuple(对抗:实现者可能漏 source)
		const pk = db.pragma("table_info(provider_usage)") as any[];
		const pkCols = pk.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
		expect(pkCols.map((c) => c.name)).toEqual([
			"provider",
			"model",
			"hour_bucket",
			"source",
		]);
	});

	// ─── 2. 打点正确(单步) ───────────────────────────────────────
	test("2. one step records (provider, model, <hour>, source, calls=1, tokens累加)", () => {
		store.upsert({
			provider: "openai",
			model: "gpt-4o",
			hourBucket: nowHour,
			source: "user",
			calls: 1,
			inputTokens: 100,
			outputTokens: 50,
			cacheRead: 10,
			cacheWrite: 5,
		});

		const row = getRow(db, "openai", "gpt-4o", nowHour, "user");
		expect(row).toBeDefined();
		expect(row.calls).toBe(1);
		expect(row.input_tokens).toBe(100);
		expect(row.output_tokens).toBe(50);
		expect(row.cache_read).toBe(10);
		expect(row.cache_write).toBe(5);
		expect(row.errors).toBe(0);
		// 应只有一行(对抗:实现者可能每次插入新行)
		expect(rowCount(db)).toBe(1);
	});

	// ─── 3. 同桶累加 ──────────────────────────────────────────────
	test("3. same bucket repeated → single row, values accumulate (upsert)", () => {
		const totalCalls = 7;
		let totalIn = 0;
		let totalOut = 0;
		for (let i = 0; i < totalCalls; i++) {
			const inT = 100 + i;
			const outT = 50 + i;
			totalIn += inT;
			totalOut += outT;
			store.upsert({
				provider: "anthropic",
				model: "claude-3",
				hourBucket: nowHour,
				source: "work",
				calls: 1,
				inputTokens: inT,
				outputTokens: outT,
			});
		}

		// 对抗:多步必须收敛到一行,不能是 7 行
		expect(rowCount(db)).toBe(1);
		const row = getRow(db, "anthropic", "claude-3", nowHour, "work");
		expect(row.calls).toBe(totalCalls);
		expect(row.input_tokens).toBe(totalIn);
		expect(row.output_tokens).toBe(totalOut);
	});

	// ─── 4. mid-session 切 provider → 各自独立行 ──────────────────
	test("4. mid-session provider switch (X→Y) → two independent rows", () => {
		store.upsert({
			provider: "openai",
			model: "gpt-4o",
			hourBucket: nowHour,
			source: "user",
			calls: 1,
			inputTokens: 100,
			outputTokens: 0,
		});
		store.upsert({
			provider: "anthropic",
			model: "claude-3",
			hourBucket: nowHour,
			source: "user",
			calls: 1,
			inputTokens: 200,
			outputTokens: 0,
		});

		// 两行,各归因,无串台
		expect(rowCount(db)).toBe(2);
		expect(getRow(db, "openai", "gpt-4o", nowHour, "user").input_tokens).toBe(
			100,
		);
		expect(
			getRow(db, "anthropic", "claude-3", nowHour, "user").input_tokens,
		).toBe(200);
	});

	// ─── 5. source 维度 ───────────────────────────────────────────
	test("5. different source → different rows (source is part of PK)", () => {
		const sources = ["user", "work", "cron", "background"] as const;
		for (const s of sources) {
			store.upsert({
				provider: "openai",
				model: "gpt-4o",
				hourBucket: nowHour,
				source: s,
				calls: 1,
				inputTokens: 10,
				outputTokens: 0,
			});
		}

		// 4 行,每行 source 唯一
		expect(rowCount(db)).toBe(4);
		for (const s of sources) {
			const row = getRow(db, "openai", "gpt-4o", nowHour, s);
			expect(row).toBeDefined();
			expect(row.calls).toBe(1);
			expect(row.input_tokens).toBe(10);
		}

		// 再来一个 cron step → 只累加到 cron 行,不动其它
		store.upsert({
			provider: "openai",
			model: "gpt-4o",
			hourBucket: nowHour,
			source: "cron",
			calls: 1,
			inputTokens: 5,
			outputTokens: 0,
		});
		expect(rowCount(db)).toBe(4); // 仍 4 行
		expect(getRow(db, "openai", "gpt-4o", nowHour, "cron").calls).toBe(2);
		expect(getRow(db, "openai", "gpt-4o", nowHour, "cron").input_tokens).toBe(
			15,
		);
		// user 行不该被这次 cron 累加污染(对抗)
		expect(getRow(db, "openai", "gpt-4o", nowHour, "user").calls).toBe(1);
	});

	// ─── 6. 天视图(series day) ───────────────────────────────────
	test("6. series(day) = GROUP BY date(hour_bucket)", () => {
		// 跨 3 天,每天 2 桶(2 个不同 hour_bucket),验证天聚合(小时桶 rollup)
		const baseMs = Date.now();
		// 用过去 5 天内的时间,确保在 30d range 内
		const dayA = (offsetDays: number, hourOffset: number) =>
			floorToHourBucket(
				baseMs - offsetDays * 24 * 60 * 60 * 1000 + hourOffset * 60 * 60 * 1000,
			);

		// Day D-2: 两个桶,各 1 call / 100 in
		store.upsert({
			provider: "openai",
			model: "gpt-4o",
			hourBucket: dayA(2, 0),
			source: "user",
			calls: 1,
			inputTokens: 100,
			outputTokens: 0,
		});
		store.upsert({
			provider: "openai",
			model: "gpt-4o",
			hourBucket: dayA(2, 5),
			source: "user",
			calls: 1,
			inputTokens: 100,
			outputTokens: 0,
		});
		// Day D-1: 一个桶
		store.upsert({
			provider: "openai",
			model: "gpt-4o",
			hourBucket: dayA(1, 3),
			source: "user",
			calls: 1,
			inputTokens: 50,
			outputTokens: 0,
		});

		const points = store.series("openai", "day", "30d");
		// 至少有 D-2 / D-1 两个点(可能有更多但本测试只插 3 桶)
		expect(points.length).toBeGreaterThanOrEqual(2);

		// 找到 D-2 与 D-1 的两个点(按 bucket label YYYY-MM-DD 对应)
		const d2Hour = dayA(2, 0);
		const d1Hour = dayA(1, 3);
		const d2Label = d2Hour.slice(0, 10);
		const d1Label = d1Hour.slice(0, 10);

		const d2 = points.find((p) => p.bucket === d2Label);
		const d1 = points.find((p) => p.bucket === d1Label);
		expect(d2).toBeDefined();
		expect(d1).toBeDefined();

		// D-2 = 两桶合计:calls=2, inputTokens=200
		expect(d2!.calls).toBe(2);
		expect(d2!.inputTokens).toBe(200);
		// D-1 = 单桶:calls=1, inputTokens=50
		expect(d1!.calls).toBe(1);
		expect(d1!.inputTokens).toBe(50);

		// 点按 bucket 升序(对抗:实现者可能漏 ORDER BY)
		for (let i = 1; i < points.length; i++) {
			expect(points[i].bucket >= points[i - 1].bucket).toBe(true);
		}
	});

	// ─── 7. 小时视图(series hour, 24h) ──────────────────────────
	test("7. series(hour, 24h) returns each hour bucket separately", () => {
		// 跨近 24 小时插 3 个不同 hour 桶
		const h0 = floorToHourBucket(Date.now()); // 当前小时
		const h1 = floorToHourBucket(Date.now() - 1 * 60 * 60 * 1000); // -1h
		const h5 = floorToHourBucket(Date.now() - 5 * 60 * 60 * 1000); // -5h

		for (const h of [h0, h1, h5]) {
			store.upsert({
				provider: "anthropic",
				model: "claude-3",
				hourBucket: h,
				source: "user",
				calls: 2,
				inputTokens: 30,
				outputTokens: 10,
			});
		}

		const points = store.series("anthropic", "hour", "24h");
		// 至少 3 个点(每个插的小时桶都应在近 24h 内,各自独立成点)
		expect(points.length).toBeGreaterThanOrEqual(3);

		const byBucket = new Map(points.map((p) => [p.bucket, p]));
		expect(byBucket.has(h0)).toBe(true);
		expect(byBucket.has(h1)).toBe(true);
		expect(byBucket.has(h5)).toBe(true);

		// 每点 calls=2 (2×1 次插 calls=2 → 单桶累加 = 2)、inputTokens=30、outputTokens=10
		for (const h of [h0, h1, h5]) {
			const p = byBucket.get(h)!;
			expect(p.calls).toBe(2);
			expect(p.inputTokens).toBe(30);
			expect(p.outputTokens).toBe(10);
			// bucket label 是 ISO hour(对抗 day 视图走 substr(1,10))
			expect(p.bucket.length).toBeGreaterThan(10);
		}

		// 排除超出 24h 的桶(对抗:range 切 cutoff 未生效)
		// 插一个 25h 前的桶,series 不该返回它
		const h25 = floorToHourBucket(Date.now() - 25 * 60 * 60 * 1000);
		store.upsert({
			provider: "anthropic",
			model: "claude-3",
			hourBucket: h25,
			source: "user",
			calls: 1,
			inputTokens: 1,
			outputTokens: 1,
		});
		const pointsAfter = store.series("anthropic", "hour", "24h");
		expect(pointsAfter.find((p) => p.bucket === h25)).toBeUndefined();
	});

	// ─── 8. 留存(30d) ────────────────────────────────────────────
	test("8. cleanOld(30d) removes buckets older than 30d, keeps recent", () => {
		// 一个 31d 前(应删),一个 29d 前(应留),一个今天(应留)
		const old = floorToHourBucket(Date.now() - 31 * 24 * 60 * 60 * 1000);
		const recent = floorToHourBucket(Date.now() - 29 * 24 * 60 * 60 * 1000);
		const today = nowHour;

		for (const h of [old, recent, today]) {
			store.upsert({
				provider: "openai",
				model: "gpt-4o",
				hourBucket: h,
				source: "user",
				calls: 1,
				inputTokens: 10,
				outputTokens: 0,
			});
		}
		expect(rowCount(db)).toBe(3);

		const removed = store.cleanOld(30 * 24 * 60 * 60 * 1000);
		// 至少删掉 31d 那一行(对抗:cutoff 用 updated_at 而非 hour_bucket 会漏)
		expect(removed).toBeGreaterThanOrEqual(1);
		expect(rowCount(db)).toBe(2);

		// 31d 那行没了
		expect(getRow(db, "openai", "gpt-4o", old, "user")).toBeUndefined();
		// 近 30d 内的两行保留
		expect(getRow(db, "openai", "gpt-4o", recent, "user")).toBeDefined();
		expect(getRow(db, "openai", "gpt-4o", today, "user")).toBeDefined();

		// 顺带验 sessionDb.cleanOldProviderUsage(启动路径)等效
		sessionDb.cleanOldProviderUsage(30 * 24 * 60 * 60 * 1000);
		expect(rowCount(db)).toBe(2);
	});

	// ─── 9. error 计(失败 step → 桶 errors +1) ──────────────────
	test("9. failed step increments bucket's errors counter (via SessionManager.recordProviderUsage)", () => {
		// 经 SessionManager 真路径(模拟 metrics-events error 分支调用)。
		// SessionManager 构造需 AgentServiceAccess;recordProviderUsage 只走
		// getProviderUsageStore → this.db,不碰 agentService,所以传空对象即可。
		// db 经 setSessionDb 注入(recordProviderUsage 内 floor(Date.now()),
		// 所以桶 = nowHour)。
		const sm = new SessionManager({} as any);
		sm.setSessionDb(sessionDb);

		// 先放一个 success 步(error=0)
		sm.recordProviderUsage({
			provider: "openai",
			model: "gpt-4o",
			source: "user",
			usage: { inputTokens: 100, outputTokens: 50 },
		});
		let row = getRow(db, "openai", "gpt-4o", nowHour, "user");
		expect(row.errors).toBe(0);
		expect(row.calls).toBe(1);

		// 失败 step → errors +1,calls 也 +1(metrics-events error 分支同样调
		// recordProviderUsage,usage tokens=0、error=true)
		sm.recordProviderUsage({
			provider: "openai",
			model: "gpt-4o",
			source: "user",
			usage: { inputTokens: 0, outputTokens: 0 },
			error: true,
		});

		row = getRow(db, "openai", "gpt-4o", nowHour, "user");
		// 仍单行(同 4-tuple key upsert)
		expect(rowCount(db)).toBe(1);
		expect(row.errors).toBe(1);
		expect(row.calls).toBe(2); // success + failed 都计 call

		// 再失败一次 → errors = 2(对抗:errors 没用累加)
		sm.recordProviderUsage({
			provider: "openai",
			model: "gpt-4o",
			source: "user",
			usage: { inputTokens: 0, outputTokens: 0 },
			error: true,
		});
		row = getRow(db, "openai", "gpt-4o", nowHour, "user");
		expect(row.errors).toBe(2);
		expect(row.calls).toBe(3);
	});

	// ─── cumulative 也覆盖一下(非 acceptance 但 store 主接口) ───
	test("cumulative SUM across table with optional provider/model filter", () => {
		store.upsert({
			provider: "openai",
			model: "gpt-4o",
			hourBucket: nowHour,
			source: "user",
			calls: 2,
			inputTokens: 100,
			outputTokens: 20,
		});
		store.upsert({
			provider: "openai",
			model: "gpt-4o",
			hourBucket: floorToHourBucket(Date.now() - 2 * 60 * 60 * 1000),
			source: "cron",
			calls: 1,
			inputTokens: 50,
			outputTokens: 5,
		});
		store.upsert({
			provider: "anthropic",
			model: "claude-3",
			hourBucket: nowHour,
			source: "user",
			calls: 3,
			inputTokens: 200,
			outputTokens: 30,
		});

		const all = store.cumulative();
		expect(all.calls).toBe(6);
		expect(all.inputTokens).toBe(350);
		expect(all.outputTokens).toBe(55);

		const openaiOnly = store.cumulative("openai");
		expect(openaiOnly.calls).toBe(3);
		expect(openaiOnly.inputTokens).toBe(150);

		const openaiGpt = store.cumulative("openai", "gpt-4o");
		expect(openaiGpt.calls).toBe(3);

		// 不存在 → zeros(对抗:返回 null/undefined 会让消费方崩)
		const ghost = store.cumulative("nonexistent");
		expect(ghost.calls).toBe(0);
		expect(ghost.inputTokens).toBe(0);
	});

	// ─── latency accumulator (sub-2 补遗; fixes acceptance-5 #2 FAIL) ──
	// Per design ②.2: per-provider latency is a process-local running average,
	// NOT in the DB. SessionManager folds each successful step's durationMs into
	// an in-memory Map; getProviderLatencyMs returns the avg. Restart-safe (Map
	// clears on boot). This proves the sub-5 #2 "latencyMs is null — GAP" path
	// is closed: when the real SessionManager (not a test mock) wires through,
	// listProviderStats surfaces a non-null avg.
	test("10. recordProviderUsage durationMs folds into per-provider process-local latency avg (sub-2 补遗)", () => {
		// Cold-DB tolerated: the latency fold runs BEFORE the store guard, so
		// even with no SessionDB attached the accumulator fills. (Production
		// always has a DB; this proves the latency path is independent of it,
		// matching design ②.2's "NOT in DB" decision.)
		const sm = new SessionManager({} as any);
		// No setSessionDb → getProviderUsageStore() returns undefined, but the
		// latency fold still lands (it is process-local, not DB-backed).

		// No data yet → undefined (listProviderStats renders as null → "N/A").
		expect(sm.getProviderLatencyMs("openai")).toBeUndefined();

		// Two successful steps: 100ms + 200ms → avg 150ms.
		sm.recordProviderUsage({
			provider: "openai", model: "gpt-4o", source: "user",
			usage: { inputTokens: 10, outputTokens: 5 }, durationMs: 100,
		});
		sm.recordProviderUsage({
			provider: "openai", model: "gpt-4o", source: "user",
			usage: { inputTokens: 10, outputTokens: 5 }, durationMs: 200,
		});
		expect(sm.getProviderLatencyMs("openai")).toBe(150);

		// Different provider accumulates independently.
		expect(sm.getProviderLatencyMs("anthropic")).toBeUndefined();
		sm.recordProviderUsage({
			provider: "anthropic", model: "claude", source: "user",
			usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 300,
		});
		expect(sm.getProviderLatencyMs("anthropic")).toBe(300);
		expect(sm.getProviderLatencyMs("openai")).toBe(150); // unchanged

		// Failed step (error path) does NOT fold its duration — its latency is
		// not representative of successful provider throughput.
		sm.recordProviderUsage({
			provider: "openai", model: "gpt-4o", source: "user",
			usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 9999, error: true,
		});
		expect(sm.getProviderLatencyMs("openai")).toBe(150);

		// Missing durationMs (older callers / synthetic events) → no-op.
		sm.recordProviderUsage({
			provider: "openai", model: "gpt-4o", source: "user",
			usage: { inputTokens: 0, outputTokens: 0 },
		});
		expect(sm.getProviderLatencyMs("openai")).toBe(150);
	});
});
