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
				<p className="section-desc">Toggle which context sections are included in the system prompt.</p>
				<label className="checkbox-label">
					<input type="checkbox" checked={form.contextConfig?.useDeviceContext !== false}
						onChange={(e) => updateContextConfig({ useDeviceContext: e.target.checked })} />
					Device Context
				</label>
				<label className="checkbox-label">
					<input type="checkbox" checked={form.contextConfig?.useGuidelines !== false}
						onChange={(e) => updateContextConfig({ useGuidelines: e.target.checked })} />
					Guidelines
				</label>
				<label className="checkbox-label">
					<input type="checkbox" checked={form.contextConfig?.useMemoryContext === true}
						onChange={(e) => updateContextConfig({ useMemoryContext: e.target.checked || undefined })} />
					Memory (reserved)
				</label>
			</div>
		</div>
	);
}
