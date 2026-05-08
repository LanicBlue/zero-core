import React, { useState } from "react";
import { useAgentStore, type AgentRecord } from "../../store/agent-store.js";
import AgentEditor from "./AgentEditor.js";

export default function AgentsPage() {
	const { agents, loading, remove } = useAgentStore();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	const selected = selectedId ? agents.find((a) => a.id === selectedId) : null;

	const handleDelete = async (id: string) => {
		await remove(id);
		if (selectedId === id) setSelectedId(null);
	};

	const handleSaved = (agent: AgentRecord) => {
		setCreating(false);
		setSelectedId(agent.id);
	};

	return (
		<div className="agents-page">
			<div className="agents-header">
				<h2>Agents</h2>
				<button
					type="button"
					className="btn-primary"
					onClick={() => { setCreating(true); setSelectedId(null); }}
				>
					+ New
				</button>
			</div>

			<div className="agents-content">
				<div className="agents-list">
					{loading && <p className="agents-empty">Loading...</p>}
					{!loading && agents.length === 0 && (
						<p className="agents-empty">No agents yet. Create one to get started.</p>
					)}
					{agents.map((a) => (
						<div
							key={a.id}
							className={`agents-list-item ${selectedId === a.id ? "active" : ""}`}
							onClick={() => { setSelectedId(a.id); setCreating(false); }}
						>
							<div className="agent-list-name">{a.name}</div>
							<div className="agent-list-role">{a.role}</div>
							{a.model && <div className="agent-list-model">{a.provider}/{a.model}</div>}
						</div>
					))}
				</div>

				<div className="agents-editor-area">
					{creating && (
						<AgentEditor
							agent={null}
							onSaved={handleSaved}
							onCancel={() => setCreating(false)}
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
		</div>
	);
}
