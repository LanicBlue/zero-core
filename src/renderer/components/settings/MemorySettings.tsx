// 会话压缩设置面板
//
// # 文件说明书
//
// ## 核心功能
// 配置会话压缩(独立压缩模型),保存到主进程。
//
// steps-overhaul sub-4:旧的 L1 摘要阈值 / L2 记忆抽取阈值 / 保留轮数控件随
// compression-engine.ts(L1/L2)一起删除。新的阶段3 压缩核心(server/
// compression-core.ts)是 step 粒度 + fresh-tail 边界(min(32K, 20% 窗口)),
// 没有用户可调的阈值——何时触发由 sub-5 的触发器(cache 冷热 + token 阈值)决定。
// 本面板只留:压缩模型(默认 = 工作模型)。
//
// compression-archive-simplify sub-5:总开关(`compression.enabled`)删除——
// 它是未读假配置(触发 hook 根本不读),UI 翻动它无效果。压缩现在由 cache 冷热
// + token 阈值自动触发。
//
// 注:独立的 memory/autoRecall 配置是 v0.8 前的残留(memory 现以 wiki 子树形式存在),
// 已移除。
//
// ## 输入
// - providerStore (Zustand):用于挑选压缩模型的可用 provider/model 列表
// - window.api.memoryConfigGet / memoryConfigUpdate:读写主进程配置
//
// ## 输出
// - 渲染的设置面板 DOM(含模型下拉与保存按钮)
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
// - 压缩配置字段变化时同步本面板。
// - 新增模型分组逻辑需要保留按 group 聚合的 optgroup 渲染。
//

import { useEffect, useState } from "react";
import { modelOptionSuffix } from "../../utils/model-format.js";
import { useProviderStore } from "../../store/provider-store.js";

const api = () => (window as any).api;



interface CompressionConfig {
	provider?: string;
	model?: string;
}

export function MemorySettings() {
	const { providers } = useProviderStore();
	const [compression, setCompression] = useState<CompressionConfig>({});
	const [saved, setSaved] = useState(false);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		api().memoryConfigGet().then((data: any) => {
			setCompression(data.compression ?? {});
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
					Automatically compress older steps (beyond the fresh-tail boundary) into structured 5-section summaries when context fills up. Compression auto-fires on cache cold/hot + token thresholds — no enable knob. The fresh-tail boundary (min(32K tokens, 20% of window)) is automatic — no knob.
				</p>

				<div className="memory-config-row memory-config-row-stack">
					<label className="config-label">Model</label>
					<select
						className="default-model-select"
						aria-label="Compression Model"
						value={compression.provider && compression.model ? `${compression.provider}|${compression.model}` : ""}
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

			</div>

			<button type="button" className="btn-primary btn-sm" onClick={save}>
				{saved ? "Saved ✓" : "Save"}
			</button>
		</div>
	);
}
