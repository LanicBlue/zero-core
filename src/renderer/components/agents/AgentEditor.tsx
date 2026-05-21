import React, { useState, useEffect } from "react";
import { useAgentStore, type AgentRecord, type ModelInfo } from "../../store/agent-store.js";
import { useProviderStore } from "../../store/provider-store.js";
import type { PromptTemplate } from "../../store/template-store.js";

interface Props {
	agent: AgentRecord | null;
	onSaved: (agent: AgentRecord) => void;
	onCancel: () => void;
	onDelete?: () => void;
	prefillTemplate?: PromptTemplate;
}

type Section = "basic" | "prompt" | "tools" | "permissions";

type FormState = Omit<AgentRecord, "id" | "createdAt" | "updatedAt">;

const shorten = (p: string) =>
	p.replace(/^[A-Z]:\\Users\\[^\\]+/, "~").replace(/\\/g, "/");

const EMPTY: FormState = {
	name: "",
};

const api = () => (window as any).api;

export default function AgentEditor({ agent, onSaved, onCancel, onDelete, prefillTemplate }: Props) {
	const { create, update, models, tools } = useAgentStore();
	const { providers } = useProviderStore();
	const [section, setSection] = useState<Section>("basic");
	const [globalWorkspace, setGlobalWorkspace] = useState("");
	const [defaultPrompt, setDefaultPrompt] = useState("");
	const [saving, setSaving] = useState(false);

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
		} else if (prefillTemplate) {
			setForm(templateToForm(prefillTemplate));
		} else {
			setForm(defaultForm());
		}
	}, [agent, globalWorkspace, prefillTemplate]);

	// Combine built-in models + enabled provider models
	const allModelsByGroup: Record<string, { id: string; name: string; provider?: string }[]> = {};

	// Built-in models from providers
	for (const m of models) {
		const group = m.provider;
		(allModelsByGroup[group] ??= []).push({ id: m.id, name: m.name, provider: m.provider });
	}
	// Enabled provider models
	for (const p of providers) {
		if (!p.enabled) continue;
		for (const m of p.models) {
			const group = m.group || p.name;
			(allModelsByGroup[group] ??= []).push({ id: m.id, name: m.name || m.id, provider: p.name });
		}
	}

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaving(true);
		const data = {
			...form,
			systemPrompt: form.systemPrompt || undefined,
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

	const set = <K extends keyof FormState>(key: K, val: FormState[K]) =>
		setForm({ ...form, [key]: val });

	const toggleAutoApprove = (toolName: string) => {
		const list = form.toolPolicy?.autoApprove ?? [];
		const next = list.includes(toolName)
			? list.filter((t) => t !== toolName)
			: [...list, toolName];
		setForm({ ...form, toolPolicy: { ...form.toolPolicy, autoApprove: next } });
	};

	const SECTIONS: { key: Section; label: string }[] = [
		{ key: "basic", label: "基础设置" },
		{ key: "prompt", label: "提示词设置" },
		{ key: "tools", label: "工具" },
		{ key: "permissions", label: "权限模式" },
	];

	return (
		<form className="agent-editor" onSubmit={submit}>
			<div className="editor-header">
				<h3>{agent ? `Edit: ${agent.name}` : "New Agent"}</h3>
				<div className="editor-header-actions">
					<button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
					<button type="submit" className="btn-primary" disabled={saving}>
						{saving ? "Saving..." : agent ? "Save" : "Create"}
					</button>
					{agent && onDelete && (
						<button type="button" className="btn-danger" onClick={onDelete}>Delete</button>
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
							onClick={() => setSection(s.key)}
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
										} else {
											const [provider, model] = e.target.value.split("|");
											setForm({ ...form, provider, model });
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
								<button
									type="button"
									className="btn-ghost btn-sm"
									onClick={() => setForm({ ...form, systemPrompt: defaultPrompt })}
								>
									Reset to Default
								</button>
							</div>
							<p className="section-desc">Define the agent's behavior, personality, and working style. Tools and project context will be auto-appended.</p>
							<textarea
								className="system-prompt-editor"
								value={form.systemPrompt ?? ""}
								onChange={(e) => set("systemPrompt", e.target.value)}
								placeholder="Write your system prompt here..."
								aria-label="System Prompt"
							/>
							<div className="editor-subsection">
								<h5>Context Settings</h5>
								<label className="checkbox-label">
									<input
										type="checkbox"
										checked={form.contextConfig?.injectProjectContext !== false}
										onChange={(e) => setForm({
											...form,
											contextConfig: { ...form.contextConfig, injectProjectContext: e.target.checked },
										})}
									/>
									Inject project context
								</label>
								<label>Max directory depth
									<input type="number" min={1} max={10} value={form.contextConfig?.maxDirectoryDepth ?? 3}
										onChange={(e) => setForm({ ...form, contextConfig: { ...form.contextConfig, maxDirectoryDepth: parseInt(e.target.value) || 3 } })} />
								</label>
								<label>Exclude patterns (comma-separated)
									<input value={(form.contextConfig?.excludePatterns ?? ["node_modules", ".git", "dist", "build"]).join(", ")}
										onChange={(e) => setForm({ ...form, contextConfig: { ...form.contextConfig, excludePatterns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } })} />
								</label>
							</div>
						</div>
					)}

					{section === "tools" && (
						<div className="editor-section">
							<h4 className="section-title">可用工具</h4>
							<p className="section-desc">选择该 Agent 可以使用的工具（自动授权）</p>
							{(() => {
								const GROUP_LABELS: Record<string, string> = {
									runtime: "运行时工具",
									fetch: "Web Fetch",
									memory: "Knowledge Graph Memory",
									thinking: "Sequential Thinking",
									assistant: "Assistant 诊断",
								search: "Web 搜索",
								interaction: "交互工具",
								};
								const groups: Record<string, typeof tools> = {};
								for (const t of tools) {
									const g = t.group || "runtime";
									(groups[g] ??= []).push(t);
								}
								return Object.entries(groups).map(([group, groupTools]) => (
									<div key={group} className="tool-group">
										<h5 className="tool-group-title">{GROUP_LABELS[group] || group}</h5>
										<div className="tool-list">
											{groupTools.map((t) => {
												const enabled = form.toolPolicy?.autoApprove?.includes(t.name) ?? false;
												return (
													<div key={t.name} className="tool-item">
														<div className="tool-info">
															<span className="tool-name">{t.name}</span>
															<span className="tool-desc">{t.description}</span>
														</div>
														<button
															type="button"
															className={`toggle-switch ${enabled ? "on" : ""}`}
															onClick={() => toggleAutoApprove(t.name)}
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

					{section === "permissions" && (
						<div className="editor-section">
							<h4 className="section-title">权限范围</h4>
							<label>读取范围
								<select
									value={form.toolPolicy?.readScope ?? "filesystem"}
									onChange={(e) => setForm({ ...form, toolPolicy: { ...form.toolPolicy, readScope: e.target.value as "filesystem" | "workspace" } })}
								>
									<option value="filesystem">整个文件系统</option>
									<option value="workspace">仅工作目录</option>
								</select>
							</label>
							<label>执行模式
								<select
									value={form.toolPolicy?.executionMode ?? ""}
									onChange={(e) => setForm({ ...form, toolPolicy: { ...form.toolPolicy, executionMode: (e.target.value || undefined) as "sequential" | "parallel" | undefined } })}
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
		</form>
	);
}
