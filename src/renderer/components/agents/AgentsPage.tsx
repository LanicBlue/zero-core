// Agent 管理页面
//
// # 文件说明书
//
// ## 核心功能
// Agent 列表和管理页面，支持创建、编辑和删除 Agent。
//
// ## 输入
// - Agent 状态
// - 模板状态
//
// ## 输出
// - Agent 列表
// - Agent 编辑器
//
// ## 定位
// 渲染进程页面，被 AppLayout 使用。
//
// ## 依赖
// - react - React 框架
// - ../../store - 状态管理
//
// ## 维护规则
// - 新增 Agent 字段时需更新
// - 保持表单验证正确
//
import React, { useState, Component, type ErrorInfo, type ReactNode } from "react";
import { useAgentStore } from "../../store/agent-store.js";
import { useNotificationStore } from "../../store/notification-store.js";
import type { AgentRecord, PromptTemplate } from "../../../shared/types.js";
import AgentEditor from "./AgentEditor.js";
import TemplateGallery from "./TemplateGallery.js";

type Tab = "agents" | "templates";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
	state = { error: null as string | null };
	static getDerivedStateFromError(err: Error) {
		return { error: `${err.message}\n\n${err.stack}` };
	}
	componentDidCatch(err: Error, info: ErrorInfo) {
		console.error("[AgentsPage ErrorBoundary]", err, info);
	}
	render() {
		if (this.state.error) {
			return (
				<div style={{ padding: 20, color: "#f66", whiteSpace: "pre-wrap", fontSize: 12 }}>
					<h3>Agent Editor Error</h3>
					<p>{this.state.error}</p>
					<button type="button" onClick={() => this.setState({ error: null })} style={{ marginTop: 10, padding: "4px 12px" }}>
						Retry
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}

export default function AgentsPage() {
	const { agents, loading, remove } = useAgentStore();
	const addError = useNotificationStore((s) => s.addError);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [tab, setTab] = useState<Tab>("agents");
	const [prefillTemplate, setPrefillTemplate] = useState<PromptTemplate | null>(null);

	const selected = selectedId ? agents.find((a) => a.id === selectedId) : null;

	const handleDelete = async (id: string) => {
		try {
			await remove(id);
			if (selectedId === id) setSelectedId(null);
		} catch (err: any) {
			addError(err?.message || "Failed to delete agent");
		}
	};

	const handleSaved = (agent: AgentRecord) => {
		setCreating(false);
		setPrefillTemplate(null);
		setSelectedId(agent.id);
		setTab("agents");
	};

	const handleUseTemplate = (template: PromptTemplate) => {
		setPrefillTemplate(template);
		setCreating(true);
		setSelectedId(null);
		setTab("agents");
	};

	return (
		<ErrorBoundary>
			<div className="agents-page">
				<div className="agents-header">
					<div className="agents-tabs">
						<button
							type="button"
							className={`agents-tab ${tab === "agents" ? "active" : ""}`}
							onClick={() => setTab("agents")}
						>
							My Agents
						</button>
						<button
							type="button"
							className={`agents-tab ${tab === "templates" ? "active" : ""}`}
							onClick={() => setTab("templates")}
						>
							Templates
						</button>
					</div>
					{tab === "agents" && (
						<button
							type="button"
							className="btn-primary"
							onClick={() => { setCreating(true); setSelectedId(null); setPrefillTemplate(null); }}
						>
							+ New
						</button>
					)}
				</div>

				{tab === "templates" ? (
					<TemplateGallery onUseTemplate={handleUseTemplate} />
				) : (
					<div className="agents-content">
						<div className="agents-list">
							{loading && <p className="agents-empty">Loading...</p>}
							{!loading && agents.length === 0 && (
								<p className="agents-empty">No agents yet. Create one or use a template to get started.</p>
							)}
							{agents.map((a) => (
								<div
									key={a.id}
									className={`agents-list-item ${selectedId === a.id ? "active" : ""}`}
									onClick={() => { setSelectedId(a.id); setCreating(false); }}
								>
									<div className="agent-list-name">{a.name}</div>
									{a.systemPrompt && <div className="agent-list-role">{a.systemPrompt.split("\n")[0]}</div>}
									{a.model && <div className="agent-list-model">{a.provider}/{a.model}</div>}
								</div>
							))}
						</div>

						<div className="agents-editor-area">
							{creating && (
								<AgentEditor
									agent={null}
									onSaved={handleSaved}
									onCancel={() => { setCreating(false); setPrefillTemplate(null); }}
									prefillTemplate={prefillTemplate ?? undefined}
								/>
							)}
							{!creating && selected && (
								<AgentEditor
									agent={selected}
									onSaved={() => {}}
									onCancel={() => setSelectedId(null)}
									onDelete={() => handleDelete(selected.id)}
								/>
							)}
							{!creating && !selected && (
								<div className="agents-empty-state">
									<p>Select an agent from the list or create a new one.</p>
								</div>
							)}
						</div>
					</div>
				)}
			</div>
		</ErrorBoundary>
	);
}
