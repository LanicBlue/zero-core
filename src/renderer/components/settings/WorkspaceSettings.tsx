// 工作区设置组件
//
// # 文件说明书
//
// ## 核心功能
// 展示和编辑工作区配置（工作目录、默认 Agent、Provider 等）
//
// ## 输入
// preload API 返回的工作区配置数据
//
// ## 输出
// 工作区配置编辑表单 JSX
//
// ## 定位
// src/renderer/components/settings/ — 设置页面组件，工作区级配置
//
// ## 依赖
// React、store/provider-store.ts、preload API
//
// ## 维护规则
// 工作区配置字段变更需同步更新 shared/types.ts
//
import { useEffect, useState } from "react";
import { useProviderStore } from "../../store/provider-store.js";

const api = () => (window as any).api;

function formatCtx(n?: number): string {
	if (!n) return "";
	return n >= 1048576 ? (n / 1048576).toFixed(n % 1048576 === 0 ? 0 : 1) + "M" : n >= 1000 ? Math.round(n / 1000) + "K" : String(n);
}

export function WorkspaceSettings() {
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

	const enabledModels: { provider: string; id: string; name: string; group: string; contextWindow?: number }[] = [];
	for (const p of providers) {
		if (!p.enabled) continue;
		for (const m of p.models) {
			enabledModels.push({ provider: p.name, id: m.id, name: m.name || m.id, group: m.group || p.name, contextWindow: m.contextWindow });
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
										{m.name}{m.contextWindow ? ` — ${formatCtx(m.contextWindow)}` : ""}
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
