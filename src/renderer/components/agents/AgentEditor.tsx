import React, { useState, useEffect, useRef } from "react";
import { useAgentStore, type AgentRecord, type ModelInfo } from "../../store/agent-store.js";
import { useAgentToolStore, type AgentToolEntry } from "../../store/agent-tool-store.js";
import { useProviderStore } from "../../store/provider-store.js";
import type { PromptTemplate } from "../../store/template-store.js";
import MarkdownRenderer from "../common/MarkdownRenderer.js";

interface Props {
	agent: AgentRecord | null;
	onSaved: (agent: AgentRecord) => void;
	onCancel: () => void;
	onDelete?: () => void;
	prefillTemplate?: PromptTemplate;
}

type Section = "basic" | "prompt" | "tools" | "expose" | "permissions";

type FormState = Omit<AgentRecord, "id" | "createdAt" | "updatedAt">;

const shorten = (p: string) =>
	p.replace(/^[A-Z]:\\Users\\[^\\]+/, "~").replace(/\\/g, "/");

const EMPTY: FormState = {
	name: "",
};

const api = () => (window as any).api;

function kebab(s: string) {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function ConfirmModal({ title, message, confirmLabel, onConfirm, onCancel }: {
	title: string;
	message: string;
	confirmLabel: string;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<div className="modal-overlay">
			<div className="modal-content modal-confirm" onClick={(e) => e.stopPropagation()}>
				<div className="modal-header">
					<h3>{title}</h3>
				</div>
				<div className="modal-body">
					<p className="modal-info">{message}</p>
					<div className="modal-actions">
						<button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
						<button type="button" className="btn-danger" onClick={onConfirm}>{confirmLabel}</button>
					</div>
				</div>
			</div>
		</div>
	);
}

function ExposeAsToolSection({ agentId, agentName, systemPrompt }: { agentId: string; agentName: string; systemPrompt: string }) {
	const { entries, create, update, remove, fetchEntries } = useAgentToolStore();
	const [toolEntry, setToolEntry] = useState<AgentToolEntry | null>(null);
	const [toolName, setToolName] = useState("");
	const [description, setDescription] = useState("");
	const [enabled, setEnabled] = useState(false);

	useEffect(() => {
		const existing = entries.find((e) => e.type === "internal" && e.agentId === agentId);
		if (existing) {
			setToolEntry(existing);
			setToolName(existing.name);
			setDescription(existing.description ?? "");
			setEnabled(existing.enabled);
		} else {
			setToolEntry(null);
			setToolName(kebab(agentName));
			setDescription("");
			setEnabled(false);
		}
	}, [entries, agentId, agentName]);

	const handleToggle = async (val: boolean) => {
		setEnabled(val);
		if (val && !toolEntry) {
			const created = await create({
				name: toolName || kebab(agentName),
				description: description || undefined,
				type: "internal",
				enabled: true,
				agentId,
			});
			setToolEntry(created);
			fetchEntries();
		} else if (toolEntry) {
			await update(toolEntry.id, { enabled: val });
			fetchEntries();
		}
	};

	const handleSave = async () => {
		if (!toolEntry) return;
		await update(toolEntry.id, {
			name: toolName || kebab(agentName),
			description: description || undefined,
		});
		fetchEntries();
	};

	return (
		<div className="editor-section">
			<h4 className="section-title">作为工具暴露</h4>
			<p className="section-desc">启用后，其他 Agent 可像调用工具一样调用此 Agent</p>
			<label className="checkbox-label">
				<input type="checkbox"
					checked={enabled}
					onChange={(e) => handleToggle(e.target.checked)}
				/>
				暴露为工具
			</label>
			{enabled && toolEntry && (
				<>
					<label>工具名称（留空则自动生成）
						<input
							value={toolName}
							onChange={(e) => setToolName(e.target.value)}
							placeholder={kebab(agentName)}
						/>
					</label>
					<label>工具描述（留空则使用 System Prompt 前 200 字）
						<textarea
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="描述此工具的功能，帮助调用方 Agent 理解何时使用"
							rows={3}
						/>
					</label>
					<button type="button" className="btn-ghost btn-sm" onClick={handleSave}>保存工具配置</button>
				</>
			)}
		</div>
	);
}

export default function AgentEditor({ agent, onSaved, onCancel, onDelete, prefillTemplate }: Props) {
	const { create, update, models, tools } = useAgentStore();
	const { providers } = useProviderStore();
	const [section, setSection] = useState<Section>("basic");
	const [globalWorkspace, setGlobalWorkspace] = useState("");
	const [defaultPrompt, setDefaultPrompt] = useState("");
	const [saving, setSaving] = useState(false);

	// Prompt editing state
	const [editingPrompt, setEditingPrompt] = useState(false);
	const [draftPrompt, setDraftPrompt] = useState("");
	const savedPromptRef = useRef("");

	// Confirm dialogs
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
	const pendingSectionRef = useRef<Section | null>(null);

	useEffect(() => {
		api().configGet().then((c: any) => {
			setGlobalWorkspace(c.workspaceDir);
			setDefaultPrompt(c.defaultPrompt ?? "");
		}).catch(() => {});
	}, []);

	const defaultWorkspaceDisplay = globalWorkspace ? shorten(globalWorkspace) : "~/.zero-core/workspace";

	const agentToForm = (a: AgentRecord): FormState => ({
		name: a.name,
		workspaceDir: a.workspaceDir || undefined,
		model: a.model,
		provider: a.provider,
		thinkingLevel: a.thinkingLevel,
		contextConfig: a.contextConfig,
		systemPrompt: a.systemPrompt ?? "",
		toolPolicy: a.toolPolicy,
		skillPolicy: a.skillPolicy,
	});

	const defaultForm = (): FormState => ({
		...EMPTY,
		systemPrompt: defaultPrompt,
	});

	const templateToForm = (t: PromptTemplate): FormState => ({
		name: t.name,
		systemPrompt: t.systemPrompt,
		model: t.model,
		provider: t.provider,
		thinkingLevel: t.thinkingLevel,
		toolPolicy: t.toolPolicy,
	});

	const [form, setForm] = useState<FormState>(
		agent ? agentToForm(agent) : prefillTemplate ? templateToForm(prefillTemplate) : defaultForm(),
	);

	useEffect(() => {
		if (agent) {
			setForm(agentToForm(agent));
			savedPromptRef.current = agent.systemPrompt ?? "";
		} else if (prefillTemplate) {
			setForm(templateToForm(prefillTemplate));
			savedPromptRef.current = prefillTemplate.systemPrompt;
		} else {
			setForm(defaultForm());
			savedPromptRef.current = defaultPrompt;
		}
		setEditingPrompt(false);
	}, [agent, globalWorkspace, prefillTemplate]);

	const autoSave = async (data: FormState) => {
		if (!agent) return;
		try {
			const updated = await update(agent.id, {
				...data,
				systemPrompt: data.systemPrompt || undefined,
			});
			onSaved(updated);
		} catch {}
	};

	// Combine built-in models + enabled provider models
	const allModelsByGroup: Record<string, { id: string; name: string; provider?: string }[]> = {};
	for (const m of models) {
		const group = m.provider;
		(allModelsByGroup[group] ??= []).push({ id: m.id, name: m.name, provider: m.provider });
	}
	for (const p of providers) {
		if (!p.enabled) continue;
		for (const m of p.models) {
			const group = m.group || p.name;
			(allModelsByGroup[group] ??= []).push({ id: m.id, name: m.name || m.id, provider: p.name });
		}
	}

	// Prompt has unsaved changes?
	const promptDirty = editingPrompt && draftPrompt !== savedPromptRef.current;

	const startEditPrompt = () => {
		setDraftPrompt(form.systemPrompt ?? "");
		setEditingPrompt(true);
	};

	const cancelEditPrompt = () => {
		if (promptDirty) {
			setShowDiscardConfirm(true);
			return;
		}
		setEditingPrompt(false);
	};

	const savePrompt = async () => {
		setSaving(true);
		const data = { ...form, systemPrompt: draftPrompt || undefined };
		try {
			if (agent) {
				const updated = await update(agent.id, data);
				savedPromptRef.current = draftPrompt;
				onSaved(updated);
			} else {
				const created = await create(data as Omit<AgentRecord, "id" | "createdAt" | "updatedAt">);
				savedPromptRef.current = draftPrompt;
				onSaved(created);
			}
			setForm((f) => ({ ...f, systemPrompt: draftPrompt }));
			setEditingPrompt(false);
		} finally {
			setSaving(false);
		}
	};

	// Section switching with dirty check
	const handleSectionChange = (s: Section) => {
		if (section === "prompt" && promptDirty) {
			pendingSectionRef.current = s;
			setShowDiscardConfirm(true);
			return;
		}
		if (section === "prompt") setEditingPrompt(false);
		setSection(s);
	};

	// Close with dirty check
	const handleClose = () => {
		if (section === "prompt" && promptDirty) {
			pendingSectionRef.current = null;
			setShowDiscardConfirm(true);
			return;
		}
		onCancel();
	};

	const handleDiscardConfirm = () => {
		setShowDiscardConfirm(false);
		setEditingPrompt(false);
		setDraftPrompt(savedPromptRef.current);
		setForm((f) => ({ ...f, systemPrompt: savedPromptRef.current }));
		if (pendingSectionRef.current) {
			setSection(pendingSectionRef.current);
			pendingSectionRef.current = null;
		} else {
			onCancel();
		}
	};

	const set = <K extends keyof FormState>(key: K, val: FormState[K]) => {
		const next = { ...form, [key]: val };
		setForm(next);
		if (agent) autoSave(next);
	};

	const toggleTool = (toolName: string) => {
		const toolsMap = form.toolPolicy?.tools ?? {};
		const enabled = toolsMap[toolName]?.enabled !== false;
		const next: FormState = {
			...form,
			toolPolicy: {
				...form.toolPolicy,
				tools: { ...toolsMap, [toolName]: { enabled: !enabled } },
			},
		};
		setForm(next);
		if (agent) autoSave(next);
	};

	const updateContextConfig = (patch: Partial<NonNullable<FormState["contextConfig"]>>) => {
		const next: FormState = {
			...form,
			contextConfig: { ...form.contextConfig, ...patch },
		};
		setForm(next);
		if (agent) autoSave(next);
	};

	const updateToolPolicy = (patch: Partial<NonNullable<FormState["toolPolicy"]>>) => {
		const next: FormState = {
			...form,
			toolPolicy: { ...form.toolPolicy, ...patch },
		};
		setForm(next);
		if (agent) autoSave(next);
	};

	const SECTIONS: { key: Section; label: string }[] = [
		{ key: "basic", label: "基础设置" },
		{ key: "prompt", label: "提示词设置" },
		{ key: "tools", label: "工具" },
		{ key: "expose", label: "作为工具" },
		{ key: "permissions", label: "权限模式" },
	];

	return (
		<div className="agent-editor">
			<div className="editor-header">
				<h3>{agent ? agent.name : "New Agent"}</h3>
				<div className="editor-header-actions">
					{!agent && (
						<button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
					)}
					{agent && onDelete && (
						<button type="button" className="btn-danger" onClick={() => setShowDeleteConfirm(true)}>Delete</button>
					)}
				</div>
			</div>

			<div className="editor-body">
				<div className="editor-nav">
					{SECTIONS.map((s) => (
						<button
							key={s.key}
							type="button"
							className={`editor-nav-item ${section === s.key ? "active" : ""}`}
							onClick={() => handleSectionChange(s.key)}
						>
							{s.label}
						</button>
					))}
				</div>

				<div className="editor-content">
					{section === "basic" && (
						<div className="editor-section">
							<label>Name
								<input value={form.name} onChange={(e) => set("name", e.target.value)} required />
							</label>
							<label>Workspace Directory
								<input value={form.workspaceDir ?? ""} onChange={(e) => set("workspaceDir", e.target.value || undefined)} placeholder={defaultWorkspaceDisplay} />
							</label>
							<label>Model
								<select
									value={form.model ? `${form.provider}|${form.model}` : ""}
									onChange={(e) => {
										if (!e.target.value) {
											setForm({ ...form, model: undefined, provider: undefined });
											if (agent) autoSave({ ...form, model: undefined, provider: undefined });
										} else {
											const [provider, model] = e.target.value.split("|");
											const next = { ...form, provider, model };
											setForm(next);
											if (agent) autoSave(next);
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
								<select value={form.thinkingLevel ?? ""} onChange={(e) => set("thinkingLevel", e.target.value || undefined)}>
									<option value="">Default</option>
									<option value="low">Low</option>
									<option value="medium">Medium</option>
									<option value="high">High</option>
								</select>
							</label>
						</div>
					)}

					{section === "prompt" && (
						<div className="editor-section">
							<div className="prompt-header">
								<h4 className="section-title">System Prompt</h4>
							<div className="prompt-header-actions">
								{!editingPrompt ? (
									<>
										{agent && <button type="button" className="btn-ghost btn-sm" onClick={() => setForm({ ...form, systemPrompt: defaultPrompt })}>Reset</button>}
										<button type="button" className="btn-primary btn-sm" onClick={startEditPrompt}>Edit</button>
									</>
								) : (
									<>
										<button type="button" className="btn-ghost btn-sm" onClick={cancelEditPrompt}>Cancel</button>
										<button type="button" className="btn-primary btn-sm" onClick={savePrompt} disabled={saving}>{saving ? "Saving..." : agent ? "Save" : "Create"}</button>
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
					)}

					{section === "tools" && (
						<div className="editor-section">
							<h4 className="section-title">可用工具</h4>
							<p className="section-desc">选择该 Agent 可以使用的工具（默认全部启用）</p>
							{(() => {
								const GROUP_LABELS: Record<string, string> = {
									runtime: "运行时工具",
									web: "Web",
									memory: "Knowledge Graph Memory",
									thinking: "Sequential Thinking",
									assistant: "Assistant 诊断",
									interaction: "交互工具",
									agent: "Agent 工具",
									mcp: "MCP 工具",
								};
								const groups: Record<string, typeof tools> = {};
								for (const t of tools) {
									const g = t.group || t.source || "runtime";
									(groups[g] ??= []).push(t);
								}
								const toolsMap = form.toolPolicy?.tools;
								return Object.entries(groups).map(([group, groupTools]) => (
									<div key={group} className="tool-group">
										<h5 className="tool-group-title">{GROUP_LABELS[group] || group}</h5>
										<div className="tool-list">
											{groupTools.map((t) => {
												const DEFAULT_ENABLED = new Set(["bash", "read", "write", "edit", "grep", "find"]);
												const enabled = toolsMap
													? (t.name in toolsMap ? toolsMap[t.name].enabled : DEFAULT_ENABLED.has(t.name))
													: DEFAULT_ENABLED.has(t.name);
												return (
													<div key={t.name} className="tool-item">
														<div className="tool-info">
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
												);
											})}
										</div>
									</div>
								));
							})()}
						</div>
					)}

					{section === "expose" && agent && (
						<ExposeAsToolSection agentId={agent.id} agentName={form.name} systemPrompt={form.systemPrompt ?? ""} />
					)}

					{section === "permissions" && (
						<div className="editor-section">
							<h4 className="section-title">权限范围</h4>
							<label>读取范围
								<select
									value={form.toolPolicy?.readScope ?? "filesystem"}
									onChange={(e) => updateToolPolicy({ readScope: e.target.value as "filesystem" | "workspace" })}
								>
									<option value="filesystem">整个文件系统</option>
									<option value="workspace">仅工作目录</option>
								</select>
							</label>
							<label>执行模式
								<select
									value={form.toolPolicy?.executionMode ?? ""}
									onChange={(e) => updateToolPolicy({ executionMode: (e.target.value || undefined) as "sequential" | "parallel" | undefined })}
								>
									<option value="">并行 (默认)</option>
									<option value="sequential">顺序</option>
									<option value="parallel">并行</option>
								</select>
							</label>
							<p className="section-desc">写/改/删工具始终限制在工作目录内</p>
						</div>
					)}
				</div>
			</div>

			{showDeleteConfirm && (
				<ConfirmModal
					title="Delete Agent"
					message={`Are you sure you want to delete "${agent?.name}"? This cannot be undone.`}
					confirmLabel="Delete"
					onConfirm={() => { setShowDeleteConfirm(false); onDelete?.(); }}
					onCancel={() => setShowDeleteConfirm(false)}
				/>
			)}

			{showDiscardConfirm && (
				<ConfirmModal
					title="Unsaved Changes"
					message="You have unsaved changes to the system prompt. Discard changes?"
					confirmLabel="Discard"
					onConfirm={handleDiscardConfirm}
					onCancel={() => { setShowDiscardConfirm(false); pendingSectionRef.current = null; }}
				/>
			)}
		</div>
	);
}
