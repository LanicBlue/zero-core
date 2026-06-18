// 看板主页面
//
// # 文件说明书
//
// ## 核心功能
// 需求管理看板页面，按状态分列展示需求卡片。
//
// ## 输入
// - requirementStore (Zustand)
// - projectStore (Zustand)
// - pageStore (Zustand)
//
// ## 输出
// - 渲染的看板页面
//
// ## 定位
// 渲染进程组件，被 AppLayout 使用。
//
// ## 依赖
// - react
// - ../../store/*
//
// ## 维护规则
// - 看板列划分或 RequirementStatus 状态机变更时同步分列逻辑
// - 新增需求操作（创建/流转）需在此挂接入弹窗或卡片回调
//
import React, { useEffect, useState, useCallback } from "react";
import type { RequirementRecord, RequirementStatus, OrchestratePlanRecord } from "../../../shared/types.js";
import { useRequirementStore } from "../../store/requirement-store.js";
import { useProjectStore } from "../../store/project-store.js";
import { usePageStore } from "../../store/page-store.js";
import RequirementCard from "./RequirementCard.js";
import CreateRequirementModal from "./CreateRequirementModal.js";
import ExecutionDetailPanel from "./ExecutionDetailPanel.js";
import CoverageJudgementModal from "./CoverageJudgementModal.js";

const KANBAN_COLUMNS: { status: RequirementStatus; icon: string; label: string; color: string }[] = [
	{ status: "found",   icon: "💡", label: "Found",   color: "#8B8B8B" },
	{ status: "discuss", icon: "💬", label: "Discuss", color: "#2196F3" },
	{ status: "ready",   icon: "✅", label: "Ready",   color: "#4CAF50" },
	{ status: "plan",    icon: "📋", label: "Plan",    color: "#9C27B0" },
	{ status: "build",   icon: "🔨", label: "Build",   color: "#FF9800" },
	{ status: "verify",  icon: "🔍", label: "Verify",  color: "#00BCD4" },
];

export default function KanbanPage() {
	const { fetchRequirements, getGroupedByStatus, fetchSteps, stepsByReq, messagesByReq, fetchMessages, loading } = useRequirementStore();
	const { projects, fetchProjects } = useProjectStore();
	const { setActivePage, setActiveRequirementId } = usePageStore();

	const [showCreateModal, setShowCreateModal] = useState(false);
	const [selectedProjectId, setSelectedProjectId] = useState<string>("");
	const [expandedReqId, setExpandedReqId] = useState<string | null>(null);
	// v0.8 (M3): pending Orchestrate plans awaiting user confirm (decision 11 —
	// plan 门是 confirm-gate,审核方 = 用户,看板提醒入口)。
	const [pendingPlans, setPendingPlans] = useState<OrchestratePlanRecord[]>([]);
	const [planActionInFlight, setPlanActionInFlight] = useState<string | null>(null);
	const [rejectingPlanId, setRejectingPlanId] = useState<string | null>(null);
	const [rejectReason, setRejectReason] = useState<string>("");

	// Fetch data on mount
	useEffect(() => {
		fetchProjects();
		fetchRequirements();
	}, []);

	const fetchPendingPlans = useCallback(async (projectId?: string) => {
		try {
			const api = (window as any).api;
			if (!api?.orchestratePending) return;
			const plans = await api.orchestratePending(projectId ? { projectId } : undefined) as OrchestratePlanRecord[];
			setPendingPlans(Array.isArray(plans) ? plans : []);
		} catch {
			// best-effort — silent
		}
	}, []);

	// Refresh when project filter changes
	useEffect(() => {
		if (selectedProjectId) {
			fetchRequirements({ projectId: selectedProjectId });
		}
		fetchPendingPlans(selectedProjectId || undefined);
	}, [selectedProjectId, fetchPendingPlans]);

	// Initial fetch of pending plans on mount + periodic refresh so the user
	// sees new pending plans as lead submits them (the confirm gate is a
	// long-lived pause; the user must be able to discover it).
	useEffect(() => {
		fetchPendingPlans();
		const timer = setInterval(() => fetchPendingPlans(selectedProjectId || undefined), 5000);
		return () => clearInterval(timer);
	}, [fetchPendingPlans, selectedProjectId]);

	const grouped = getGroupedByStatus();

	const handleCardClick = useCallback((req: RequirementRecord) => {
		if (req.status === "found" || req.status === "discuss") {
			// Jump to chat with discussion message
			setActiveRequirementId(req.id);
			setActivePage("chat");
			fetchMessages(req.id);
		} else if (req.status === "plan" || req.status === "build" || req.status === "verify") {
			// Toggle execution detail panel
			if (expandedReqId === req.id) {
				setExpandedReqId(null);
			} else {
				setExpandedReqId(req.id);
				fetchSteps(req.id);
				fetchMessages(req.id);
			}
		}
		// ready: just show details (no action needed, lead auto-picks up)
	}, [expandedReqId, setActivePage, setActiveRequirementId, fetchSteps, fetchMessages]);

	const handleRefresh = () => {
		fetchRequirements(selectedProjectId ? { projectId: selectedProjectId } : undefined);
		fetchPendingPlans(selectedProjectId || undefined);
	};

	// v0.8 (M3): confirm / reject plan-gate handlers (decision 11).
	const handleConfirmPlan = useCallback(async (planId: string) => {
		const api = (window as any).api;
		if (!api?.orchestrateConfirm) return;
		setPlanActionInFlight(planId);
		try {
			const r = await api.orchestrateConfirm(planId);
			if (!r?.success) {
				alert(`Confirm failed: ${r?.reason ?? "(unknown)"}`);
			}
			await fetchPendingPlans(selectedProjectId || undefined);
		} catch (e) {
			alert(`Confirm error: ${(e as Error).message}`);
		} finally {
			setPlanActionInFlight(null);
		}
	}, [fetchPendingPlans, selectedProjectId]);

	const handleRejectPlan = useCallback(async (planId: string, reason: string) => {
		const api = (window as any).api;
		if (!api?.orchestrateReject) return;
		setPlanActionInFlight(planId);
		try {
			const r = await api.orchestrateReject(planId, reason);
			if (!r?.success) {
				alert(`Reject failed: ${r?.reason ?? "(unknown)"}`);
			}
			setRejectingPlanId(null);
			setRejectReason("");
			await fetchPendingPlans(selectedProjectId || undefined);
		} catch (e) {
			alert(`Reject error: ${(e as Error).message}`);
		} finally {
			setPlanActionInFlight(null);
		}
	}, [fetchPendingPlans, selectedProjectId]);

	// v0.8 P7 (§4.2): open the {PM, projectId} discuss session — kanban "讨论"
	// entry → chat page. Routes via pm:openDiscuss(requirementId) so the
	// backend can address the PM by req.createdByAgentId (P7 pull model — no
	// roleTag scan). Then activates the PM agent + session in the chat store
	// so the existing chat page renders it, AND opens the requirement's doc in
	// the DocViewerPanel (user wants to see the requirement doc + talk to PM in
	// the same view).
	const [coverageReqId, setCoverageReqId] = useState<string | null>(null);
	const handleDiscuss = useCallback(async (req: RequirementRecord) => {
		const api = (window as any).api;
		if (!api?.pmOpenDiscuss) return;
		try {
			const r = await api.pmOpenDiscuss(req.id);
			if (r?.error) { alert(`Discuss failed: ${r.error}`); return; }
			const chatStore = (await import("../../store/chat-store.js")).useChatStore.getState();
			chatStore.setActiveAgent(r.agentId, r.sessionId);
			const page = (await import("../../store/page-store.js")).usePageStore.getState();
			page.setActivePage("chat");
			// Open the requirement doc in the DocViewerPanel so the user sees
			// the requirement file alongside the PM chat. docPath is workspace-
			// relative (POSIX); root = the project's workspaceDir.
			if (req.docPath) {
				try {
					const project = await api.projectsGet(req.projectId);
					const root: string = project?.workspaceDir ?? "";
					window.dispatchEvent(new CustomEvent("zero-file-select", {
						detail: { path: req.docPath, root },
					}));
				} catch {
					// Non-fatal: doc open is a convenience, not the main path.
				}
			}
		} catch (e) {
			alert(`Discuss error: ${(e as Error).message}`);
		}
	}, []);

	// v0.8 (M4): open the PM coverage-judgement view (decision 34). Loads the
	// requirement intent doc + latest manifest; user records the verdict which
	// drives notify("verify_accept" | "verify_reject") via pm:coverageVerdict.
	const handleCoverage = useCallback((req: RequirementRecord) => {
		setCoverageReqId(req.id);
	}, []);

	return (
		<div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-primary, #1a1a1c)" }}>
			{/* Toolbar */}
			<div style={{
				display: "flex",
				alignItems: "center",
				gap: 12,
				padding: "12px 16px",
				borderBottom: "1px solid var(--border-color, #333)",
			}}>
				<span style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary, #e0e0e0)" }}>
					{"\u{1F4CB}"} Requirements
				</span>
				<div style={{ flex: 1 }} />
				<select
					value={selectedProjectId}
					onChange={(e) => setSelectedProjectId(e.target.value)}
					style={{
						padding: "4px 8px",
						background: "var(--bg-secondary, #1c1c1e)",
						border: "1px solid var(--border-color, #333)",
						borderRadius: 4,
						color: "var(--text-primary, #e0e0e0)",
						fontSize: 12,
					}}
				>
					<option value="">All Projects</option>
					{projects.map((p) => (
						<option key={p.id} value={p.id}>{p.name}</option>
					))}
				</select>
				<button
					type="button"
					onClick={() => setShowCreateModal(true)}
					style={{
						padding: "4px 12px",
						background: "#2196F3",
						border: "none",
						borderRadius: 4,
						color: "#fff",
						fontSize: 12,
						cursor: "pointer",
					}}
				>
					+ New
				</button>
				<button
					type="button"
					onClick={handleRefresh}
					disabled={loading}
					style={{
						padding: "4px 10px",
						background: "transparent",
						border: "1px solid var(--border-color, #333)",
						borderRadius: 4,
						color: "var(--text-secondary, #888)",
						fontSize: 12,
						cursor: "pointer",
					}}
				>
					{loading ? "..." : "\u{1F504}"}
				</button>
			</div>

			{/* Kanban columns */}
			<div style={{
				flex: 1,
				display: "flex",
				overflowX: "auto",
				gap: 0,
			}}>
			{/* v0.8 (M3): pending plan-gate entry (RFC §2.9 / decision 11) —
				surfaces plans awaiting user confirm. Card-list + confirm/reject. */}
			{pendingPlans.length > 0 && (
				<div style={{
					flex: "0 0 280px",
					display: "flex",
					flexDirection: "column",
					borderRight: "1px solid var(--border-color, #333)",
					background: "rgba(255, 152, 0, 0.06)",
				}}>
					<div style={{
						padding: "10px 12px",
						borderBottom: "2px solid #FF9800",
						display: "flex",
						alignItems: "center",
						gap: 6,
						fontSize: 12,
						fontWeight: 600,
						color: "#FF9800",
					}}>
						<span>{"\u{23F3}"}</span>
						<span>Plan Review</span>
						<span style={{
							background: "#FF980033",
							color: "#FF9800",
							padding: "1px 6px",
							borderRadius: 10,
							fontSize: 10,
						}}>
							{pendingPlans.length}
						</span>
					</div>
					<div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
						{pendingPlans.map((plan) => {
							const flowTitle = (() => {
								try {
									return (JSON.parse(plan.flow)?.title ?? plan.id) as string;
								} catch {
									return plan.id;
								}
							})();
							const isConfirming = planActionInFlight === plan.id;
							return (
								<div key={plan.id} style={{
									background: "var(--bg-secondary, #1c1c1e)",
									border: "1px solid var(--border-color, #333)",
									borderRadius: 6,
									padding: 10,
									marginBottom: 8,
									fontSize: 11,
								}}>
									<div style={{ color: "var(--text-primary, #e0e0e0)", fontWeight: 600, marginBottom: 4 }}>
										{flowTitle}
									</div>
									<div style={{ color: "var(--text-secondary, #888)", marginBottom: 6, fontSize: 10 }}>
										req {plan.requirementId}
									</div>
									<div style={{ display: "flex", gap: 6 }}>
										<button
											type="button"
											onClick={() => handleConfirmPlan(plan.id)}
											disabled={isConfirming || rejectingPlanId === plan.id}
											style={{
												flex: 1, padding: "4px 8px",
												background: "#4CAF50", border: "none", borderRadius: 4,
												color: "#fff", fontSize: 11, cursor: "pointer",
											}}
										>
											{isConfirming ? "..." : "Confirm"}
										</button>
										<button
											type="button"
											onClick={() => {
												setRejectingPlanId(rejectingPlanId === plan.id ? null : plan.id);
												setRejectReason("");
											}}
											disabled={isConfirming}
											style={{
												flex: 1, padding: "4px 8px",
												background: "transparent",
												border: "1px solid #f44336", borderRadius: 4,
												color: "#f44336", fontSize: 11, cursor: "pointer",
											}}
										>
											Reject
										</button>
									</div>
									{rejectingPlanId === plan.id && (
										<div style={{ marginTop: 6 }}>
											<textarea
												value={rejectReason}
												onChange={(e) => setRejectReason(e.target.value)}
												placeholder="Reason (optional)"
												style={{
													width: "100%", minHeight: 40, fontSize: 11,
													background: "var(--bg-primary, #1a1a1c)",
													border: "1px solid var(--border-color, #333)",
													borderRadius: 4, color: "var(--text-primary, #e0e0e0)",
													padding: 4, boxSizing: "border-box",
												}}
											/>
											<div style={{ display: "flex", gap: 6, marginTop: 4 }}>
												<button
													type="button"
													onClick={() => handleRejectPlan(plan.id, rejectReason)}
													disabled={isConfirming}
													style={{
														flex: 1, padding: "3px 8px",
														background: "#f44336", border: "none", borderRadius: 4,
														color: "#fff", fontSize: 11, cursor: "pointer",
													}}
												>
													Send
												</button>
												<button
													type="button"
													onClick={() => { setRejectingPlanId(null); setRejectReason(""); }}
													style={{
														flex: 1, padding: "3px 8px",
														background: "transparent",
														border: "1px solid var(--border-color, #333)", borderRadius: 4,
														color: "var(--text-secondary, #888)", fontSize: 11, cursor: "pointer",
													}}
												>
													Cancel
												</button>
											</div>
										</div>
									)}
								</div>
							);
						})}
					</div>
				</div>
			)}
				{KANBAN_COLUMNS.map((col) => {
					const cards = grouped[col.status] || [];
					return (
						<div
							key={col.status}
							style={{
								flex: "1 1 200px",
								minWidth: 180,
								maxWidth: 300,
								display: "flex",
								flexDirection: "column",
								borderRight: "1px solid var(--border-color, #333)",
							}}
						>
							{/* Column header */}
							<div style={{
								padding: "10px 12px",
								borderBottom: `2px solid ${col.color}`,
								display: "flex",
								alignItems: "center",
								gap: 6,
								fontSize: 12,
								fontWeight: 600,
								color: "var(--text-secondary, #888)",
							}}>
								<span>{col.icon}</span>
								<span>{col.label}</span>
								<span style={{
									background: col.color + "33",
									color: col.color,
									padding: "1px 6px",
									borderRadius: 10,
									fontSize: 10,
								}}>
									{cards.length}
								</span>
							</div>

							{/* Cards */}
							<div style={{
								flex: 1,
								overflowY: "auto",
								padding: 8,
							}}>
								{cards.map((req) => {
									const steps = stepsByReq[req.id] || [];
									const currentStep = steps.find((s) => s.status === "running");
									const isExpanded = expandedReqId === req.id;
									return (
										<React.Fragment key={req.id}>
											<RequirementCard
												requirement={req}
												currentStep={currentStep}
												projectName={projects.find((p) => p.id === req.projectId)?.name}
												onClick={handleCardClick}
												onDiscuss={handleDiscuss}
												onCoverage={handleCoverage}
											/>
											{isExpanded && (
												<ExecutionDetailPanel
													requirement={req}
													steps={steps}
													messages={messagesByReq[req.id] || []}
													onRefresh={() => { fetchSteps(req.id); fetchMessages(req.id); }}
												/>
											)}
										</React.Fragment>
									);
								})}
								{cards.length === 0 && (
									<div style={{
										fontSize: 11,
										color: "var(--text-tertiary, #555)",
										textAlign: "center",
										padding: 20,
									}}>
										No items yet. Create a requirement or trigger analysis.
									</div>
								)}
							</div>
						</div>
					);
				})}
			</div>

			{/* Create modal */}
			{showCreateModal && (
				<CreateRequirementModal onClose={() => setShowCreateModal(false)} />
			)}

			{/* v0.8 (M4): PM coverage-judgement modal (decision 34) */}
			<CoverageJudgementModal
				requirementId={coverageReqId}
				onClose={() => setCoverageReqId(null)}
			/>
		</div>
	);
}
