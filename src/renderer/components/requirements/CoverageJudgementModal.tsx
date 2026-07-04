// PM 覆盖判断视图 (v0.8 M4 — RFC §2.17b / decision 34)
//
// # 文件说明书
//
// ## 核心功能
// verify 状态的需求卡「Coverage」按钮弹出本视图。展示:
//   - 需求意图文档(PM 写的需求 markdown)
//   - M3 Orchestrate 产出的 manifest(改了哪些文件 + 跑了哪些测试 + 审查结果)
// PM 只判「改动 + 测试是否覆盖原需求意图」(产品颗粒度,不碰技术),提交后驱动
// notify("verify_accept" | "verify_reject")。
//
// ## 不做的事 (decision 34)
// - 不做技术 accept(技术验收在 Orchestrate 流程内)
// - 不引入 productionReady 多门禁聚合
//
// ## 输入
// - requirementId(通过 pm:coverageView 拉视图)
//
// ## 输出
// - 覆盖判断 verdict(通过 pm:coverageVerdict 提交)
//
// ## 定位
// 渲染进程组件,被 KanbanPage 使用。
//
// ## 依赖
// - react
// - window.api.pmCoverageView / pmCoverageVerdict
//

import React, { useEffect, useState } from "react";
import type { RequirementRecord, OrchestrateManifestRecord } from "../../../shared/types.js";

interface CoverageJudgementModalProps {
	requirementId: string | null;
	onClose: () => void;
}

const api = () => (window as any).api;

export default function CoverageJudgementModal({ requirementId, onClose }: CoverageJudgementModalProps) {
	const [loading, setLoading] = useState(false);
	const [requirement, setRequirement] = useState<RequirementRecord | undefined>(undefined);
	const [intentDoc, setIntentDoc] = useState<string | undefined>(undefined);
	const [manifest, setManifest] = useState<OrchestrateManifestRecord | undefined>(undefined);
	const [reason, setReason] = useState("");
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		if (!requirementId) return;
		setLoading(true);
		setReason("");
		api()
			?.pmCoverageView(requirementId)
			.then((v: any) => {
				setRequirement(v?.requirement);
				setIntentDoc(v?.intentDoc);
				setManifest(v?.manifest);
			})
			.catch(() => {})
			.finally(() => setLoading(false));
	}, [requirementId]);

	if (!requirementId) return null;

	const submit = async (covered: boolean) => {
		setSubmitting(true);
		try {
			// project-flow F4: route the user verdict through the shared
			// FlowActions backend (POST /api/requirements/:id/coverage-verdict).
			// Same compound close the runtime Flow.verify uses — single source.
			// Falls back to the legacy pm:coverageVerdict channel when the new
			// IPC handle is missing (older preload).
			const apiAny = api() as any;
			const r = apiAny?.requirementsCoverageVerdict
				? await apiAny.requirementsCoverageVerdict(requirementId, covered, reason.trim() || undefined)
				: await apiAny?.pmCoverageVerdict(requirementId, covered, reason.trim() || undefined);
			if (r?.error) {
				alert(`Verdict failed: ${r.error}`);
				return;
			}
			onClose();
		} catch (e) {
			alert(`Verdict error: ${(e as Error).message}`);
		} finally {
			setSubmitting(false);
		}
	};

	const touchedFiles: string[] = manifest?.touchedFiles ?? [];
	const tests: any[] = manifest?.tests ?? [];

	return (
		<div
			onClick={onClose}
			style={{
				position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
				display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
			}}
		>
			<div
				onClick={(e) => e.stopPropagation()}
				style={{
					width: "min(720px, 90vw)", maxHeight: "85vh", overflowY: "auto",
					background: "var(--bg-secondary, #1c1c1e)",
					border: "1px solid var(--border-color, #333)", borderRadius: 8, padding: 20,
				}}
			>
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
					<h3 style={{ margin: 0, fontSize: 15, color: "var(--text-primary, #e0e0e0)" }}>
						{"\u{1F50D}"} Coverage Judgement
					</h3>
					<button type="button" onClick={onClose} style={btnGhost}>Close</button>
				</div>

				{loading && <div style={muted}>Loading…</div>}

				{requirement && (
					<div style={{ marginBottom: 12 }}>
						<div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary, #e0e0e0)" }}>
							{requirement.title}
						</div>
						<div style={muted}>status: {requirement.status} · docPath: {requirement.docPath ?? "(none)"}</div>
					</div>
				)}

				<section style={{ marginBottom: 16 }}>
					<h4 style={sectionH}>Requirement Intent (product)</h4>
					<pre style={preBox}>{intentDoc || "_(no intent doc — PM has not authored one yet)_"}</pre>
				</section>

				<section style={{ marginBottom: 16 }}>
					<h4 style={sectionH}>Manifest — Changes + Tests + Review (from Orchestrate flow)</h4>
					{!manifest && <div style={muted}>(no manifest — lead has not run the flow yet)</div>}
					{manifest && (
						<>
							<div style={muted}>Review verdict: <b>{manifest.review?.verdict ?? "n/a"}</b></div>
							<div style={{ marginTop: 6, fontSize: 12, color: "var(--text-secondary, #888)" }}>
								Changed files ({touchedFiles.length}):
							</div>
							<ul style={{ margin: "4px 0", paddingLeft: 20, fontSize: 11, color: "var(--text-secondary, #aaa)" }}>
								{touchedFiles.length === 0 && <li>(none)</li>}
								{touchedFiles.map((f) => <li key={f}>{f}</li>)}
							</ul>
							<div style={{ marginTop: 6, fontSize: 12, color: "var(--text-secondary, #888)" }}>
								Tests ({tests.length}):
							</div>
							<ul style={{ margin: "4px 0", paddingLeft: 20, fontSize: 11, color: "var(--text-secondary, #aaa)" }}>
								{tests.length === 0 && <li>(none)</li>}
								{tests.map((t: any, i: number) => (
									<li key={i}>{t.name ?? `test-${i}`} — {t.ok ? "pass" : "fail"}</li>
								))}
							</ul>
						</>
					)}
				</section>

				<section style={{ marginBottom: 12 }}>
					<h4 style={sectionH}>PM verdict — do changes+tests cover the intent?</h4>
					<textarea
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						placeholder="Reason / gaps (optional for accept, recommended for reject)"
						style={{ width: "100%", minHeight: 60, boxSizing: "border-box", ...textInput }}
					/>
				</section>

				<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
					<button type="button" onClick={() => submit(false)} disabled={submitting} style={btnReject}>
						{submitting ? "..." : "Not covered"}
					</button>
					<button type="button" onClick={() => submit(true)} disabled={submitting} style={btnAccept}>
						{submitting ? "..." : "Covered"}
					</button>
				</div>
			</div>
		</div>
	);
}

const muted: React.CSSProperties = {
	fontSize: 11, color: "var(--text-tertiary, #888)", marginTop: 2,
};
const sectionH: React.CSSProperties = {
	margin: "0 0 6px 0", fontSize: 12, fontWeight: 600, color: "var(--text-secondary, #aaa)",
	textTransform: "uppercase", letterSpacing: 0.5,
};
const preBox: React.CSSProperties = {
	background: "var(--bg-primary, #1a1a1c)", border: "1px solid var(--border-color, #333)",
	borderRadius: 4, padding: 10, fontSize: 11, whiteSpace: "pre-wrap", maxHeight: 200, overflowY: "auto",
	color: "var(--text-secondary, #ccc)",
};
const textInput: React.CSSProperties = {
	background: "var(--bg-primary, #1a1a1c)", border: "1px solid var(--border-color, #333)",
	borderRadius: 4, padding: 6, fontSize: 12, color: "var(--text-primary, #e0e0e0)",
};
const btnGhost: React.CSSProperties = {
	padding: "4px 10px", background: "transparent", border: "1px solid var(--border-color, #333)",
	borderRadius: 4, color: "var(--text-secondary, #888)", fontSize: 12, cursor: "pointer",
};
const btnAccept: React.CSSProperties = {
	padding: "6px 14px", background: "#4CAF50", border: "none", borderRadius: 4,
	color: "#fff", fontSize: 12, cursor: "pointer",
};
const btnReject: React.CSSProperties = {
	padding: "6px 14px", background: "#f44336", border: "none", borderRadius: 4,
	color: "#fff", fontSize: 12, cursor: "pointer",
};
