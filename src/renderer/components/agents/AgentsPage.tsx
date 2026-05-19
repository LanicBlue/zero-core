import React, { useState } from "react";
import { useAgentStore, type AgentRecord } from "../../store/agent-store.js";
import { type PromptTemplate } from "../../store/template-store.js";
import AgentEditor from "./AgentEditor.js";
import TemplateGallery from "./TemplateGallery.js";

type Tab = "agents" | "templates";

export default function AgentsPage() {
	const { agents, loading, remove } = useAgentStore();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [tab, setTab] = useState<Tab>("agents");
	const [prefillTemplate, setPrefillTemplate] = useState<PromptTemplate | null>(null);

	const selected = selectedId ? agents.find((a) => a.id === selectedId) : null;

	const handleDelete = async (id: string) => {
		await remove(id);
		if (selectedId === id) setSelectedId(null);
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
	);
}
