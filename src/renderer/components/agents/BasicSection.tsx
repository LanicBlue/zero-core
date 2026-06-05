// Agent 基本信息编辑区段
//
// # 文件说明书
//
// ## 核心功能
// 在 Agent 编辑器中管理基本信息（名称、描述、模型选择等）
//
// ## 输入
// FormState、模型列表、preload API
//
// ## 输出
// 基本信息编辑表单 JSX
//
// ## 定位
// src/renderer/components/agents/ — Agent 编辑器的子区段
//
// ## 依赖
// agent-editor-types.ts、preload API
//
// ## 维护规则
// 模型列表获取逻辑变更需确保加载状态正确
//
import type { FormState } from "./agent-editor-types.js";

const api = () => (window as any).api;

interface ModelOption {
	id: string;
	name: string;
	provider?: string;
}

interface Props {
	form: FormState;
	onSet: <K extends keyof FormState>(key: K, val: FormState[K]) => void;
	onSetForm: (next: FormState) => void;
	onAutoSave: (data: FormState) => void;
	defaultWorkspaceDisplay: string;
	allModelsByGroup: Record<string, ModelOption[]>;
}

export function BasicSection({ form, onSet, onSetForm, onAutoSave, defaultWorkspaceDisplay, allModelsByGroup }: Props) {
	return (
		<div className="editor-section">
			<label>Name
				<input value={form.name} onChange={(e) => onSet("name", e.target.value)} required />
			</label>
			<label>Workspace Directory
				<div className="workspace-dir-row">
					<input value={form.workspaceDir ?? ""} onChange={(e) => onSet("workspaceDir", e.target.value || undefined)} placeholder={defaultWorkspaceDisplay} />
					<button type="button" className="btn-ghost btn-sm" onClick={async () => { const dir = await api().dialogOpenDirectory(); if (dir) onSet("workspaceDir", dir); }}>...</button>
				</div>
			</label>
			<label>Model
				<select
					value={form.model ? `${form.provider}|${form.model}` : ""}
					onChange={(e) => {
						if (!e.target.value) {
							const next = { ...form, model: undefined, provider: undefined };
							onSetForm(next);
							onAutoSave(next);
						} else {
							const [provider, model] = e.target.value.split("|");
							const next = { ...form, provider, model };
							onSetForm(next);
							onAutoSave(next);
						}
					}}
				>
					<option value="">Default</option>
					{Object.entries(allModelsByGroup).map(([group, groupModels]) => (
						<optgroup key={group} label={group}>
							{groupModels.map((m) => (
								<option key={`${m.provider}|${m.id}`} value={`${m.provider}|${m.id}`}>
									{m.name}
								</option>
							))}
						</optgroup>
					))}
				</select>
			</label>
			<label>Thinking Level
				<select value={form.thinkingLevel ?? ""} onChange={(e) => onSet("thinkingLevel", e.target.value || undefined)}>
					<option value="">Default</option>
					<option value="low">Low</option>
					<option value="medium">Medium</option>
					<option value="high">High</option>
				</select>
			</label>
		</div>
	);
}
