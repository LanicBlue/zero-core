// 会话压缩 + 记忆提取 prompt 设置面板
//
// # 文件说明书
//
// ## 核心功能
// 配置会话压缩(独立压缩模型 + 压缩摘要 prompt)+ 记忆提取 prompt(归档
// memory turn),保存到主进程。
//
// steps-overhaul sub-4:旧的 L1 摘要阈值 / L2 记忆抽取阈值 / 保留轮数控件随
// compression-engine.ts(L1/L2)一起删除。本面板只留:压缩模型(默认 = 工作
// 模型)+ 两个 prompt override。
//
// memory-archive-fixes sub-3 (decision 4):加两个 prompt override。
// ui-polish(第二轮):两个 prompt 改成与 AgentEditor 的 PromptSection 同款交互 ——
// 默认只读渲染(复用 .prompt-rendered + MarkdownRenderer,与 agent 完全一致),
// 点 Edit 才解锁 textarea(复用 .system-prompt-editor 类,不再用内联样式)。
// 未覆盖时把**内置默认 prompt 正文**显示出来(从 shared/default-prompts 取),
// 配 "default" 徽标,而非只说「使用默认」。Save 即时持久化、Reset 回退草稿。
//   1. 「压缩摘要 prompt」绑 compression.summarySystemPrompt(空 = 默认
//      DEFAULT_SUMMARY_SYSTEM;读侧 compression-trigger-hooks.ts 已转发)。
//   2. 「记忆提取 prompt」绑 archive.memoryPrompt(空 = 默认
//      DEFAULT_ARCHIVE_MEMORY_PROMPT;agent-service buildTempMemoryTurnRunner 读它)。
//
// ## 输入
// - providerStore (Zustand):用于挑选压缩模型的可用 provider/model 列表
// - window.api.memoryConfigGet / memoryConfigUpdate:读写主进程配置
// - shared/default-prompts:内置默认 prompt 正文(显示用)
//
// ## 输出
// - 渲染的设置面板 DOM(模型下拉 + 两个 prompt 字段[只读渲染/Edit 解锁])
//
// ## 定位
// 渲染进程组件,被 SettingsPage 在 Memory 分页下渲染。
//
// ## 依赖
// - react
// - ../../store/provider-store
// - ../common/MarkdownRenderer(与 AgentEditor PromptSection 同款渲染)
// - ../../../shared/default-prompts(内置默认正文)
// - window.api(preload 暴露的 memoryConfig* 接口)
//
// ## 维护规则
// - 压缩/归档配置字段变化时同步本面板。
// - 默认 prompt 文案改 → 改 shared/default-prompts.ts(此处自动跟)。
//

import { useEffect, useState } from "react";
import { modelOptionSuffix } from "../../utils/model-format.js";
import { useProviderStore } from "../../store/provider-store.js";
import MarkdownRenderer from "../common/MarkdownRenderer.js";
import { DEFAULT_SUMMARY_SYSTEM, DEFAULT_ARCHIVE_MEMORY_PROMPT } from "../../../shared/default-prompts.js";

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
 * 单个 prompt 字段 —— 默认只读渲染 + Edit 解锁 + Save/Reset。与 AgentEditor
 * 的 PromptSection 同款交互 + 同套 CSS 类(.prompt-rendered / .system-prompt-editor /
 * .prompt-header),不再用内联样式。
 *
 * 未覆盖(value 空)时显示**内置默认正文**(defaultValue,渲染端从 shared 取),
 * 配 "default" 徽标 —— 用户能直接看到当前生效的 prompt 是什么。Save 即时持久化。
 */
function PromptField({
	label,
	value,
	defaultValue,
	description,
	onSave,
}: {
	label: string;
	value: string | undefined;
	defaultValue: string;
	description: string;
	onSave: (next: string) => Promise<void> | void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value ?? "");
	const [saving, setSaving] = useState(false);

	const usingDefault = !value || !value.trim();

	const startEdit = () => {
		// 进入编辑态:草稿预填当前生效值(用户覆盖值,或内置默认正文)。
		setDraft(usingDefault ? defaultValue : value!);
		setEditing(true);
	};
	const reset = () => setDraft(usingDefault ? defaultValue : value!);
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
				<label className="config-label">
					{label}
					{usingDefault && (
						<span className="prompt-default-badge" title="当前生效的是内置默认 prompt">default</span>
					)}
				</label>
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
				// 只读渲染:与 AgentEditor PromptSection 同款 .prompt-rendered + MarkdownRenderer。
				// 未覆盖 → 显示内置默认正文(用户看得到当前生效内容)。
				<div className="prompt-rendered">
					<MarkdownRenderer content={usingDefault ? defaultValue : value!} />
				</div>
			) : (
				// 编辑态:复用 .system-prompt-editor(全局 textarea 类,不用内联样式)。
				<textarea
					className="system-prompt-editor"
					aria-label={label}
					placeholder="Leave empty (clear all text) + Save to use the built-in default."
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
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
					defaultValue={DEFAULT_SUMMARY_SYSTEM}
					description="Override the stage-3 compression system prompt (default shown when empty). The 5-section JSON output contract is fixed — a custom prompt that breaks the parser falls back to a valid summary. Clear all text + Save to use the default."
					onSave={saveCompressionPrompt}
				/>
			</div>

			<div className="memory-config-section">
				<h4 className="memory-config-title">Memory Extraction (Archive)</h4>
				<p className="memory-config-desc">
					Override the prompt fed to the ephemeral "memory turn" that runs when a session is archived (default shown when empty). The agent uses it to self-write durable wiki memory before the JSON export.
				</p>

				<PromptField
					label="记忆提取 prompt"
					value={archive.memoryPrompt}
					defaultValue={DEFAULT_ARCHIVE_MEMORY_PROMPT}
					description="Override the archive memory-turn prompt (default shown when empty). Clear all text + Save to use the default."
					onSave={saveArchivePrompt}
				/>
			</div>

			<button type="button" className="btn-primary btn-sm" onClick={save}>
				{saved ? "Saved ✓" : "Save"}
			</button>
		</div>
	);
}
