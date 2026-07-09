// Agent skill 选择区段 (skill-system sub-5;UI 对齐 ToolsSection sub-10)
//
// # 文件说明书
//
// ## 核心功能
// 在 Agent 编辑器中管理 per-agent 启用的 skills(写 form.skillPolicy.enabledSkills,
// 值为 skill id=目录名)。sub-10 起 UI 视觉与交互对齐 ToolsSection:
//   - toggle-switch 替代 <input checkbox>(skill 启用开关)
//   - 点 skill 的 tool-info 展开/收起 detail panel(完整 description + id)
//
// sub-14: 分组改为按 origin(ZERO-CORE/CLAUDE/AGENTS/CODEX),zero-core 置顶;移除
//   per-item origin badge(分组标题已表示来源);详情面板也去掉 origin badge(分组表达)。
//
// ## 输入
// - form(FormState):含 skillPolicy.enabledSkills:string[](id 列表)
// - skills(DiscoveredSkill[]):从 skill-router(/api/skills → preload skillsList)拉取
//
// ## 输出
// 按 origin 分组的 skill 开关列表 JSX(分组:zero-core 置顶 → 其余按 originLabel 字母序)
//
// ## 定位
// src/renderer/components/agents/ — Agent 编辑器的子区段(邻近 ToolsSection)
//
// ## 依赖
// React、../../../shared/types(DiscoveredSkill)、../../../shared/skill-origin(originLabel +
//   originGroupOrder —— sub-14 分组)、./agent-editor-types(FormState)
//
// ## 维护规则
// - 分组标题来自 originLabel();新增 origin 加 originLabel 映射即可,本文件不需改。
// - identity 始终是 skill.id(目录名);UI 显示 skill.name(display name)
//
// sub-5 (skill-system, decision 1/6): UI 显示 display name,toggle 值绑 id(目录名)。
// 清空回归:取消全部勾选必须显式发 [](JSON.stringify 丢 undefined → 后端 merge 留旧值),
// 调用方(toggleSkill in AgentEditor)负责把空数组透传到 autoSave。
//
// sub-10 (decision 10): UI 对齐 ToolsSection —— toggle-switch + 可点展开。
// sub-12: 删 canAuthorSkills toggle(写权限改为 enabledSkills 含 "skill-creator")。
// sub-14: 分组按 origin(originLabel 标题);去 per-item origin badge(含详情面板)。
import { useMemo, useState } from "react";
import type { DiscoveredSkill } from "../../../shared/types.js";
import { originLabel, originGroupOrder } from "../../../shared/skill-origin.js";
import type { FormState } from "./agent-editor-types.js";

interface Props {
	form: FormState;
	skills: DiscoveredSkill[];
	toggleSkill: (skillId: string) => void;
}

export function SkillsSection({ form, skills, toggleSkill }: Props) {
	// sub-10: expandedSkill 跟踪当前展开详情面板的 skill id(同 ToolsSection 的 expandedTool)。
	const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
	// sub-4 已把 enabledSkills 归一化为 [](agentToForm),这里防御性兜底。
	const enabledSkills: string[] = form.skillPolicy?.enabledSkills ?? [];
	const enabledSet = useMemo(() => new Set(enabledSkills), [enabledSkills]);

	// sub-14: 按 origin 分组(zero-core 置顶,其余按 originLabel 字母序)。
	const orderedOrigins = originGroupOrder(skills.map((s) => s.origin));
	const groupsByOrigin = new Map<string, DiscoveredSkill[]>();
	for (const origin of orderedOrigins) {
		groupsByOrigin.set(origin, []);
	}
	for (const s of skills) {
		const arr = groupsByOrigin.get(s.origin);
		if (arr) arr.push(s);
	}
	// 稳定排序:id 升序,避免勾选/取消时组内顺序抖动。
	for (const arr of groupsByOrigin.values()) {
		arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	}

	return (
		<div className="editor-section">
			<h4 className="section-title">可用 skills</h4>
			<p className="section-desc">
				选择该 Agent 可以使用的 skills。勾选的 skill 会按 id(目录名)写入
				<code>skillPolicy.enabledSkills</code>。点击 skill 名称可展开详情。
			</p>
			<p className="section-desc">
				提示:勾选 <code>skill-creator</code>(本软件自带)即同时授予该 agent
				创建/编辑 skill 的写权限(经 <code>[skills]/&lt;id&gt;/SKILL.md</code> 虚拟路径)。
			</p>

			{orderedOrigins.length === 0 && (
				<p className="section-desc">未检测到任何 skill。</p>
			)}

			{orderedOrigins.map((origin) => {
				const group = groupsByOrigin.get(origin) ?? [];
				if (group.length === 0) return null;
				return (
					<div key={origin} className="tool-group">
						<h5 className="tool-group-title">
							{originLabel(origin)}
							<span className="skills-group-count">{group.length}</span>
						</h5>
						<div className="tool-list">
							{group.map((skill) => {
								// 值绑 id(目录名),UI 显示 display name。
								const enabled = enabledSet.has(skill.id);
								const expanded = expandedSkill === skill.id;
								return (
									<div key={skill.id}>
										<div className="tool-item">
											<div
												className="tool-info skill-tool-info"
												onClick={() => setExpandedSkill(expanded ? null : skill.id)}
											>
												{/* sub-14: 去掉 per-item origin badge(分组标题已表示来源)。 */}
												<span className="tool-name">{skill.name}</span>
												<span className="tool-desc">{skill.description || skill.id}</span>
											</div>
											<button
												type="button"
												title={enabled ? "Disable" : "Enable"}
												className={`toggle-switch skill-toggle-switch ${enabled ? "on" : ""}`}
												onClick={() => toggleSkill(skill.id)}
												aria-label={`Toggle skill ${skill.name}`}
											/>
										</div>
										{expanded && (
											<div className="tool-detail-panel skill-detail-panel">
												<p>{skill.description || skill.id}</p>
												<div className="skill-detail-meta">
													<span className="skill-detail-id">id: <code>{skill.id}</code></span>
												</div>
											</div>
										)}
									</div>
								);
							})}
						</div>
					</div>
				);
			})}
		</div>
	);
}
