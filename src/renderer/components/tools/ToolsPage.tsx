import React, { useState, useEffect } from "react";

const api = () => (window as any).api;

const CATEGORY_LABELS: Record<string, string> = {
	runtime: "Base",
	task: "Task",
	web: "Web",
	memory: "Memory",
	thinking: "Thinking",
	assistant: "Assistant",
	interaction: "Interaction",
	mcp: "MCP",
	agent: "Agent",
};

export default function ToolsPage() {
	const [tools, setTools] = useState<any[]>([]);
	const [config, setConfig] = useState<Record<string, Record<string, any>>>({});
	const [selected, setSelected] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		(async () => {
			const [t, c] = await Promise.all([api().toolsList(), api().toolConfigGet()]);
			setTools(t ?? []);
			setConfig(c ?? {});
			setLoading(false);
		})();
	}, []);

	const grouped = tools.reduce((acc: Record<string, any[]>, t: any) => {
		const cat = t.group || t.source || "other";
		(acc[cat] ??= []).push(t);
		return acc;
	}, {} as Record<string, any[]>);

	const save = async () => {
		await api().toolConfigSave(config);
		setSaved(true);
		setTimeout(() => setSaved(false), 2000);
	};

	const updateField = (toolName: string, key: string, value: any) => {
		setConfig((prev: any) => ({
			...prev,
			[toolName]: { ...(prev[toolName] ?? {}), [key]: value },
		}));
	};

	const selectedTool = tools.find((t) => t.name === selected) ?? null;

	if (loading) {
		return (
			<div className="tools-page">
				<div className="tools-page-header">
					<h2>Tools</h2>
				</div>
				<p className="tools-page-empty">Loading tools...</p>
			</div>
		);
	}

	return (
		<div className="tools-page">
			<div className="tools-page-header">
				<h2>Tools</h2>
				<div className="tools-page-header-info">
					<span>{tools.length} tools registered</span>
				</div>
				<button type="button" className="btn-primary btn-sm" onClick={save}>
					{saved ? "Saved!" : "Save Configuration"}
				</button>
			</div>

			<div className="tools-page-body">
				{/* Left panel — tool list */}
				<div className="tools-page-list">
					{Object.entries(grouped).map(([cat, catTools]) => (
						<div key={cat} className="tools-page-category">
							<div className="tools-page-category-title">
								{CATEGORY_LABELS[cat] ?? cat}
								<span className="tools-page-category-count">{catTools.length}</span>
							</div>
							{catTools.map((t: any) => (
								<div
									key={t.name}
									className={"tools-page-list-item" + (selected === t.name ? " active" : "")}
									onClick={() => setSelected(t.name)}
								>
									<span className="tools-page-list-name">{t.name}</span>
									{t.meta?.isDestructive && (
										<span className="tools-page-destructive-dot" title="destructive" />
									)}
								</div>
							))}
						</div>
					))}
				</div>

				{/* Right panel — detail */}
				<div className="tools-page-detail">
					{selectedTool ? (
						<>
							<div className="tools-page-detail-header">
								<div className="tools-page-detail-title">
									<span className="tools-page-detail-name">{selectedTool.name}</span>
									<span className={"tools-page-source-badge " + selectedTool.source}>
										{selectedTool.source}
									</span>
									{selectedTool.mcpServerName && (
										<span className="tools-page-mcp-badge">{selectedTool.mcpServerName}</span>
									)}
									{selectedTool.meta?.isDestructive && (
										<span className="tools-page-destructive-badge">destructive</span>
									)}
								</div>
								<p className="tools-page-detail-desc">{selectedTool.description}</p>
								{selectedTool.userDescription && (
									<p className="tools-page-detail-user-desc">{selectedTool.userDescription}</p>
								)}
							</div>

							{selectedTool.configSchema?.length > 0 ? (
								<div className="tools-page-detail-config">
									<h4 className="tools-page-config-heading">Configuration</h4>
									{selectedTool.configSchema.map((field: any) => {
										const val = config[selectedTool.name]?.[field.key] ?? field.default ?? "";
								if (field.key === "auto_background_timeout" && !config[selectedTool.name]?.auto_background) return null;
										return (
											<div key={field.key} className="tools-page-config-field">
												<div className="tools-page-config-label-row">
													<label>{field.label}</label>
													{field.description && (
														<span className="tools-page-config-desc">{field.description}</span>
													)}
												</div>
												{field.type === "boolean" ? (
													<button
														type="button"
														title={val ? "Disable" : "Enable"}
														className={"toggle-switch " + (val ? "on" : "")}
														onClick={() => updateField(selectedTool.name, field.key, !val)}
													/>
												) : field.type === "select" ? (
													<select
														title={field.label}
														value={val}
														onChange={(e) => updateField(selectedTool.name, field.key, e.target.value)}
													>
														{(field.options ?? []).map((o: string) => (
															<option key={o} value={o}>{o}</option>
														))}
													</select>
												) : field.type === "number" ? (
													<input
														type="number"
														title={field.label}
														placeholder={field.label}
														value={val}
														onChange={(e) => updateField(selectedTool.name, field.key, Number(e.target.value))}
													/>
												) : (
													<input
														type={field.key.toLowerCase().includes("key") || field.key.toLowerCase().includes("api") ? "password" : "text"}
														value={val}
														onChange={(e) => updateField(selectedTool.name, field.key, e.target.value)}
														placeholder={field.description ?? ""}
													/>
												)}
											</div>
										);
									})}
								</div>
							) : (
								<p className="tools-page-no-config">No configurable parameters.</p>
							)}
						</>
					) : (
						<div className="tools-page-detail-empty">
							<p>Select a tool to view details</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
