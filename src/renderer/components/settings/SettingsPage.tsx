import React, { useEffect, useState } from "react";
import { useProviderStore } from "../../store/provider-store.js";
import type { Provider, ProviderModel } from "../../../shared/types.js";
import { useThemeStore } from "../../store/theme-store.js";

const api = () => (window as any).api;

function ProviderCard({ provider, onEdit }: { provider: Provider; onEdit: () => void }) {
	const { update, remove } = useProviderStore();
	const [confirmDelete, setConfirmDelete] = useState(false);

	const toggleEnabled = async () => {
		await update(provider.id, { enabled: !provider.enabled });
	};

	const handleDelete = async () => {
		if (!confirmDelete) {
			setConfirmDelete(true);
			return;
		}
		await remove(provider.id);
	};

	const modelCount = provider.models.length;

	return (
		<div className={`provider-card ${provider.enabled ? "enabled" : ""}`}>
			<div className="provider-card-header">
				<div className="provider-info">
					<span className="provider-name">{provider.name}</span>
					<span className="provider-type-badge">{provider.type}</span>
					{provider.apiKey && <span className="provider-key-status active">Key set</span>}
					{!provider.apiKey && <span className="provider-key-status">No key</span>}
						{provider.enableConcurrencyLimit && <span className="concurrency-badge">Max {provider.maxConcurrency} concurrent</span>}
				</div>
				<div className="provider-actions">
					<button
						type="button"
						className={`toggle-switch ${provider.enabled ? "on" : ""}`}
						onClick={toggleEnabled}
						title={provider.enabled ? "Disable" : "Enable"}
					/>
					<button type="button" className="btn-ghost btn-sm" onClick={onEdit}>Edit</button>
					{!provider.isSystem && (
						<button
							type="button"
							className={`btn-sm ${confirmDelete ? "btn-danger" : "btn-ghost"}`}
							onClick={handleDelete}
							onBlur={() => setConfirmDelete(false)}
						>
							{confirmDelete ? "Confirm?" : "Delete"}
						</button>
					)}
				</div>
			</div>
			<div className="provider-meta">
				<span className="provider-url">{provider.baseUrl}</span>
				<span className="provider-model-count">{modelCount} model{modelCount !== 1 ? "s" : ""}</span>
			</div>
		</div>
	);
}

function ProviderEditor({ provider, onClose }: { provider: Provider | null; onClose: () => void }) {
	const { create, update, addModel, removeModel, fetchModels } = useProviderStore();
	const isEdit = !!provider;

	const [form, setForm] = useState({
		name: provider?.name ?? "",
		type: provider?.type ?? "openai-compatible" as Provider["type"],
		apiKey: provider?.apiKey ?? "",
		baseUrl: provider?.baseUrl ?? "https://api.openai.com/v1",
		enabled: provider?.enabled ?? true,
		enableConcurrencyLimit: provider?.enableConcurrencyLimit ?? false,
		maxConcurrency: provider?.maxConcurrency ?? 3,
	});
	const [newModelId, setNewModelId] = useState("");
	const [newModelGroup, setNewModelGroup] = useState("");
	const [fetchingModels, setFetchingModels] = useState(false);
	const [models, setModels] = useState<ProviderModel[]>(provider?.models ?? []);
	const [saving, setSaving] = useState(false);

	const currentModels = isEdit ? (useProviderStore.getState().providers.find((p) => p.id === provider!.id)?.models ?? []) : models;

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaving(true);
		try {
			if (isEdit) {
				await update(provider!.id, {
					name: form.name,
					type: form.type,
					apiKey: form.apiKey,
					baseUrl: form.baseUrl,
					enabled: form.enabled,
					enableConcurrencyLimit: form.enableConcurrencyLimit,
					maxConcurrency: form.maxConcurrency,
				});
			} else {
				await create({
					name: form.name,
					type: form.type,
					apiKey: form.apiKey,
					baseUrl: form.baseUrl,
					enabled: form.enabled,
					enableConcurrencyLimit: form.enableConcurrencyLimit,
					maxConcurrency: form.maxConcurrency,
					models: models,
					isSystem: false,
				});
			}
			onClose();
		} finally {
			setSaving(false);
		}
	};

	const handleFetchModels = async () => {
		if (!form.apiKey && form.type !== "ollama") return;
		setFetchingModels(true);
		try {
			// Temporarily save/update the provider first for fetch
			let pid = provider?.id;
			if (isEdit && pid) {
				await update(pid, { apiKey: form.apiKey, baseUrl: form.baseUrl, type: form.type });
			} else {
				const created = await create({
					name: form.name || "temp",
					type: form.type,
					apiKey: form.apiKey,
					baseUrl: form.baseUrl,
					enabled: false,
					models: [],
					isSystem: false,
				});
				pid = created.id;
			}
			if (pid) {
				const fetched = await fetchModels(pid);
				if (fetched.length > 0) {
					for (const m of fetched) {
						if (!currentModels.some((cm) => cm.id === m.id)) {
							await addModel(pid, m);
						}
					}
				}
				// Refresh models from store
				const updated = useProviderStore.getState().providers.find((p) => p.id === pid);
				if (updated) setModels(updated.models);
				if (!isEdit && pid) {
					// Clean up temp - user should save properly
					onClose();
					return;
				}
			}
		} catch (err) {
			console.error("Failed to fetch models:", err);
		} finally {
			setFetchingModels(false);
		}
	};

	const handleAddModel = async () => {
		if (!newModelId.trim()) return;
		const model: ProviderModel = {
			id: newModelId.trim(),
			name: newModelId.trim(),
			group: newModelGroup.trim() || undefined,
		};
		if (isEdit && provider) {
			await addModel(provider.id, model);
			const updated = useProviderStore.getState().providers.find((p) => p.id === provider.id);
			if (updated) setModels(updated.models);
		} else {
			setModels([...models, model]);
		}
		setNewModelId("");
		setNewModelGroup("");
	};

	const handleRemoveModel = async (modelId: string) => {
		if (isEdit && provider) {
			await removeModel(provider.id, modelId);
			const updated = useProviderStore.getState().providers.find((p) => p.id === provider.id);
			if (updated) setModels(updated.models);
		} else {
			setModels(models.filter((m) => m.id !== modelId));
		}
	};

	const displayModels = isEdit
		? (useProviderStore.getState().providers.find((p) => p.id === provider!.id)?.models ?? [])
		: models;

	return (
		<div className="provider-editor-overlay" onClick={onClose}>
			<div className="provider-editor" onClick={(e) => e.stopPropagation()}>
				<div className="editor-header">
					<h3>{isEdit ? `Edit: ${provider!.name}` : "Add Provider"}</h3>
					<button type="button" className="btn-ghost" onClick={onClose}>Close</button>
				</div>

				<form onSubmit={submit}>
					<div className="provider-form-grid">
						<label>Name
							<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
						</label>
						<label>Type
							<select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as Provider["type"] })}>
								<option value="openai">OpenAI</option>
								<option value="anthropic">Anthropic</option>
								<option value="gemini">Google Gemini</option>
								<option value="openai-compatible">OpenAI Compatible</option>
								<option value="ollama">Ollama</option>
							</select>
						</label>
						<label>Base URL
							<input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} required />
						</label>
						<label>API Key
							<input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={form.type === "ollama" ? "Not required" : "sk-..."} />
						</label>
					<label>Concurrency Limit
						<div className="concurrency-row">
							<label className="checkbox-label"><input type="checkbox" checked={form.enableConcurrencyLimit} onChange={(e) => setForm({ ...form, enableConcurrencyLimit: e.target.checked })} /> Enable</label>
							<input type="number" className="concurrency-input" min={1} max={10} value={form.maxConcurrency} onChange={(e) => setForm({ ...form, maxConcurrency: Math.max(1, Math.min(10, parseInt(e.target.value) || 1)) })} disabled={!form.enableConcurrencyLimit} />
						</div>
					</label>
					</div>

					<div className="provider-models-section">
						<div className="section-title-row">
							<h4>Models ({displayModels.length})</h4>
							<button
								type="button"
								className="btn-ghost btn-sm"
								onClick={handleFetchModels}
								disabled={fetchingModels || (!form.apiKey && form.type !== "ollama")}
							>
								{fetchingModels ? "Fetching..." : "Fetch from API"}
							</button>
						</div>
						<div className="model-add-row">
							<input
								value={newModelId}
								onChange={(e) => setNewModelId(e.target.value)}
								placeholder="Model ID (e.g. gpt-4o)"
							/>
							<input
								value={newModelGroup}
								onChange={(e) => setNewModelGroup(e.target.value)}
								placeholder="Group (optional)"
								className="model-group-input"
							/>
							<button type="button" className="btn-primary btn-sm" onClick={handleAddModel}>Add</button>
						</div>
						<div className="model-list">
							{displayModels.map((m) => (
								<div key={m.id} className="model-item">
									<span className="model-id">{m.name || m.id}</span>
									{m.group && <span className="model-group">{m.group}</span>}
									<button type="button" className="btn-ghost btn-sm" onClick={() => handleRemoveModel(m.id)}>×</button>
								</div>
							))}
							{displayModels.length === 0 && (
								<p className="models-empty">No models configured. Add manually or fetch from API.</p>
							)}
						</div>
					</div>

					<div className="provider-form-actions">
						<label className="checkbox-label">
							<input
								type="checkbox"
								checked={form.enabled}
								onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
							/>
							Enabled
						</label>
						<div className="editor-header-actions">
							<button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
							<button type="submit" className="btn-primary" disabled={saving}>
								{saving ? "Saving..." : isEdit ? "Save" : "Create"}
							</button>
						</div>
					</div>
				</form>
			</div>
		</div>
	);
}

function DeviceContextSettings() {
	const [content, setContent] = useState("");
	const [generating, setGenerating] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		api().deviceContextGet().then((r: any) => {
			setContent(r.content ?? "");
		}).catch(() => {});
	}, []);

	const handleGenerate = async () => {
		setGenerating(true);
		try {
			const r = await api().deviceContextGenerate();
			if (r.content) setContent(r.content);
		} finally {
			setGenerating(false);
		}
	};

	const handleSave = async () => {
		setSaving(true);
		try {
			await api().deviceContextSave(content);
			setSaved(true);
			setTimeout(() => setSaved(false), 2000);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="device-context-section">
			<p className="section-desc" style={{ color: "var(--text-muted)", marginBottom: 12 }}>
				Device context is included in the system prompt for agents that have it enabled.
				Click "Generate" to auto-detect hardware and OS info, then edit as needed.
			</p>
			<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
				<button type="button" className="btn-ghost btn-sm" onClick={handleGenerate} disabled={generating}>
					{generating ? "Generating..." : "Generate"}
				</button>
				<button type="button" className="btn-primary btn-sm" onClick={handleSave} disabled={saving}>
					{saving ? "Saving..." : saved ? "Saved ✓" : "Save"}
				</button>
			</div>
			<textarea
				className="device-context-editor"
				value={content}
				onChange={(e) => setContent(e.target.value)}
				placeholder="Click Generate to detect device info, or type custom context here..."
				rows={15}
				style={{ width: "100%", resize: "vertical", fontFamily: "monospace", fontSize: 13, padding: 12, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)" }}
			/>
		</div>
	);
}

function GuidelinesSettings() {
	const [guidelines, setGuidelines] = useState<string[]>([]);
	const [defaults, setDefaults] = useState<string[]>([]);
	const [newGuideline, setNewGuideline] = useState("");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		api().guidelinesGet().then((r: any) => {
			setGuidelines(r.guidelines ?? []);
			setDefaults(r.defaults ?? []);
		}).catch(() => {});
	}, []);

	const handleSave = async () => {
		setSaving(true);
		try {
			await api().guidelinesSave(guidelines);
			setSaved(true);
			setTimeout(() => setSaved(false), 2000);
		} finally {
			setSaving(false);
		}
	};

	const addGuideline = () => {
		const trimmed = newGuideline.trim();
		if (trimmed) {
			setGuidelines([...guidelines, trimmed]);
			setNewGuideline("");
		}
	};

	const removeGuideline = (idx: number) => {
		setGuidelines(guidelines.filter((_, i) => i !== idx));
	};

	const updateGuideline = (idx: number, value: string) => {
		setGuidelines(guidelines.map((g, i) => i === idx ? value : g));
	};

	return (
		<div className="guidelines-section">
			<p className="section-desc" style={{ color: "var(--text-muted)", marginBottom: 12 }}>
				Global guidelines are included in the system prompt for agents that have them enabled.
			</p>
			<div className="guidelines-list" style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
				{guidelines.map((g, idx) => (
					<div key={idx} style={{ display: "flex", gap: 8, alignItems: "center" }}>
						<input
							type="text"
							value={g}
							onChange={(e) => updateGuideline(idx, e.target.value)}
							style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 13 }}
						/>
						<button type="button" className="btn-ghost btn-sm" onClick={() => removeGuideline(idx)}>Remove</button>
					</div>
				))}
			</div>
			<div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
				<input
					type="text"
					value={newGuideline}
					onChange={(e) => setNewGuideline(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") addGuideline(); }}
					placeholder="Add a new guideline..."
					style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 13 }}
				/>
				<button type="button" className="btn-ghost btn-sm" onClick={addGuideline} disabled={!newGuideline.trim()}>Add</button>
			</div>
			<div style={{ display: "flex", gap: 8 }}>
				<button type="button" className="btn-ghost btn-sm" onClick={() => setGuidelines([...defaults])} disabled={guidelines.length === defaults.length && guidelines.every((g, i) => g === defaults[i])}>
					Restore Defaults
				</button>
				<button type="button" className="btn-primary btn-sm" onClick={handleSave} disabled={saving}>
					{saving ? "Saving..." : saved ? "Saved ✓" : "Save"}
				</button>
			</div>
		</div>
	);
}

export default function SettingsPage() {
	const { providers, loading, fetchProviders } = useProviderStore();
	const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
	const [creating, setCreating] = useState(false);
	const [activeSection, setActiveSection] = useState<string>("providers");

	useEffect(() => { fetchProviders(); }, [fetchProviders]);

	const enabledCount = providers.filter((p) => p.enabled).length;

	const sections = [
		{ key: "providers", label: "API Providers", badge: String(providers.length) },
		{ key: "device-context", label: "Device Context" },
		{ key: "guidelines", label: "Guidelines" },
		{ key: "theme", label: "Theme" },
		{ key: "workspace", label: "Workspace" },
	];

	return (
		<div className="settings-page">
			<div className="settings-header">
				<h2>Settings</h2>
				<div className="settings-header-info">
					<span>{enabledCount} of {providers.length} providers enabled</span>
				</div>
			</div>

			<div className="settings-content">
				<div className="settings-nav">
					{sections.map((s) => (
						<button
							key={s.key}
							type="button"
							className={`settings-nav-item ${activeSection === s.key ? "active" : ""}`}
							onClick={() => setActiveSection(s.key)}
						>
							<span className="settings-nav-label">{s.label}</span>
							{s.badge && <span className="settings-nav-badge">{s.badge}</span>}
						</button>
					))}
				</div>

				<div className="settings-panel">
					{activeSection === "providers" && (
						<>
							<div className="section-title-row">
								<h3>API Providers</h3>
								<button
									type="button"
									className="btn-primary btn-sm"
									onClick={() => { setCreating(true); setEditingProvider(null); }}
								>
									+ Add Provider
								</button>
							</div>
							{loading && <p className="settings-empty">Loading providers...</p>}
							{!loading && providers.length === 0 && (
								<p className="settings-empty">No providers configured.</p>
							)}
							<div className="providers-grid">
								{providers.map((p) => (
									<ProviderCard
										key={p.id}
										provider={p}
										onEdit={() => { setEditingProvider(p); setCreating(false); }}
									/>
								))}
							</div>
						</>
					)}

					{activeSection === "device-context" && (
					<>
						<div className="section-title-row"><h3>Device Context</h3></div>
						<DeviceContextSettings />
					</>
				)}

				{activeSection === "guidelines" && (
					<>
						<div className="section-title-row"><h3>Guidelines</h3></div>
					<GuidelinesSettings />
					</>
				)}



					{activeSection === "theme" && (
						<>
							<div className="section-title-row"><h3>Theme</h3></div>
							<ThemeSettings />
						</>
					)}

					{activeSection === "workspace" && (
						<>
							<div className="section-title-row"><h3>Workspace</h3></div>
							<WorkspaceConfig />
						</>
					)}
				</div>
			</div>

			{(creating || editingProvider) && (
				<ProviderEditor
					provider={creating ? null : editingProvider}
					onClose={() => { setCreating(false); setEditingProvider(null); }}
				/>
			)}
		</div>
	);
}

function WorkspaceConfig() {
	const { providers } = useProviderStore();
	const [dir, setDir] = useState("");
	const [defaultModel, setDefaultModel] = useState("");
	const [defaultProvider, setDefaultProvider] = useState("");
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		api().configGet().then((c: any) => {
			if (c.workspaceDir) setDir(c.workspaceDir);
			if (c.defaultModel) setDefaultModel(c.defaultModel);
			if (c.defaultProvider) setDefaultProvider(c.defaultProvider);
		}).catch(() => {});
	}, []);

	const enabledModels: { provider: string; id: string; name: string; group: string }[] = [];
	for (const p of providers) {
		if (!p.enabled) continue;
		for (const m of p.models) {
			enabledModels.push({ provider: p.name, id: m.id, name: m.name || m.id, group: m.group || p.name });
		}
	}

	const save = async () => {
		await api().configUpdate({
			workspaceDir: dir,
			defaultModel: defaultModel || undefined,
			defaultProvider: defaultProvider || undefined,
		});
		setSaved(true);
		setTimeout(() => setSaved(false), 2000);
	};

	return (
		<div className="workspace-config">
			<div className="workspace-config-row">
				<label className="config-label">Workspace Directory</label>
				<div className="workspace-config-input-row">
					<input
						value={dir}
						onChange={(e) => setDir(e.target.value)}
						placeholder="C:\Users\..."
						className="workspace-dir-input"
					/>
				</div>
			</div>
			<div className="workspace-config-row">
				<label className="config-label">Default Model</label>
				<select
					className="default-model-select"
					aria-label="Default Model"
					value={defaultProvider && defaultModel ? `${defaultProvider}|${defaultModel}` : ""}
					onChange={(e) => {
						if (!e.target.value) {
							setDefaultModel("");
							setDefaultProvider("");
						} else {
							const [prov, model] = e.target.value.split("|");
							setDefaultProvider(prov);
							setDefaultModel(model);
						}
					}}
				>
					<option value="">System Default</option>
					{[...new Set(enabledModels.map((m) => m.group))].sort().map((group) => (
						<optgroup key={group} label={group}>
							{enabledModels
								.filter((m) => m.group === group)
								.map((m) => (
									<option key={`${m.provider}|${m.id}`} value={`${m.provider}|${m.id}`}>
										{m.name}
									</option>
								))}
						</optgroup>
					))}
				</select>
			</div>
			<button type="button" className="btn-primary btn-sm" onClick={save}>
				{saved ? "Saved ✓" : "Save"}
			</button>
		</div>
	);
}


function ThemeSettings() {
	const { mode, setMode, customPrimaryColor, setCustomPrimaryColor } = useThemeStore();
	const modes = [
		{ key: "dark", label: "Dark" },
		{ key: "light", label: "Light" },
		{ key: "system", label: "System" },
	];

	return (
		<div className="theme-section">
			<div className="theme-mode-group">
				{modes.map((m) => (
					<button
						key={m.key}
						type="button"
						className={"theme-mode-btn " + (mode === m.key ? "active" : "")}
						onClick={() => setMode(m.key as any)}
					>
						{m.label}
					</button>
				))}
			</div>
			<div className="theme-color-row">
				<input
					type="color"
					value={customPrimaryColor ?? "#1f6feb"}
					onChange={(e) => setCustomPrimaryColor(e.target.value)}
				/>
				<span className="theme-color-label">Custom Primary Color</span>
				{customPrimaryColor && (
					<button type="button" className="btn-ghost btn-sm" onClick={() => setCustomPrimaryColor(null)}>Reset</button>
				)}
			</div>
		</div>
	);
}
