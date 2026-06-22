// 新建需求弹窗
//
// # 文件说明书
//
// ## 核心功能
// 创建新需求的模态弹窗，包含标题、描述、优先级和项目选择。
//
// ## 输入
// - 项目列表
// - onClose 回调
//
// ## 输出
// - 渲染的弹窗
//
// ## 定位
// 渲染进程组件，被 KanbanPage 使用。
//
// ## 依赖
// - react
// - ../../store/requirement-store
// - ../../store/project-store
//
// ## 维护规则
// - 需求表单字段或校验规则变更时同步本组件与 requirement-store 写入
// - RequirementPriority 类型变更需同步表单选项
//
import React, { useState } from "react";
import type { RequirementPriority } from "../../../shared/types.js";
import { useRequirementStore } from "../../store/requirement-store.js";
import { useProjectStore } from "../../store/project-store.js";

interface CreateRequirementModalProps {
	onClose: () => void;
}

export default function CreateRequirementModal({ onClose }: CreateRequirementModalProps) {
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [priority, setPriority] = useState<RequirementPriority>("normal");
	const [projectId, setProjectId] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const { projects } = useProjectStore();
	const createRequirement = useRequirementStore((s) => s.createRequirement);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!title.trim() || !projectId) return;

		setSubmitting(true);
		setError(null);
		try {
			await createRequirement({
				title: title.trim(),
				description: description.trim() || undefined,
				priority,
				projectId,
				status: "found",
				source: "user",
				reviewer: "analyst",
			});
			onClose();
		} catch (err: any) {
			setError(err.message || "Failed to create requirement");
		} finally {
			setSubmitting(false);
		}
	};

	const overlayStyle: React.CSSProperties = {
		position: "fixed",
		inset: 0,
		background: "rgba(0,0,0,0.6)",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		zIndex: 1000,
	};

	const modalStyle: React.CSSProperties = {
		background: "var(--bg-primary, #1a1a1c)",
		border: "1px solid var(--border-color, #333)",
		borderRadius: 8,
		padding: 24,
		width: 460,
		maxWidth: "90vw",
	};

	const labelStyle: React.CSSProperties = {
		display: "block",
		fontSize: 12,
		color: "var(--text-secondary, #888)",
		marginBottom: 4,
	};

	const inputStyle: React.CSSProperties = {
		width: "100%",
		padding: "8px 10px",
		background: "var(--bg-secondary, #1c1c1e)",
		border: "1px solid var(--border-color, #333)",
		borderRadius: 4,
		color: "var(--text-primary, #e0e0e0)",
		fontSize: 13,
		boxSizing: "border-box",
	};

	return (
		<div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
			<div style={modalStyle}>
				<h3 style={{ margin: "0 0 16px", fontSize: 16, color: "var(--text-primary, #e0e0e0)" }}>
					New Requirement
				</h3>
				<form onSubmit={handleSubmit}>
					<div style={{ marginBottom: 12 }}>
						<label style={labelStyle}>Title *</label>
						<input
							style={inputStyle}
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="Requirement title"
							required
						/>
					</div>
					<div style={{ marginBottom: 12 }}>
						<label style={labelStyle}>Description</label>
						<textarea
							style={{ ...inputStyle, minHeight: 80, resize: "vertical" }}
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Detailed description..."
						/>
					</div>
					<div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
						<div style={{ flex: 1 }}>
							<label style={labelStyle}>Priority</label>
							<select
								style={inputStyle}
								value={priority}
								onChange={(e) => setPriority(e.target.value as RequirementPriority)}
							>
								<option value="low">Low</option>
								<option value="normal">Normal</option>
								<option value="high">High</option>
								<option value="critical">Critical</option>
							</select>
						</div>
						<div style={{ flex: 1 }}>
							<label style={labelStyle}>Project *</label>
							<select
								style={inputStyle}
								value={projectId}
								onChange={(e) => setProjectId(e.target.value)}
								required
							>
								<option value="">-- Select Project --</option>
								{projects.map((p) => (
									<option key={p.id} value={p.id}>{p.name}</option>
								))}
							</select>
						</div>
					</div>
					{error && (
						<div style={{ color: "#F44336", fontSize: 12, marginBottom: 8 }}>{error}</div>
					)}
					<div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
						<button
							type="button"
							onClick={onClose}
							style={{
								padding: "6px 16px",
								background: "transparent",
								border: "1px solid var(--border-color, #333)",
								borderRadius: 4,
								color: "var(--text-secondary, #888)",
								cursor: "pointer",
							}}
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={submitting || !title.trim() || !projectId}
							style={{
								padding: "6px 16px",
								background: "#2196F3",
								border: "none",
								borderRadius: 4,
								color: "#fff",
								cursor: submitting ? "not-allowed" : "pointer",
								opacity: submitting ? 0.6 : 1,
							}}
						>
							{submitting ? "Creating..." : "Create"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
