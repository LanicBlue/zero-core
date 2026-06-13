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
import React, { useEffect, useState, useCallback } from "react";
import type { RequirementRecord, RequirementStatus } from "../../../shared/types.js";
import { useRequirementStore } from "../../store/requirement-store.js";
import { useProjectStore } from "../../store/project-store.js";
import { usePageStore } from "../../store/page-store.js";
import RequirementCard from "./RequirementCard.js";
import CreateRequirementModal from "./CreateRequirementModal.js";
import ExecutionDetailPanel from "./ExecutionDetailPanel.js";

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

	// Fetch data on mount
	useEffect(() => {
		fetchProjects();
		fetchRequirements();
	}, []);

	// Refresh when project filter changes
	useEffect(() => {
		if (selectedProjectId) {
			fetchRequirements({ projectId: selectedProjectId });
		}
	}, [selectedProjectId]);

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
	};

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
												onClick={handleCardClick}
											/>
											{isExpanded && (
												<ExecutionDetailPanel
													requirement={req}
													steps={steps}
													messages={messagesByReq[req.id] || []}
t											onRefresh={() => { fetchSteps(req.id); fetchMessages(req.id); }}
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
		</div>
	);
}
