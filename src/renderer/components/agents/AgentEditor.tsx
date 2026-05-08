import React, { useState, useEffect } from "react";
import { useAgentStore, type AgentRecord, type ModelInfo } from "../../store/agent-store.js";

interface Props {
	agent: AgentRecord | null;
	onSaved: (agent: AgentRecord) => void;
	onCancel: () => void;
	onDelete?: () => void;
}

type FormState = Omit<AgentRecord, "id" | "createdAt" | "updatedAt">;

const EMPTY: FormState = {
	name: "",
	role: "",
	traits: [],
	expertise: [],
	communicationStyle: "professional",
};

const shorten = (p: string) =>
	p.replace(/^[A-Z]:\\Users\\[^\\]+/, "~").replace(/\\/g, "/");

export default function AgentEditor({ agent, onSaved, onCancel, onDelete }: Props) {
	const { create, update, models } = useAgentStore();
	const [globalWorkspace, setGlobalWorkspace] = useState("");

	useEffect(() => {
		fetch("/api/config").then((r) => r.json()).then((c) => setGlobalWorkspace(c.workspaceDir)).catch(() => {});
	}, []);

	const defaultWorkspace = globalWorkspace ? shorten(globalWorkspace) : "~/.zero-core/workspace";

	const defaultForm = (): FormState => ({
		...EMPTY,
		workspaceDir: defaultWorkspace,
	});

	const agentToForm = (a: AgentRecord): FormState => ({
		name: a.name,
		role: a.role,
		traits: a.traits,
		expertise: a.expertise,
		communicationStyle: a.communicationStyle,
		customInstructions: a.customInstructions,
		workspaceDir: a.workspaceDir ? shorten(a.workspaceDir) : defaultWorkspace,
		model: a.model,
		provider: a.provider,
		thinkingLevel: a.thinkingLevel,
		contextConfig: a.contextConfig,
	});

	const [form, setForm] = useState<FormState>(
		agent ? agentToForm(agent) : defaultForm(),
	);
	const [traitsText, setTraitsText] = useState((agent?.traits ?? []).join(", "));

	// Reset form when agent prop changes
	useEffect(() => {
		if (agent) {
			setForm(agentToForm(agent));
			setTraitsText((agent.traits ?? []).join(", "));
			setExpertiseText((agent.expertise ?? []).join(", "));
		} else {
			setForm(defaultForm());
			setTraitsText("");
			setExpertiseText("");
		}
	}, [agent, globalWorkspace]);
	const [expertiseText, setExpertiseText] = useState((agent?.expertise ?? []).join(", "));
	const [saving, setSaving] = useState(false);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaving(true);
		const data = {
			...form,
			traits: traitsText.split(",").map((s) => s.trim()).filter(Boolean),
			expertise: expertiseText.split(",").map((s) => s.trim()).filter(Boolean),
		};

		try {
			if (agent) {
				const updated = await update(agent.id, data);
				onSaved(updated);
			} else {
				const created = await create(data as Omit<AgentRecord, "id" | "createdAt" | "updatedAt">);
				onSaved(created);
			}
		} finally {
			setSaving(false);
		}
	};

	// Group models by provider for the dropdown
	const modelsByProvider = models.reduce<Record<string, ModelInfo[]>>((acc, m) => {
		(acc[m.provider] ??= []).push(m);
		return acc;
	}, {});

	return (
		<form className="agent-editor" onSubmit={submit}>
			<h3>{agent ? `Edit: ${agent.name}` : "New Agent"}</h3>

			<div className="editor-grid">
				<div className="editor-section">
					<h4>Persona</h4>

					<label>
						Name
						<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
					</label>

					<label>
						Role
						<input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="e.g. Expert coding assistant" required />
					</label>

					<label>
						Traits (comma-separated)
						<input value={traitsText} onChange={(e) => setTraitsText(e.target.value)} placeholder="e.g. concise, thorough, pragmatic" />
					</label>

					<label>
						Expertise (comma-separated)
						<input value={expertiseText} onChange={(e) => setExpertiseText(e.target.value)} placeholder="e.g. TypeScript, system-design" />
					</label>

					<label>
						Communication Style
						<select value={form.communicationStyle} onChange={(e) => setForm({ ...form, communicationStyle: e.target.value })}>
							<option value="professional">Professional</option>
							<option value="casual">Casual</option>
							<option value="technical">Technical</option>
							<option value="friendly">Friendly</option>
						</select>
					</label>

					<label>
						Custom Instructions
						<textarea value={form.customInstructions ?? ""} onChange={(e) => setForm({ ...form, customInstructions: e.target.value })} rows={3} placeholder="Additional behavior instructions..." />
					</label>
				</div>

				<div className="editor-section">
					<h4>Runtime</h4>

					<label>
						Model
						<select
							value={form.model ? `${form.provider}|${form.model}` : ""}
							onChange={(e) => {
								if (!e.target.value) {
									setForm({ ...form, model: undefined, provider: undefined });
								} else {
									const [provider, model] = e.target.value.split("|");
									setForm({ ...form, provider, model });
								}
							}}
						>
							<option value="">Default</option>
							{Object.entries(modelsByProvider).map(([provider, pmodels]) => (
								<optgroup key={provider} label={provider}>
									{pmodels.map((m) => (
										<option key={`${m.provider}|${m.id}`} value={`${m.provider}|${m.id}`}>
											{m.name}
										</option>
									))}
								</optgroup>
							))}
						</select>
					</label>

					<label>
						Thinking Level
						<select
							value={form.thinkingLevel ?? ""}
							onChange={(e) => setForm({ ...form, thinkingLevel: e.target.value || undefined })}
						>
							<option value="">Default</option>
							<option value="low">Low</option>
							<option value="medium">Medium</option>
							<option value="high">High</option>
						</select>
					</label>

					<label>
						Workspace Directory
						<input
							value={form.workspaceDir ?? ""}
							onChange={(e) => setForm({ ...form, workspaceDir: e.target.value || undefined })}
							placeholder={defaultWorkspace}
						/>
					</label>
				</div>

				<div className="editor-section">
					<h4>Context</h4>

					<label className="checkbox-label">
						<input
							type="checkbox"
							checked={form.contextConfig?.injectProjectContext !== false}
							onChange={(e) => setForm({
								...form,
								contextConfig: {
									...form.contextConfig,
									injectProjectContext: e.target.checked,
								},
							})}
						/>
						Inject project context
					</label>

					<label>
						Max directory depth
						<input
							type="number"
							min={1}
							max={10}
							value={form.contextConfig?.maxDirectoryDepth ?? 3}
							onChange={(e) => setForm({
								...form,
								contextConfig: {
									...form.contextConfig,
									maxDirectoryDepth: parseInt(e.target.value) || 3,
								},
							})}
						/>
					</label>

					<label>
						Exclude patterns (comma-separated)
						<input
							value={(form.contextConfig?.excludePatterns ?? ["node_modules", ".git", "dist", "build"]).join(", ")}
							onChange={(e) => setForm({
								...form,
								contextConfig: {
									...form.contextConfig,
									excludePatterns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
								},
							})}
						/>
					</label>
				</div>
			</div>

			<div className="editor-actions">
				<button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
				<button type="submit" className="btn-primary" disabled={saving}>
					{saving ? "Saving..." : agent ? "Save" : "Create"}
				</button>
				{agent && onDelete && (
					<button type="button" className="btn-danger" onClick={onDelete}>Delete</button>
				)}
			</div>
		</form>
	);
}
