// Provider 编辑器组件
//
// # 文件说明书
//
// ## 核心功能
// 编辑和创建 LLM Provider 配置（API Key、Base URL、模型列表等）
//
// ## 输入
// Provider 数据（编辑模式）、默认配置
//
// ## 输出
// Provider 编辑表单 JSX、保存/取消操作
//
// ## 定位
// src/renderer/components/settings/ — 设置页面组件，Provider 配置编辑
//
// ## 依赖
// React、store/provider-store.ts、shared/types.ts、core/constants.ts
//
// ## 维护规则
// Provider 字段变更需同步更新表单
//
import React, { useState, useEffect } from "react";
import { useProviderStore } from "../../store/provider-store.js";
import type { Provider, ProviderModel } from "../../../shared/types.js";
import { DEFAULT_URLS } from "../../../core/constants.js";

export function ProviderEditor({ provider, onClose }: { provider: Provider | null; onClose: () => void }) {
	const { create, update, addModel, removeModel, fetchModels, fetchProviders } = useProviderStore();
	const isEdit = !!provider;

	const [form, setForm] = useState({
		name: provider?.name ?? "",
		type: provider?.type ?? "openai-compatible" as Provider["type"],
		apiKey: provider?.apiKey ?? "",
		baseUrl: provider?.baseUrl ?? DEFAULT_URLS.openai,
		enabled: provider?.enabled ?? true,
		enableConcurrencyLimit: provider?.enableConcurrencyLimit ?? false,
		maxConcurrency: Number(provider?.maxConcurrency) || 3,
	});
	const [newModelId, setNewModelId] = useState("");
	const [newModelGroup, setNewModelGroup] = useState("");
	const [fetchingModels, setFetchingModels] = useState(false);
	const [models, setModels] = useState<ProviderModel[]>(provider?.models ?? []);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

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
				// Backend fetch-models endpoint enriches and saves models to DB.
				await fetchModels(pid);
				// Refresh store from backend to pick up enriched data.
				await fetchProviders();
				const updated = useProviderStore.getState().providers.find((p) => p.id === pid);
				if (updated) setModels(updated.models);
				if (!isEdit && pid) {
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
		<div className="modal-overlay">
			<div className="provider-editor">
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
									<div className="model-modalities">
										<span className="modality-tag modality-tag-text" title="文本输入(所有模型支持)">text</span>
										{m.multimodal === true && (
											<span className="modality-tag modality-tag-image modality-tag-on" title="支持图像输入">image</span>
										)}
									</div>
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
