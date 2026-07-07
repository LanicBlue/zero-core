// platform-observability ③ (sub-6): 堆叠柱状图组件
//
// # 文件说明书
//
// ## 核心功能
// 把 provider:usage 返回的 PlatformProviderSeries(每模型一条 points 序列)
// 渲染成 SVG 堆叠柱状图:每个 bucket(小时柱 / 天柱)是一根柱,柱内分段 = 模型,
// 柱高 = 该 bucket 所有模型 token 总和。
//
// ## 输入
// - series: PlatformProviderSeries(granularity hour|day, range 24h|30d,
//   series = 每模型 {points:[{bucket,calls,tokens,errors}]}).
// - (可选)空数据态自己渲染空态占位。
//
// ## 输出
// - SVG 堆叠柱状图(纯前端,零依赖 —— 无 chart 库时轻量自绘)。
//
// ## 定位
// 渲染进程看板组件,被 DashboardPage 底部 Provider 区消费。
//
// ## 维护规则
// - 不引入重 chart 库(仓库无现成 chart 依赖;自绘 SVG/div)。
// - bucket 标签密度自适应:24h 显小时,30d 显日期。
// - 模型色板固定调色板循环(避免随机色)。
//
import React, { useMemo, useState } from "react";
import type { PlatformProviderSeries } from "../../../shared/types.js";

// ─── 调色板(固定循环,稳定映射) ──────────────────────────────────
const PALETTE = [
	"#5b8def", "#22c55e", "#f59e0b", "#ef4444", "#a855f7",
	"#06b6d4", "#ec4899", "#84cc16", "#f97316", "#6366f1",
	"#14b8a6", "#eab308",
];

interface StackedBarChartProps {
	series: PlatformProviderSeries;
	/** 图表高度(px)。默认 220。 */
	height?: number;
}

interface Bucket {
	key: string;
	label: string;
	/** model → tokens */
	byModel: Map<string, number>;
	total: number;
}

/**
 * 把 PlatformProviderSeries.series(每模型一条序列)按 bucket 合并成
 * "每 bucket 的 model 堆栈"。bucket 顺序 = 升序。
 *
 * 缺失的 bucket 会补零行(让 24h 视图固定 24 柱、30d 视图固定 30 柱),
 * 否则稀疏数据会让柱数跳动,看板不稳。
 */
function buildBuckets(series: PlatformProviderSeries): { buckets: Bucket[]; models: string[]; maxTotal: number } {
	const granularity = series.granularity;
	const range = series.range;
	const now = Date.now();

	// 1. 枚举所有出现的模型 + 所有出现的 bucket。
	const modelSet = new Set<string>();
	const bucketSet = new Set<string>();
	for (const s of series.series) {
		modelSet.add(s.model);
		for (const pt of s.points) bucketSet.add(pt.bucket);
	}

	// 2. 生成期望的 bucket 轴(24h = 24 小时桶,30d = 30 天桶),按 [start, end) 升序。
	const expectedBuckets = granularity === "hour" ? hourBuckets(now, 24) : dayBuckets(now, 30);
	// 真实出现但不在 expectedBuckets 里的(早于窗口边界的残留)一并并入,排序时落到尾/头。
	for (const b of bucketSet) {
		if (!expectedBuckets.includes(b)) expectedBuckets.push(b);
	}
	expectedBuckets.sort();

	const models = Array.from(modelSet).sort();

	// 3. 每个 bucket 聚合 model → tokens。
	const buckets: Bucket[] = expectedBuckets.map((key) => {
		const byModel = new Map<string, number>();
		for (const s of series.series) {
			const pt = s.points.find((p: { bucket: string }) => p.bucket === key);
			if (pt && pt.tokens > 0) byModel.set(s.model, pt.tokens);
		}
		let total = 0;
		for (const v of byModel.values()) total += v;
		return { key, label: bucketLabel(key, granularity), byModel, total };
	});

	let maxTotal = 0;
	for (const b of buckets) if (b.total > maxTotal) maxTotal = b.total;
	return { buckets, models, maxTotal };
}

/** 生成最近 N 小时的 bucket key(UTC, "YYYY-MM-DDTHH:00:00.000Z")。 */
function hourBuckets(nowMs: number, count: number): string[] {
	const out: string[] = [];
	const base = new Date(nowMs);
	base.setUTCMinutes(0, 0, 0);
	for (let i = count - 1; i >= 0; i--) {
		const d = new Date(base.getTime() - i * 3600_000);
		out.push(d.toISOString().replace(/:\d{2}\.\d{3}Z$/, ":00:00.000Z"));
	}
	return out;
}

/** 生成最近 N 天的 bucket key(UTC 日期, "YYYY-MM-DDT00:00:00.000Z")。 */
function dayBuckets(nowMs: number, count: number): string[] {
	const out: string[] = [];
	const base = new Date(nowMs);
	base.setUTCHours(0, 0, 0, 0);
	for (let i = count - 1; i >= 0; i--) {
		const d = new Date(base.getTime() - i * 86400_000);
		out.push(d.toISOString().replace(/T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "T00:00:00.000Z"));
	}
	return out;
}

/** 柱标签:小时桶显 HH:MM(本地),天桶显 MM-DD。 */
function bucketLabel(bucket: string, granularity: "hour" | "day"): string {
	const t = Date.parse(bucket);
	if (!Number.isFinite(t)) return bucket;
	const d = new Date(t);
	if (granularity === "hour") {
		const hh = String(d.getHours()).padStart(2, "0");
		return `${hh}:00`;
	}
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${mm}-${dd}`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export default function StackedBarChart({ series, height = 220 }: StackedBarChartProps) {
	const { buckets, models, maxTotal } = useMemo(() => buildBuckets(series), [series]);
	const [hover, setHover] = useState<number | null>(null);

	if (buckets.length === 0 || maxTotal === 0) {
		return <div className="sbc-empty">暂无用量数据</div>;
	}

	// 布局:左侧轴区 + 柱区 + 底标签区。
	const padLeft = 44;
	const padRight = 8;
	const padTop = 8;
	const padBottom = 24;
	const chartH = height - padTop - padBottom;
	// 柱宽自适应:容器用 100% 宽,柱等分。
	const barGap = 2;
	// 用 viewBox + preserveAspectRatio 让宽度响应式;柱数固定后等分。
	const viewBoxWidth = Math.max(buckets.length * 16, 320);
	const plotW = viewBoxWidth - padLeft - padRight;
	const barW = Math.max(2, (plotW - barGap * (buckets.length - 1)) / buckets.length);

	// y 轴 4 条刻度(0 / 25 / 50 / 75 / 100% of maxTotal)。
	const ticks = [0, 0.25, 0.5, 0.75, 1];

	return (
		<div className="sbc-wrap">
			<svg
				className="sbc-svg"
				viewBox={`0 0 ${viewBoxWidth} ${height}`}
				preserveAspectRatio="none"
				role="img"
				aria-label={`${series.provider} 用量堆叠柱状图(${series.granularity === "hour" ? "近 24 小时" : "近 30 天"})`}
			>
				{/* y 轴刻度线 + 标签 */}
				{ticks.map((t) => {
					const y = padTop + chartH * (1 - t);
					return (
						<g key={t}>
							<line
								x1={padLeft} x2={viewBoxWidth - padRight}
								y1={y} y2={y}
								stroke="var(--border-muted)" strokeWidth={0.5}
								strokeDasharray={t === 0 ? "" : "2,2"}
							/>
							<text
								x={padLeft - 6} y={y + 3}
								textAnchor="end" fontSize={9}
								fill="var(--fg-subtle)"
							>
								{formatTokens(Math.round(maxTotal * t))}
							</text>
						</g>
					);
				})}

				{/* 柱 */}
				{buckets.map((b, i) => {
					const x = padLeft + i * (barW + barGap);
					let yCursor = padTop + chartH; // 从底往上堆
					const segs: React.ReactElement[] = [];
					models.forEach((model, mi) => {
						const v = b.byModel.get(model) ?? 0;
						if (v <= 0) return;
						const segH = (v / maxTotal) * chartH;
						yCursor -= segH;
						segs.push(
							<rect
								key={model}
								x={x} y={yCursor}
								width={barW} height={segH}
								fill={PALETTE[mi % PALETTE.length]}
							/>,
						);
					});
					const isHover = hover === i;
					return (
						<g
							key={b.key}
							onMouseEnter={() => setHover(i)}
							onMouseLeave={() => setHover(null)}
							opacity={hover === null || isHover ? 1 : 0.45}
						>
							{/* 透明命中区,便于 hover 全柱 */}
							<rect
								x={x} y={padTop}
								width={barW} height={chartH}
								fill="transparent"
							/>
							{segs}
							{/* 底标签:每 N 柱显一个,避免拥挤 */}
							{shouldShowLabel(i, buckets.length) && (
								<text
									x={x + barW / 2} y={height - 8}
									textAnchor="middle" fontSize={8}
									fill="var(--fg-subtle)"
								>
									{b.label}
								</text>
							)}
						</g>
					);
				})}
			</svg>

			{/* hover tooltip */}
			{hover !== null && (
				<div className="sbc-tooltip">
					<div className="sbc-tooltip-bucket">{buckets[hover].label}</div>
					<div className="sbc-tooltip-total">总量 {formatTokens(buckets[hover].total)} tokens</div>
					{models
						.map((m) => ({ m, v: buckets[hover].byModel.get(m) ?? 0 }))
						.filter((x) => x.v > 0)
						.sort((a, b) => b.v - a.v)
						.map((x, idx) => {
							const colorIdx = models.indexOf(x.m);
							return (
								<div key={x.m} className="sbc-tooltip-row">
									<span className="sbc-dot" style={{ background: PALETTE[colorIdx % PALETTE.length] }} />
									<span className="sbc-model">{x.m}</span>
									<span className="sbc-val">{formatTokens(x.v)}</span>
									{idx === 0 && <span className="sbc-rank">主导</span>}
								</div>
							);
						})}
				</div>
			)}

			{/* 图例 */}
			{models.length > 0 && (
				<div className="sbc-legend">
					{models.map((m, i) => (
						<span key={m} className="sbc-legend-item">
							<span className="sbc-dot" style={{ background: PALETTE[i % PALETTE.length] }} />
							{m}
						</span>
					))}
				</div>
			)}
		</div>
	);
}

/** 柱数多时稀疏显标签(24 柱每 3 个显一个,30 柱每 3 个,≤12 柱全显)。 */
function shouldShowLabel(i: number, total: number): boolean {
	if (total <= 12) return true;
	return i % 3 === 0;
}
