// Subagents 配置段 (v0.8 P8 §11.10 / §11.5)
//
// # 文件说明书
//
// ## 核心功能
// 编辑 AgentRecord.subagents:此 agent 可委派给哪些其他 agent。每条 = 目标
// agentId(必填) + 可选 name/description 显示覆盖。目标 agent 的 canonical
// name 在 target 的 AgentRecord 上;这里允许显示覆盖(便于在 caller 上下文
// 里给委派入口一个更贴切的名字)。
//
// §11.5:委派走 subagents,不走 expose-as-tool。本段是「可委派清单」的编辑
// 入口;真实 delegateTask(targetAgentId) 在运行时由 agent-loop 派生。
//
// ## 输入
// - form(持有 subagents)
// - agents(所有 agent,供下拉选 target agentId + 显示 canonical name)
// - onChange:新 subagents 数组回写 form
//
// ## 输出
// - 渲染的 subagents 编辑面板
//
// ## 定位
// 渲染进程组件,被 AgentEditor 使用。
//
// ## 依赖
// - react
// - ../../../shared/types (AgentRecord)
//
// ## 维护规则
// - subagents 结构变更同步此组件 + agent-editor-types
// - 显示覆盖语义变更同步 §11.5
//
import React, { useState } from "react";
import type { AgentRecord } from "../../../shared/types.js";

interface Props {
	form: FormStateLike;
	agents: AgentRecord[];
	onChange: (next: AgentRecord["subagents"]) => void;
}

interface FormStateLike {
	subagents?: AgentRecord["subagents"];
}

type SubagentEntry = NonNullable<AgentRecord["subagents"]>[number];

export function SubagentsSection({ form, agents, onChange }: Props) {
	const list: SubagentEntry[] = form.subagents ?? [];
	const [newAgentId, setNewAgentId] = useState("");
	const [newName, setNewName] = useState("");
	const [newDescription, setNewDescription] = useState("");

	// Agents available as delegation targets (exclude self by id when editing
	// an existing agent — self-delegation is a cycle). The caller (AgentEditor)
	// knows the current agent id; we just render the dropdown and let the user
	// pick. Duplicate target detection happens on add.
	const targetOptions = agents;

	const handleAdd = () => {
		const id = newAgentId.trim();
		if (!id) return;
		if (list.some((s) => s.agentId === id)) return; // dedupe
		const entry: SubagentEntry = {
			agentId: id,
			...(newName.trim() ? { name: newName.trim() } : {}),
			...(newDescription.trim() ? { description: newDescription.trim() } : {}),
		};
		onChange([...list, entry]);
		setNewAgentId("");
		setNewName("");
		setNewDescription("");
	};

	const handleRemove = (agentId: string) => {
		onChange(list.filter((s) => s.agentId !== agentId));
	};

	const handleUpdate = (agentId: string, patch: Partial<SubagentEntry>) => {
		onChange(list.map((s) => (s.agentId === agentId ? { ...s, ...patch } : s)));
	};

	const nameFor = (id: string): string => {
		const a = agents.find((x) => x.id === id);
		return a?.name ?? id;
	};

	return (
		<div className="editor-section">
			<div className="section-header">
				<h4>Subagents (delegation)</h4>
				<p className="section-hint">
					Agents this agent may delegate to via <code>delegateTask</code>. Target agent&apos;s
					canonical name lives on its record; name/description here are optional display
					overrides for the delegation entry.
				</p>
			</div>

			{/* Existing entries */}
			{list.length === 0 ? (
				<p className="empty-hint">No subagents configured. This agent cannot delegate.</p>
			) : (
				<table className="subagents-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
					<thead>
						<tr>
							<th style={thStyle}>Target</th>
							<th style={thStyle}>Display name (override)</th>
							<th style={thStyle}>Description (override)</th>
							<th style={thStyle}></th>
						</tr>
					</thead>
					<tbody>
						{list.map((s) => (
							<tr key={s.agentId}>
								<td style={tdStyle}>
									<code>{s.agentId}</code>
									<div style={{ fontSize: 10, color: "var(--text-tertiary, #555)" }}>
										{nameFor(s.agentId)}
									</div>
								</td>
								<td style={tdStyle}>
									<input
										type="text"
										value={s.name ?? ""}
										onChange={(e) => handleUpdate(s.agentId, { name: e.target.value || undefined })}
										placeholder={nameFor(s.agentId)}
										aria-label={`Display name for ${s.agentId}`}
										style={inputStyle}
									/>
								</td>
								<td style={tdStyle}>
									<input
										type="text"
										value={s.description ?? ""}
										onChange={(e) => handleUpdate(s.agentId, { description: e.target.value || undefined })}
										placeholder="What this delegate is for"
										aria-label={`Description for ${s.agentId}`}
										style={inputStyle}
									/>
								</td>
								<td style={tdStyle}>
									<button type="button" className="btn-ghost btn-xs" onClick={() => handleRemove(s.agentId)}>
										Remove
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}

			{/* Add new */}
			<div className="subagents-add" style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
				<div>
					<label style={labelStyle}>Target agent</label>
					<select
						value={newAgentId}
						onChange={(e) => setNewAgentId(e.target.value)}
						aria-label="Target agent for new subagent"
						style={inputStyle}
					>
						<option value="">-- pick agent --</option>
						{targetOptions.map((a) => (
							<option key={a.id} value={a.id}>{a.name}</option>
						))}
					</select>
				</div>
				<div>
					<label style={labelStyle}>Name (optional)</label>
					<input
						type="text"
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
						placeholder="display override"
						aria-label="New subagent display name"
						style={inputStyle}
					/>
				</div>
				<div style={{ flex: 1, minWidth: 200 }}>
					<label style={labelStyle}>Description (optional)</label>
					<input
						type="text"
						value={newDescription}
						onChange={(e) => setNewDescription(e.target.value)}
						placeholder="what this delegate is for"
						aria-label="New subagent description"
						style={inputStyle}
					/>
				</div>
				<button
					type="button"
					className="btn-primary btn-sm"
					onClick={handleAdd}
					disabled={!newAgentId.trim()}
				>
					Add
				</button>
			</div>
		</div>
	);
}

const thStyle: React.CSSProperties = {
	textAlign: "left",
	padding: "6px 8px",
	borderBottom: "1px solid var(--border-color, #333)",
	fontWeight: 600,
	color: "var(--text-secondary, #888)",
	fontSize: 11,
};

const tdStyle: React.CSSProperties = {
	padding: "6px 8px",
	borderBottom: "1px solid var(--border-color, #333)",
	verticalAlign: "top",
};

const inputStyle: React.CSSProperties = {
	width: "100%",
	padding: "4px 6px",
	background: "var(--bg-secondary, #1c1c1e)",
	border: "1px solid var(--border-color, #333)",
	borderRadius: 4,
	color: "var(--text-primary, #e0e0e0)",
	fontSize: 12,
	boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
	display: "block",
	fontSize: 11,
	color: "var(--text-secondary, #888)",
	marginBottom: 4,
};
