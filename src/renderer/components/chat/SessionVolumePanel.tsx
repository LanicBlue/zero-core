// steps-overhaul sub-9: session content-volume panel.
//
// # 文件说明书
//
// ## 核心功能
// 展示当前 session 的内容量确认 —— 步数 / 轮数 / token 体积,以及 UI 展示窗口
// (max(100 step, 5 turn),取多的)。让用户一眼知道"这个 session 有多大、UI 显示
// 了其中的多少"。
//
// ## 数据源
// `steps` 表(原始不可变),经 sessionsGetInit → chat-store.volumeBySession 流入。
// 不是 messages(LLM 视图)。详见 agent-service.getSessionVolume / session-volume.ts。
//
// ## 形态
// 独立可折叠面板,default 安静(collapsed)—— 不挤 chat-header 的 context-usage
// 主条。展开后才显示详情(覆盖范围说明 + token snapshot)。符合 design 倾向
// "独立展开面板(default 安静)" + acceptance-9"默认安静"。
//
// ## 定位
// 渲染进程组件,被 ChatPanel 使用(挂在 chat-header 下方、messages 上方)。
//
// ## 维护规则
// - 展示规则变更(窗口大小等)在 session-volume.ts(STEP_WINDOW/TURN_WINDOW),
//   本组件只渲染。
// - 不要在此组件直接读 DB / IPC —— 数据从 chat-store pull-on-display 来。

import React, { useState } from "react";
import type { SessionVolumeInfo } from "../../../shared/types.js";

/** 1234 → "1.2K"; 1500000 → "1.5M". Matches context-usage formatting. */
function formatCount(n: number): string {
	return n >= 1048576
		? (n / 1048576).toFixed(n % 1048576 === 0 ? 0 : 1) + "M"
		: n >= 1000
			? Math.round(n / 1000) + "K"
			: String(n);
}

interface Props {
	volume: SessionVolumeInfo | null;
}

/**
 * Collapsible content-volume panel. Collapsed (default) shows a one-line summary
 * (step · turn counts); expanded shows the display-window explanation and the
 * token-usage snapshot. Renders nothing when there's no volume yet (session not
 * pulled) OR the session is empty (0 steps) — keep the header clean for fresh
 * sessions.
 */
export default function SessionVolumePanel({ volume }: Props) {
	const [expanded, setExpanded] = useState(false);

	// No data yet (session not pulled) or empty session → render nothing so a
	// fresh session's header stays clean (acceptance-9: default 安静).
	if (!volume || volume.totalStepCount === 0) return null;

	const { totalStepCount, totalTurnCount, tokenUsage, displayWindow } = volume;

	// One-line collapsed summary: "📏 42 steps · 8 turns". Click to expand.
	// The 📏 prefix + tooltip signal "this is a volume indicator, click for
	// detail" without crowding the context-usage bar (which lives in the header).
	const summaryLabel = `${formatCount(totalStepCount)} steps · ${formatCount(totalTurnCount)} turn${totalTurnCount !== 1 ? "s" : ""}`;

	// Display-window explanation: which range is shown and why.
	// basis="steps" → showing the last N steps (covers M turns est.).
	// basis="turns" → showing the last M turns (covers N steps est.).
	const windowText = displayWindow.basis === "steps"
		? `Showing last ${formatCount(displayWindow.coveredSteps)} step${displayWindow.coveredSteps !== 1 ? "s" : ""} (~${displayWindow.coveredTurns} turn${displayWindow.coveredTurns !== 1 ? "s" : ""} of ${formatCount(totalTurnCount)}) — step window won (max 100 step vs 5 turn)`
		: `Showing last ${displayWindow.coveredTurns} turn${displayWindow.coveredTurns !== 1 ? "s" : ""} (~${formatCount(displayWindow.coveredSteps)} step${displayWindow.coveredSteps !== 1 ? "s" : ""} of ${formatCount(totalStepCount)}) — turn window won (max 100 step vs 5 turn)`;

	return (
		<div className="session-volume-panel">
			<button
				type="button"
				className="session-volume-toggle"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				title="Session content volume (steps / turns / token size). Click for detail."
			>
				<span className="session-volume-chevron">{expanded ? "▾" : "▸"}</span>
				<span className="session-volume-icon" aria-hidden="true">📏</span>
				<span className="session-volume-summary">{summaryLabel}</span>
			</button>
			{expanded && (
				<div className="session-volume-details">
					<div className="session-volume-row">
						<span className="session-volume-label">Total steps</span>
						<span className="session-volume-value">{totalStepCount.toLocaleString()}</span>
					</div>
					<div className="session-volume-row">
						<span className="session-volume-label">Total turns</span>
						<span className="session-volume-value">{totalTurnCount.toLocaleString()}</span>
					</div>
					<div className="session-volume-row session-volume-window">
						<span className="session-volume-label">Display window</span>
						<span className="session-volume-value">{windowText}</span>
					</div>
					{tokenUsage && (
						<div className="session-volume-row session-volume-token">
							<span className="session-volume-label">Last API usage</span>
							<span className="session-volume-value">
								{typeof tokenUsage.inputTokens === "number" ? `${formatCount(tokenUsage.inputTokens)} in` : ""}
								{typeof tokenUsage.inputTokens === "number" && typeof tokenUsage.outputTokens === "number" ? " · " : ""}
								{typeof tokenUsage.outputTokens === "number" ? `${formatCount(tokenUsage.outputTokens)} out` : ""}
								{typeof tokenUsage.totalTokens === "number" ? ` · ${formatCount(tokenUsage.totalTokens)} total` : ""}
							</span>
						</div>
					)}
					<div className="session-volume-source">
						Source: <code>steps</code> table (原始不可变) · max(100 step, 5 turn)
					</div>
				</div>
			)}
		</div>
	);
}
