import { useState } from "react";
import type { ModelInfo } from "../../store/agent-store.js";
import { DEFAULT_ENABLED_TOOLS, type FormState } from "./agent-editor-types.js";

interface Props {
	form: FormState;
	tools: ModelInfo[];
	toggleTool: (toolName: string) => void;
	toolsTokenEstimate: string;
}

const GROUP_LABELS: Record<string, string> = {
	runtime: "基本工具",
	web: "Web",
	memory: "Knowledge Graph Memory",
	thinking: "Sequential Thinking",
	assistant: "Assistant 诊断",
	interaction: "交互工具",
	agent: "Agent 工具",
	mcp: "MCP 工具",
};

export function ToolsSection({ form, tools, toggleTool, toolsTokenEstimate }: Props) {
	const [expandedTool, setExpandedTool] = useState<string | null>(null);
	const groups: Record<string, typeof tools> = {};
	for (const t of tools) {
		const g = t.group || t.source || "runtime";
		(groups[g] ??= []).push(t);
	}
	const toolsMap = form.toolPolicy?.tools;

	return (
		<div className="editor-section">
			<h4 className="section-title">可用工具 <span className="token-badge">{toolsTokenEstimate} tokens</span></h4>
			<p className="section-desc">选择该 Agent 可以使用的工具</p>
			{Object.entries(groups).map(([group, groupTools]) => (
				<div key={group} className="tool-group">
					<h5 className="tool-group-title">{GROUP_LABELS[group] || group}</h5>
					<div className="tool-list">
						{groupTools.map((t) => {
							const enabled = toolsMap
								? (t.name in toolsMap ? toolsMap[t.name].enabled : DEFAULT_ENABLED_TOOLS.has(t.name))
								: DEFAULT_ENABLED_TOOLS.has(t.name);
							return (
								<div key={t.name}>
									<div className="tool-item">
										<div className="tool-info" onClick={() => setExpandedTool(expandedTool === t.name ? null : t.name)} style={{ cursor: "pointer" }}>
											<span className="tool-name">{t.name}</span>
											<span className="tool-desc">{t.description}</span>
											{t.mcpServerName && <span className="tool-mcp-badge">{t.mcpServerName}</span>}
										</div>
										<button
											type="button"
											title={enabled ? "Disable" : "Enable"}
											className={`toggle-switch ${enabled ? "on" : ""}`}
											onClick={() => toggleTool(t.name)}
										/>
									</div>
									{expandedTool === t.name && t.description && (
										<div className="tool-detail-panel">
											<p>{t.description}</p>
										</div>
									)}
								</div>
							);
						})}
					</div>
				</div>
			))}
		</div>
	);
}
