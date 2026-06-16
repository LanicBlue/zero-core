// Agent 工具选择区段
//
// # 文件说明书
//
// ## 核心功能
// 在 Agent 编辑器中管理可用工具的启用/禁用配置
//
// ## 输入
// FormState 中的 enabledTools、模型信息
//
// ## 输出
// 工具开关列表 JSX
//
// ## 定位
// src/renderer/components/agents/ — Agent 编辑器的子区段
//
// ## 依赖
// React、store/agent-store.ts、agent-editor-types.ts
//
// ## 维护规则
// 新增内置工具需在此添加开关选项
//
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

/**
 * v0.8 (M0): resolve the policy key for a tool. Agent-tools are keyed by
 * `AgentToolEntry.id` (stable across renames); built-in tools stay keyed
 * by name. Returns the key to look up in `toolsMap`, or the name if the
 * agent-tool has no id (legacy / external).
 */
function policyKeyFor(t: ModelInfo): string {
	return (t as any).agentToolId ?? t.name;
}

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
							// v0.8 (M0): agent-tools resolve by stable id (decision 2),
							// UI still displays t.name.
							const key = policyKeyFor(t);
							const enabled = toolsMap
								? (key in toolsMap
									? toolsMap[key].enabled
									: (t.name in toolsMap ? toolsMap[t.name].enabled : DEFAULT_ENABLED_TOOLS.has(t.name)))
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
											onClick={() => toggleTool(key)}
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
