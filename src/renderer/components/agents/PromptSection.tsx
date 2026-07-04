// Agent 提示词编辑区段
//
// # 文件说明书
//
// ## 核心功能
// 在 Agent 编辑器中管理系统提示词（system prompt）的编辑和预览
//
// ## 输入
// FormState 中的 systemPrompt 字段、ref 引用
//
// ## 输出
// 提示词编辑器 + Markdown 预览 JSX
//
// ## 定位
// src/renderer/components/agents/ — Agent 编辑器的子区段
//
// ## 依赖
// React、common/MarkdownRenderer.tsx、agent-editor-types.ts
//
// ## 维护规则
// 提示词模板变量变更需同步更新预览
//
import type { MutableRefObject } from "react";
import MarkdownRenderer from "../common/MarkdownRenderer.js";
import type { FormState } from "./agent-editor-types.js";

interface Props {
	form: FormState;
	editingPrompt: boolean;
	draftPrompt: string;
	setDraftPrompt: (v: string) => void;
	savedPromptRef: MutableRefObject<string>;
	startEditPrompt: () => void;
	savePrompt: () => void;
	saving: boolean;
	promptTokenEstimate: string;
	updateContextConfig: (patch: Partial<NonNullable<FormState["contextConfig"]>>) => void;
}

export function PromptSection({
	form,
	editingPrompt,
	draftPrompt,
	setDraftPrompt,
	savedPromptRef,
	startEditPrompt,
	savePrompt,
	saving,
	promptTokenEstimate,
	updateContextConfig,
}: Props) {
	return (
		<div className="editor-section">
			<div className="prompt-header">
				<h4 className="section-title">System Prompt <span className="token-badge">{promptTokenEstimate} tokens</span></h4>
				<div className="prompt-header-actions">
					{!editingPrompt ? (
						<>
							<button type="button" className="btn-primary btn-sm" onClick={startEditPrompt}>Edit</button>
						</>
					) : (
						<>
							<button type="button" className="btn-ghost btn-sm" onClick={() => setDraftPrompt(savedPromptRef.current)}>Reset</button>
							<button type="button" className="btn-primary btn-sm" onClick={savePrompt} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
						</>
					)}
				</div>
			</div>

			{!editingPrompt ? (
				<div className="prompt-rendered">
					{form.systemPrompt ? (
						<MarkdownRenderer content={form.systemPrompt} />
					) : (
						<p className="prompt-empty">No system prompt configured. Click Edit to add one.</p>
					)}
				</div>
			) : (
				<>
					<textarea
						className="system-prompt-editor"
						value={draftPrompt}
						onChange={(e) => setDraftPrompt(e.target.value)}
						placeholder="Write your system prompt here..."
						aria-label="System Prompt"
					/>
				</>
			)}

			<div className="editor-subsection">
				<h5>Context Sections</h5>
				<p className="section-desc">Toggle which context sections are included in the per-turn context block.</p>
				<label className="checkbox-label">
					<input type="checkbox" checked={form.contextConfig?.useDeviceContext !== false}
						onChange={(e) => updateContextConfig({ useDeviceContext: e.target.checked })} />
					Device Context
				</label>
			</div>
		</div>
	);
}
