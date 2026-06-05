// Agent 暴露为工具配置区段
//
// # 文件说明书
//
// ## 核心功能
// 在 Agent 编辑器中管理"暴露为工具"的配置选项
//
// ## 输入
// AgentToolEntry 列表、agent-editor-types 中的工具函数
//
// ## 输出
// 暴露为工具的配置表单 JSX
//
// ## 定位
// src/renderer/components/agents/ — Agent 编辑器的子区段
//
// ## 依赖
// React、store/agent-tool-store.ts、agent-editor-types.ts
//
// ## 维护规则
// 工具配置字段变更需同步更新表单
//
import { useEffect, useRef, useState } from "react";
import { useAgentToolStore } from "../../store/agent-tool-store.js";
import type { AgentToolEntry } from "../../../shared/types.js";
import { kebab } from "./agent-editor-types.js";

export function ExposeAsToolSection({ agentId, agentName }: { agentId: string; agentName: string }) {
	const { entries, create, update, fetchEntries } = useAgentToolStore();
	const [toolEntry, setToolEntry] = useState<AgentToolEntry | null>(null);
	const [toolName, setToolName] = useState("");
	const [description, setDescription] = useState("");
	const [enabled, setEnabled] = useState(false);
	const [autoBackground, setAutoBackground] = useState(false);
	const [bgTimeout, setBgTimeout] = useState(0);

	const skipSaveRef = useRef(false);

	useEffect(() => {
		const existing = entries.find((e) => e.type === "internal" && e.agentId === agentId);
		if (existing) {
			setToolEntry(existing);
			setToolName(existing.name);
			setDescription(existing.description ?? "");
			setEnabled(existing.enabled);
			setAutoBackground(existing.blocking === false);
			setBgTimeout(existing.auto_background_timeout ?? 0);
			skipSaveRef.current = true;
		} else {
			setToolEntry(null);
			setToolName(kebab(agentName));
			setDescription("");
			setEnabled(false);
		}
	}, [entries, agentId, agentName]);

	const saveToolConfig = async (bg: boolean, timeout: number) => {
		if (!toolEntry) return;
		await update(toolEntry.id, {
			blocking: !bg,
			auto_background_timeout: bg ? timeout : undefined,
		});
		fetchEntries();
	};

	useEffect(() => {
		if (toolEntry && enabled && !skipSaveRef.current) saveToolConfig(autoBackground, bgTimeout);
	}, [autoBackground, bgTimeout]);

	const handleToggle = async (val: boolean) => {
		setEnabled(val);
		if (val && !toolEntry) {
			const created = await create({
				name: toolName || kebab(agentName),
				description: description || undefined,
				blocking: !autoBackground,
				auto_background_timeout: autoBackground ? bgTimeout : undefined,
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
			blocking: !autoBackground,
			auto_background_timeout: autoBackground ? bgTimeout : undefined,
		});
		fetchEntries();
	};
	void handleSave;

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
					<label className="checkbox-label">
						<input type="checkbox"
							checked={autoBackground}
							onChange={(e) => { setAutoBackground(e.target.checked); skipSaveRef.current = false; }}
						/>
						自动转后台
					</label>
					{autoBackground && (
						<label>等待超时 (s)
							<input
								type="number"
								value={bgTimeout}
								onChange={(e) => { setBgTimeout(Number(e.target.value)); skipSaveRef.current = false; }}
								min={0}
								placeholder="设为 0 则立即后台执行，不等待"
							/>
						</label>
					)}
				</>
			)}
		</div>
	);
}
