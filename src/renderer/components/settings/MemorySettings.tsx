// 会话压缩 + 记忆提取 prompt 设置面板
//
// # 文件说明书
//
// ## 核心功能
// 配置会话压缩(独立压缩模型 + 压缩摘要 prompt)+ 记忆提取 prompt(归档
// memory turn),保存到主进程。
//
// steps-overhaul sub-4:旧的 L1 摘要阈值 / L2 记忆抽取阈值 / 保留轮数控件随
// compression-engine.ts(L1/L2)一起删除。新的阶段3 压缩核心(server/
// compression-core.ts)是 step 粒度 + fresh-tail 边界(min(32K, 20% 窗口)),
// 没有用户可调的阈值——何时触发由 sub-5 的触发器(cache 冷热 + token 阈值)决定。
// 本面板只留:压缩模型(默认 = 工作模型)+ 两个 prompt override。
//
// compression-archive-simplify sub-5:总开关(`compression.enabled`)删除——
// 它是未读假配置(触发 hook 根本不读),UI 翻动它无效果。压缩现在由 cache 冷热
// + token 阈值自动触发。
//
// memory-archive-fixes sub-3 (decision 4):加两个 prompt override。
// ui-polish:两个 prompt 改成与 AgentEditor 的 PromptSection 同款交互 ——
// 默认只读预览当前值(空 = 显示「使用内置默认」提示),点 Edit 才解锁 textarea,
// Save 即时持久化、Reset 回退草稿。不再常驻裸 textarea。
//   1. 「压缩摘要 prompt」绑 compression.summarySystemPrompt(空 = 默认
//      SUMMARY_SYSTEM;读侧 compression-trigger-hooks.ts 已转发,本面板只
//      负责写)。
//   2. 「记忆提取 prompt」绑 archive.memoryPrompt(空 = 默认
//      ARCHIVE_MEMORY_PROMPT;agent-service buildTempMemoryTurnRunner 读它
//      覆盖)。纯整段覆盖,无模板变量插值。
//
// 注:独立的 memory/autoRecall 配置是 v0.8 前的残留(memory 现以 wiki 子树形式存在),
// 已移除。
//
// ## 输入
// - providerStore (Zustand):用于挑选压缩模型的可用 provider/model 列表
// - window.api.memoryConfigGet / memoryConfigUpdate:读写主进程配置
//
// ## 输出
// - 渲染的设置面板 DOM(模型下拉 + 两个 prompt 字段[只读预览/Edit 解锁])
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
// - 压缩/归档配置字段变化时同步本面板。
// - 新增模型分组逻辑需要保留按 group 聚合的 optgroup 渲染。
//

import { useEffect, useState } from "react";
import { modelOptionSuffix } from "../../utils/model-format.js";
import { useProviderStore } from "../../store/provider-store.js";

const api = () => (window as any).api;



interface CompressionConfig {
	provider?: string;
	model?: string;
	summarySystemPrompt?: string;
}

interface ArchiveConfig {
	memoryPrompt?: string;
}

/**
 * ui-polish:单个 prompt 字段 —— 默认只读预览 + Edit 解锁 + Save/Reset。
 * 与 AgentEditor 的 PromptSection 同款交互(不复用组件是因为它绑死 FormState,
 * 这里 config 形态不同;视觉上复用同套 .prompt-* CSS class)。
 *
 * Save 即时持久化(onSave 写主进程),不是攒着等底部按钮 —— 和 AgentEditor
 * 一致。空值 = 用内置默认,预览态显示「使用内置默认」提示。
 */
function PromptField({
	label,
	value,
	defaultLabel,
	description,
	onSave,
}: {
	label: string;
	value: string | undefined;
	defaultLabel: string;
	description: string;
	onSave: (next: string) => Promise<void> | void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value ?? "");
	const [saving, setSaving] = useState(false);

	const startEdit = () => {
		setDraft(value ?? "");
		setEditing(true);
	};
	const reset = () => setDraft(value ?? "");
	const save = async () => {
		setSaving(true);
		try {
			await onSave(draft);
			setEditing(false);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="memory-config-row memory-config-row-stack">
			<div className="prompt-header">
				<label className="config-label">{label}</label>
				<div className="prompt-header-actions">
					{!editing ? (
						<button type="button" className="btn-primary btn-sm" onClick={startEdit}>Edit</button>
					) : (
						<>
							<button type="button" className="btn-ghost btn-sm" onClick={reset} disabled={saving}>Reset</button>
							<button type="button" className="btn-primary btn-sm" onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
						</>
					)}
				</div>
			</div>
			<p className="memory-config-desc">{description}</p>
			{!editing ? (
				<div className="prompt-rendered">
					{value && value.trim() ? (
						<pre className="system-prompt-editor" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{value}</pre>
					) : (
						<p className="prompt-empty">Using built-in default ({defaultLabel}). Click Edit to override.</p>
					)}
				</div>
			) : (
				<textarea
					aria-label={label}
					rows={8}
					placeholder={`Leave empty to use the built-in default ${defaultLabel}.`}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					style={{ width: "100%", resize: "vertical", fontFamily: "monospace", fontSize: "12px" }}
				/>
			)}
		</div>
	);
}

export function MemorySettings() {
	const { providers } = useProviderStore();
	const [compression, setCompression] = useState<CompressionConfig>({});
	const [archive, setArchive] = useState<ArchiveConfig>({});
	const [saved, setSaved] = useState(false);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		api().memoryConfigGet().then((data: any) => {
			setCompression(data.compression ?? {});
			setArchive(data.archive ?? {});
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

	const flashSaved = () => {
		setSaved(true);
		setTimeout(() => setSaved(false), 2000);
	};

	// 模型选择:底部 Save 持久化(模型改动攒一次写)。
	const save = async () => {
		await api().memoryConfigUpdate({ compression, archive });
		flashSaved();
	};

	// 单个 prompt 的 Save:即时持久化整份 config(与 AgentEditor PromptSection 同款 ——
	// 该字段触发立即写主进程,不是攒着)。显式构造 next 避免依赖尚未 flush 的 state。
	const saveCompressionPrompt = async (v: string) => {
		const nextCompression = { ...compression, summarySystemPrompt: v };
		setCompression(nextCompression);
		await api().memoryConfigUpdate({ compression: nextCompression, archive });
		flashSaved();
	};
	const saveArchivePrompt = async (v: string) => {
		const nextArchive = { ...archive, memoryPrompt: v };
		setArchive(nextArchive);
		await api().memoryConfigUpdate({ compression, archive: nextArchive });
		flashSaved();
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

				<PromptField
					label="压缩摘要 prompt"
					value={compression.summarySystemPrompt}
					defaultLabel="SUMMARY_SYSTEM"
					description="Override the stage-3 compression system prompt (default = built-in SUMMARY_SYSTEM). Empty = use default. The 5-section JSON output contract is fixed — a custom prompt that breaks the parser falls back to a valid summary."
					onSave={saveCompressionPrompt}
				/>
			</div>

			<div className="memory-config-section">
				<h4 className="memory-config-title">Memory Extraction (Archive)</h4>
				<p className="memory-config-desc">
					Override the prompt fed to the ephemeral "memory turn" that runs when a session is archived (default = built-in ARCHIVE_MEMORY_PROMPT). The agent uses it to self-write durable wiki memory before the JSON export. Empty = use default.
				</p>

				<PromptField
					label="记忆提取 prompt"
					value={archive.memoryPrompt}
					defaultLabel="ARCHIVE_MEMORY_PROMPT"
					description="Override the archive memory-turn prompt (default = built-in ARCHIVE_MEMORY_PROMPT). Empty = use default. Pure full-text override, no template variables."
					onSave={saveArchivePrompt}
				/>
			</div>

			<button type="button" className="btn-primary btn-sm" onClick={save}>
				{saved ? "Saved ✓" : "Save"}
			</button>
		</div>
	);
}
