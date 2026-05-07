import React, { useState, useEffect } from "react";
import { usePersona } from "../../store/persona-store.js";
import { useChatStore } from "../../store/chat-store.js";
import PersonaEditor from "../persona/PersonaEditor.js";

export default function Sidebar() {
	const { personas, loading, remove } = usePersona();
	const { activePersonaId, setActivePersona } = useChatStore();
	const [editing, setEditing] = useState<string | "new" | null>(null);
	const [workspaceDir, setWorkspaceDir] = useState("");
	const [editingWorkspace, setEditingWorkspace] = useState(false);
	const [tempDir, setTempDir] = useState("");

	useEffect(() => {
		fetch("/api/config")
			.then((r) => r.json())
			.then((config) => setWorkspaceDir(config.workspaceDir))
			.catch(() => {});
	}, []);

	const saveWorkspace = () => {
		if (!tempDir.trim()) return;
		fetch("/api/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceDir: tempDir }),
		})
			.then((r) => r.json())
			.then((config) => {
				setWorkspaceDir(config.workspaceDir);
				setEditingWorkspace(false);
			})
			.catch(() => {});
	};

	if (loading) return <aside className="sidebar"><p>Loading...</p></aside>;

	const active = personas.find((p) => p.id === activePersonaId);

	const shortDir = workspaceDir
		? workspaceDir.replace(/^C:\\Users\\[^\\]+/, "~").replace(/\\/g, "/")
		: "loading...";

	return (
		<aside className="sidebar">
			<div className="sidebar-header">
				<h1>Zero-Core</h1>
			</div>

			<div className="sidebar-section">
				<div className="section-title">
					<span>Persona</span>
					<button type="button" className="btn-icon" onClick={() => setEditing("new")} title="New persona">+</button>
				</div>
				<select
					className="persona-select"
					title="Select a persona"
					value={activePersonaId ?? ""}
					onChange={(e) => {
						setActivePersona(e.target.value || null);
					}}
				>
					<option value="">-- Select --</option>
					{personas.map((p) => (
						<option key={p.id} value={p.id}>{p.name}</option>
					))}
				</select>
				{active && (
					<div className="persona-info">
						<p className="persona-role">{active.role}</p>
						<div className="persona-tags">
							{active.traits.map((t) => <span key={t} className="tag">{t}</span>)}
						</div>
						<div className="persona-actions">
							<button type="button" className="btn-sm" onClick={() => setEditing(active.id)}>Edit</button>
							<button type="button" className="btn-sm btn-danger" onClick={() => { remove(active.id); setActivePersona(null); }}>Delete</button>
						</div>
					</div>
				)}
			</div>

			<div className="sidebar-section">
				<div className="section-title">
					<span>Workspace</span>
					<button type="button" className="btn-icon" onClick={() => { setTempDir(workspaceDir); setEditingWorkspace(true); }} title="Change workspace">{"⚙"}</button>
				</div>
				{editingWorkspace ? (
					<div className="workspace-edit">
						<input
							className="workspace-input"
							value={tempDir}
							onChange={(e) => setTempDir(e.target.value)}
							placeholder="Directory path..."
							onKeyDown={(e) => { if (e.key === "Enter") saveWorkspace(); if (e.key === "Escape") setEditingWorkspace(false); }}
						/>
						<div className="workspace-edit-actions">
							<button type="button" className="btn-sm" onClick={saveWorkspace}>Save</button>
							<button type="button" className="btn-sm" onClick={() => setEditingWorkspace(false)}>Cancel</button>
						</div>
					</div>
				) : (
					<p className="workspace-path" title={workspaceDir}>{shortDir}</p>
				)}
			</div>

			{editing && (
				<PersonaEditor
					personaId={editing === "new" ? null : editing}
					personas={personas}
					onClose={() => setEditing(null)}
				/>
			)}

			<div className="sidebar-section">
				<div className="section-title">Conversations</div>
				<div className="conversation-item active">Current session</div>
			</div>
		</aside>
	);
}
