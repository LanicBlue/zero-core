// Agent 编辑器
//
// # 文件说明书
//
// ## 核心功能
// Agent 编辑组件，提供表单编辑和验证功能。
//
// ## 输入
// - Agent 数据
// - Provider 数据
//
// ## 输出
// - 编辑表单
// - 保存/删除操作
//
// ## 定位
// 渲染进程组件，被 AgentsPage 使用。
//
// ## 依赖
// - react - React 框架
// - ../../store - 状态管理
//
// ## 维护规则
// - 新增字段时需更新表单
// - 保持验证逻辑正确
//
import { useState, useEffect, useRef, useMemo } from "react";
import { useAgentStore } from "../../store/agent-store.js";
import { useProviderStore } from "../../store/provider-store.js";
import { useWikiStore } from "../../store/wiki-store.js";
import type { AgentRecord, PromptTemplate } from "../../../shared/types.js";
import { ConfirmModal } from "../common/ConfirmModal.js";
import { BasicSection } from "./BasicSection.js";
import { PromptSection } from "./PromptSection.js";
import { ToolsSection } from "./ToolsSection.js";
import { PermissionsSection } from "./PermissionsSection.js";
import { SubagentsSection } from "./SubagentsSection.js";
import { WikiAnchorsSection } from "./WikiAnchorsSection.js";
import {
	DEFAULT_ENABLED_TOOLS,
	agentToForm,
	templateToForm,
	defaultForm,
	formatTokens,
	shorten,
	type FormState,
	type Section,
} from "./agent-editor-types.js";

interface Props {
	agent: AgentRecord | null;
	onSaved: (agent: AgentRecord) => void;
	onCancel: () => void;
	onDelete?: () => void;
	prefillTemplate?: PromptTemplate;
}

const api = () => (window as any).api;

export default function AgentEditor({ agent, onSaved, onCancel, onDelete, prefillTemplate }: Props) {
	const { create, update, tools, agents } = useAgentStore();
	// v0.8 (P8): wiki nodes for the anchors picker (global tree — anchors can
	// reference any node, including the global root for zero-style agents).
	const wikiNodes = useWikiStore((s) => s.nodes);
	const refreshWiki = useWikiStore((s) => s.refresh);
	useEffect(() => { void refreshWiki(); }, [refreshWiki]);
	const { providers, fetchProviders } = useProviderStore();
	const [section, setSection] = useState<Section>("basic");
	const [globalWorkspace, setGlobalWorkspace] = useState("");
	const [defaultPrompt, setDefaultPrompt] = useState("");
	const [saving, setSaving] = useState(false);

	const [editingPrompt, setEditingPrompt] = useState(false);
	const [draftPrompt, setDraftPrompt] = useState("");
	const savedPromptRef = useRef("");

	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
	const pendingSectionRef = useRef<Section | null>(null);
	useEffect(() => { fetchProviders(); }, [fetchProviders]);

	useEffect(() => {
		api().configGet().then((c: any) => {
			setGlobalWorkspace(c.workspaceDir);
			setDefaultPrompt(c.defaultPrompt ?? "");
		}).catch(() => {});
	}, []);

	const defaultWorkspaceDisplay = globalWorkspace ? shorten(globalWorkspace) : "~/.zero-core/workspace";

	const [form, setForm] = useState<FormState>(
		agent ? agentToForm(agent) : prefillTemplate ? templateToForm(prefillTemplate) : defaultForm(defaultPrompt),
	);

	useEffect(() => {
		if (agent) {
			setForm(agentToForm(agent));
			savedPromptRef.current = agent.systemPrompt ?? "";
		} else if (prefillTemplate) {
			setForm(templateToForm(prefillTemplate));
			savedPromptRef.current = prefillTemplate.systemPrompt;
		} else {
			setForm(defaultForm(defaultPrompt));
			savedPromptRef.current = defaultPrompt;
		}
		setEditingPrompt(false);
	}, [agent, globalWorkspace, prefillTemplate, defaultPrompt]);

	const autoSave = async (data: FormState) => {
		if (!agent) return;
		try {
			const updated = await update(agent.id, {
				...data,
				systemPrompt: data.systemPrompt || undefined,
			});
			onSaved(updated);
		} catch (err) { console.error("AgentEditor autoSave failed:", err); }
	};

	const allModelsByGroup: Record<string, { id: string; name: string; provider?: string; contextWindow?: number; multimodal?: boolean }[]> = {};
	for (const p of providers) {
		if (!p.enabled) continue;
		for (const m of p.models) {
			const group = m.group || p.name;
			(allModelsByGroup[group] ??= []).push({ id: m.id, name: m.name || m.id, provider: p.name, contextWindow: m.contextWindow, multimodal: m.multimodal });
		}
	}

	const promptDirty = editingPrompt && draftPrompt !== savedPromptRef.current;

	const startEditPrompt = () => {
		setDraftPrompt(form.systemPrompt ?? "");
		setEditingPrompt(true);
	};

	const savePrompt = async () => {
		setSaving(true);
		try {
			if (agent) {
				const updated = await update(agent.id, { ...form, systemPrompt: draftPrompt || undefined });
				savedPromptRef.current = draftPrompt;
				onSaved(updated);
			}
			savedPromptRef.current = draftPrompt;
			setForm((f) => ({ ...f, systemPrompt: draftPrompt }));
			setEditingPrompt(false);
		} finally {
			setSaving(false);
		}
	};

	const handleCreate = async () => {
		if (!form.name.trim()) return;
		setSaving(true);
		try {
			const created = await create({
				...form,
				systemPrompt: form.systemPrompt || undefined,
			} as Omit<AgentRecord, "id" | "createdAt" | "updatedAt">);
			onSaved(created);
		} finally {
			setSaving(false);
		}
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

	const handleSectionChange = (s: Section) => {
		if (section === "prompt" && promptDirty) {
			pendingSectionRef.current = s;
			setShowDiscardConfirm(true);
			return;
		}
		if (section === "prompt") setEditingPrompt(false);
		setSection(s);
	};

	const handleClose = () => {
		if (section === "prompt" && promptDirty) {
			pendingSectionRef.current = null;
			setShowDiscardConfirm(true);
			return;
		}
		onCancel();
	};

	const set = <K extends keyof FormState>(key: K, val: FormState[K]) => {
		const next = { ...form, [key]: val };
		setForm(next);
		if (agent) autoSave(next);
	};

	const toggleTool = (toolName: string) => {
		const toolsMap = form.toolPolicy?.tools ?? {};
		const enabled = toolName in toolsMap
			? toolsMap[toolName].enabled !== false
			: DEFAULT_ENABLED_TOOLS.has(toolName);
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

	// v0.8 (P8 §11.10): subagents + wikiAnchors harness-field editors.
	// NOTE: when the list becomes empty we set `[]` (NOT undefined). The autosave
	// payload is JSON.stringify'd before hitting the backend (ipc-proxy), and
	// JSON drops undefined properties — so `undefined` would never reach the
	// store, and the backend's `{...existing, ...input}` merge would silently
	// keep the OLD list (removing the last anchor/subagent would not persist).
	// `[]` survives serialization and explicitly clears the field.
	const updateSubagents = (next: FormState["subagents"]) => {
		const f: FormState = { ...form, subagents: next && next.length > 0 ? next : [] };
		setForm(f);
		if (agent) autoSave(f);
	};

	const updateWikiAnchors = (next: FormState["wikiAnchors"]) => {
		const f: FormState = { ...form, wikiAnchors: next && next.length > 0 ? next : [] };
		setForm(f);
		if (agent) autoSave(f);
	};

	const SECTIONS: { key: Section; label: string }[] = [
		{ key: "basic", label: "基础设置" },
		{ key: "prompt", label: "提示词设置" },
		{ key: "tools", label: "工具" },
		{ key: "subagents", label: "委派 (subagents)" },
		{ key: "anchors", label: "Wiki 锚点" },
		{ key: "permissions", label: "权限模式" },
	];

	const promptTokenCount = useMemo(() => {
		const text = form.systemPrompt ?? "";
		return Math.ceil(text.length / 4);
	}, [form.systemPrompt]);
	const promptTokenEstimate = formatTokens(promptTokenCount);

	const toolsTokenCount = useMemo(() => {
		const toolsMap = form.toolPolicy?.tools;
		let total = 0;
		for (const t of tools) {
			const enabled = toolsMap
				? (t.name in toolsMap ? toolsMap[t.name].enabled : DEFAULT_ENABLED_TOOLS.has(t.name))
				: DEFAULT_ENABLED_TOOLS.has(t.name);
			if (enabled) {
				total += (t.prompt ?? "").length;
				total += t.name.length + 20;
			}
		}
		return Math.ceil(total / 4);
	}, [form.toolPolicy?.tools, tools]);
	const toolsTokenEstimate = formatTokens(toolsTokenCount);
	const totalTokenEstimate = formatTokens(promptTokenCount + toolsTokenCount);

	return (
		<div className="agent-editor">
			<div className="editor-header">
				<h3>{agent ? agent.name : "New Agent"} <span className="token-badge">{totalTokenEstimate} tokens total</span></h3>
				<div className="editor-header-actions">
					{!agent && (
						<>
							<button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
							<button type="button" className="btn-primary btn-sm" onClick={handleCreate} disabled={saving}>{saving ? "Creating..." : "Create"}</button>
						</>
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
						<BasicSection
							form={form}
							onSet={set}
							onSetForm={setForm}
							onAutoSave={autoSave}
							defaultWorkspaceDisplay={defaultWorkspaceDisplay}
							allModelsByGroup={allModelsByGroup}
						/>
					)}

					{section === "prompt" && (
						<PromptSection
							form={form}
							editingPrompt={editingPrompt}
							draftPrompt={draftPrompt}
							setDraftPrompt={setDraftPrompt}
							savedPromptRef={savedPromptRef}
							startEditPrompt={startEditPrompt}
							savePrompt={savePrompt}
							saving={saving}
							promptTokenEstimate={promptTokenEstimate}
							updateContextConfig={updateContextConfig}
						/>
					)}

					{section === "tools" && (
						<ToolsSection
							form={form}
							tools={tools}
							toggleTool={toggleTool}
							toolsTokenEstimate={toolsTokenEstimate}
						/>
					)}

					{section === "subagents" && (
						<SubagentsSection
							form={form}
							agents={agents.filter((a) => a.id !== agent?.id)}
							onChange={updateSubagents}
						/>
					)}

					{section === "anchors" && (
						<WikiAnchorsSection
							form={form}
							wikiNodes={wikiNodes}
							onChange={updateWikiAnchors}
						/>
					)}

					{section === "permissions" && (
						<PermissionsSection form={form} updateToolPolicy={updateToolPolicy} />
					)}
				</div>
			</div>

			{showDiscardConfirm && (
				<ConfirmModal
					title="Unsaved Changes"
					message="You have unsaved changes to the system prompt. Discard changes?"
					confirmLabel="Discard"
					onConfirm={handleDiscardConfirm}
					onCancel={() => { setShowDiscardConfirm(false); pendingSectionRef.current = null; }}
				/>
			)}

			{showDeleteConfirm && (
				<ConfirmModal
					title="Delete Agent"
					message={`Are you sure you want to delete "${agent?.name}"? This cannot be undone.`}
					confirmLabel="Delete"
					onConfirm={() => { setShowDeleteConfirm(false); onDelete?.(); }}
					onCancel={() => setShowDeleteConfirm(false)}
				/>
			)}
		</div>
	);
}
