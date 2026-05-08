import React, { useEffect, useState } from "react";
import { useAgentStore } from "../../store/agent-store.js";
import { useChatStore } from "../../store/chat-store.js";

export default function Sidebar() {
	const { agents, loading } = useAgentStore();
	const { activeAgentId, setActiveAgent } = useChatStore();
	const [globalWorkspace, setGlobalWorkspace] = useState("");

	useEffect(() => {
		fetch("/api/config")
			.then((r) => r.json())
			.then((c) => setGlobalWorkspace(c.workspaceDir))
			.catch(() => {});
	}, []);

	if (loading) return <aside className="sidebar"><p>Loading...</p></aside>;

	const active = agents.find((a) => a.id === activeAgentId);
	const workspaceDir = active?.workspaceDir || globalWorkspace;

	return (
		<aside className="sidebar">
			<div className="sidebar-header">
				<h1>Zero-Core</h1>
			</div>

			<div className="sidebar-section">
				<div className="section-title">
					<span>Agent</span>
				</div>
				<select
					className="persona-select"
					title="Select an agent"
					value={activeAgentId ?? ""}
					onChange={(e) => setActiveAgent(e.target.value || null)}
				>
					<option value="">-- Select --</option>
					{agents.map((a) => (
						<option key={a.id} value={a.id}>{a.name}</option>
					))}
				</select>
				{active && (
					<div className="persona-info">
						<p className="persona-role">{active.role}</p>
						<div className="persona-tags">
							{active.traits.map((t) => <span key={t} className="tag">{t}</span>)}
						</div>
						{active.model && (
							<p className="agent-model">{active.provider}/{active.model}</p>
						)}
					</div>
				)}
			</div>

			<div className="sidebar-section">
				<div className="section-title">Workspace</div>
				<p className="workspace-path" title={workspaceDir}>
					{workspaceDir
						? workspaceDir.replace(/^C:\\Users\\[^\\]+/, "~").replace(/\\/g, "/")
						: "—"}
				</p>
			</div>
		</aside>
	);
}
