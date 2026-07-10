// 会话压缩设置面板
//
// # 文件说明书
//
// ## 核心功能
// 配置会话压缩（L1 摘要阈值 / L2 记忆抽取阈值 / 保留轮数 / 压缩模型），保存到主进程。
//
// 注:独立的 memory/autoRecall 配置是 v0.8 前的残留(memory 现以 wiki 子树形式存在),
// 已移除。本面板只管压缩。
//
// ## 输入
// - providerStore (Zustand):用于挑选压缩模型的可用 provider/model 列表
// - window.api.memoryConfigGet / memoryConfigUpdate:读写主进程配置
//
// ## 输出
// - 渲染的设置面板 DOM(含滑块、开关、模型下拉与保存按钮)
//
// ## 定位
// 渲染进程组件,被 SettingsPage 在 Memory 分页下渲染。
//
// ## 依赖
// - react
// - ../../store/provider-store
// - window.api(preload 暴露的 memoryConfig* 接口)
//
// ## 维护规则
// - 压缩配置字段(阈值/默认值)变化时同步本面板。
// - 新增模型分组逻辑需要保留按 group 聚合的 optgroup 渲染。
//

import { useEffect, useState } from "react";
import { modelOptionSuffix } from "../../utils/model-format.js";
import { useProviderStore } from "../../store/provider-store.js";

const api = () => (window as any).api;



interface CompressionConfig {
	enabled?: boolean;
	keepRecentTurns?: number;
	l1Threshold?: number;
	l2Threshold?: number;
	provider?: string;
	model?: string;
}

export function MemorySettings() {
	const { providers } = useProviderStore();
	const [compression, setCompression] = useState<CompressionConfig>({ enabled: false });
	const [saved, setSaved] = useState(false);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		api().memoryConfigGet().then((data: any) => {
			setCompression(data.compression ?? { enabled: false });
			setLoading(false);
		}).catch(() => setLoading(false));
	}, []);

	const enabledModels: { provider: string; id: string; name: string; group: string; contextWindow?: number; multimodal?: boolean }[] = [];
	for (const p of providers) {
		if (!p.enabled) continue;
		for (const m of p.models) {
			enabledModels.push({ provider: p.name, id: m.id, name: m.name || m.id, group: m.group || p.name, contextWindow: m.contextWindow, multimodal: m.multimodal });
		}
	}

	const save = async () => {
		await api().memoryConfigUpdate({ compression });
		setSaved(true);
		setTimeout(() => setSaved(false), 2000);
	};

	if (loading) return <p className="settings-empty">Loading...</p>;

	return (
		<div className="memory-config">
			<div className="memory-config-section">
				<h4 className="memory-config-title">Session Compression</h4>
				<p className="memory-config-desc">
					Automatically compress older turns when context fills up. L1 summarizes old turns; L2 extracts memory nodes and discards the originals.
				</p>

				<div className="memory-config-row">
					<label className="config-label">Enable Compression</label>
					<button
						type="button"
						className={`toggle-switch ${compression.enabled ? "on" : ""}`}
						title={compression.enabled ? "Disable compression" : "Enable compression"}
						onClick={() => setCompression({ ...compression, enabled: !compression.enabled })}
					/>
				</div>

				<div className="memory-config-row memory-config-row-stack">
					<label className="config-label">Model</label>
					<select
						className="default-model-select"
						aria-label="Compression Model"
						value={compression.provider && compression.model ? `${compression.provider}|${compression.model}` : ""}
						disabled={!compression.enabled}
						onChange={(e) => {
							if (!e.target.value) {
								setCompression({ ...compression, provider: undefined, model: undefined });
							} else {
								const [prov, model] = e.target.value.split("|");
								setCompression({ ...compression, provider: prov, model });
							}
						}}
					>
						<option value="">Same as Agent</option>
						{[...new Set(enabledModels.map((m) => m.group))].sort().map((group) => (
							<optgroup key={group} label={group}>
								{enabledModels
									.filter((m) => m.group === group)
									.map((m) => (
										<option key={`${m.provider}|${m.id}`} value={`${m.provider}|${m.id}`}>
											{m.name}{modelOptionSuffix(m.contextWindow, m.multimodal)}
										</option>
									))}
							</optgroup>
						))}
					</select>
				</div>

				<div className="memory-config-row">
					<label className="config-label">Keep Recent Turns</label>
					<input
						type="number"
						className="memory-config-number"
						title="Keep Recent Turns"
						value={compression.keepRecentTurns ?? 5}
						min={2}
						max={20}
						onChange={(e) => setCompression({ ...compression, keepRecentTurns: parseInt(e.target.value, 10) || 5 })}
						disabled={!compression.enabled}
					/>
				</div>

				<div className="memory-config-row">
					<label className="config-label">L1 Threshold (compress trigger)</label>
					<div className="memory-config-slider-row">
						<input
							type="range"
							className="memory-config-slider"
							title="L1 Threshold"
							min={0.3}
							max={0.95}
							step={0.05}
							value={compression.l1Threshold ?? 0.7}
							onChange={(e) => setCompression({ ...compression, l1Threshold: parseFloat(e.target.value) })}
							disabled={!compression.enabled}
						/>
						<span className="memory-config-slider-val">{Math.round((compression.l1Threshold ?? 0.7) * 100)}%</span>
					</div>
				</div>

				<div className="memory-config-row">
					<label className="config-label">L2 Threshold (memory extraction)</label>
					<div className="memory-config-slider-row">
						<input
							type="range"
							className="memory-config-slider"
							title="L2 Threshold"
							min={0.2}
							max={0.9}
							step={0.05}
							value={compression.l2Threshold ?? 0.5}
							onChange={(e) => setCompression({ ...compression, l2Threshold: parseFloat(e.target.value) })}
							disabled={!compression.enabled}
						/>
						<span className="memory-config-slider-val">{Math.round((compression.l2Threshold ?? 0.5) * 100)}%</span>
					</div>
				</div>
			</div>

			<button type="button" className="btn-primary btn-sm" onClick={save}>
				{saved ? "Saved ✓" : "Save"}
			</button>
		</div>
	);
}
