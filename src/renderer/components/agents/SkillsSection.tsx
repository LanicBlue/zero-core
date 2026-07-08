// Agent skill 选择区段 (skill-system sub-5)
//
// # 文件说明书
//
// ## 核心功能
// 在 Agent 编辑器中管理 per-agent 启用的 skills(写 form.skillPolicy.enabledSkills,
// 值为 skill id=目录名)。镜像 ToolsSection 的分组 checkbox 布局。
//
// ## 输入
// - form(FormState):含 skillPolicy.enabledSkills:string[](id 列表)
// - skills(DiscoveredSkill[]):从 skill-router(/api/skills → preload skillsList)拉取
//
// ## 输出
// 按来源分组的 skill 开关列表 JSX
//
// ## 定位
// src/renderer/components/agents/ — Agent 编辑器的子区段(邻近 ToolsSection)
//
// ## 依赖
// React、../../../shared/types(DiscoveredSkill)、./agent-editor-types(FormState)
//
// ## 维护规则
// - 来源分组 label 变更同步本文件 GROUP_LABELS
// - identity 始终是 skill.id(目录名);UI 显示 skill.name(display name)
//
// sub-5 (skill-system, decision 1/6): UI 显示 display name,checkbox 值绑 id(目录名)。
// "本软件 skills" = source==="app" 置顶;外部 = source==="user"(含 ~/.claude + ~/.agents)。
// 清空回归:取消全部勾选必须显式发 [](JSON.stringify 丢 undefined → 后端 merge 留旧值),
// 调用方(toggleSkill in AgentEditor)负责把空数组透传到 autoSave。
import { useMemo } from "react";
import type { DiscoveredSkill } from "../../../shared/types.js";
import type { FormState } from "./agent-editor-types.js";

interface Props {
	form: FormState;
	skills: DiscoveredSkill[];
	toggleSkill: (skillId: string) => void;
	/** sub-8 (decision 11): toggle whether this agent may create/edit skills. */
	toggleCanAuthorSkills: (next: boolean) => void;
}

// app 置顶 → user 其下(对齐 acceptance-5 用例 2 + design 决策 7)。
const GROUP_ORDER: Array<"app" | "user"> = ["app", "user"];
const GROUP_LABELS: Record<DiscoveredSkill["source"], string> = {
	app: "本软件 skills",
	user: "外部 skills (~/.claude / ~/.agents)",
};

export function SkillsSection({ form, skills, toggleSkill, toggleCanAuthorSkills }: Props) {
	// sub-4 已把 enabledSkills 归一化为 [](agentToForm),这里防御性兜底。
	const enabledSkills: string[] = form.skillPolicy?.enabledSkills ?? [];
	// sub-8: canAuthorSkills 归一化(agentToForm 已做 === true,这里再兜底)。
	const canAuthorSkills = form.skillPolicy?.canAuthorSkills === true;
	const enabledSet = useMemo(() => new Set(enabledSkills), [enabledSkills]);

	// 按 source 分组(保持 GROUP_ORDER 顺序:app 置顶)。
	const groups: Record<string, DiscoveredSkill[]> = {};
	for (const s of skills) {
		(groups[s.source] ??= []).push(s);
	}
	// 稳定排序:id 升序,避免勾选/取消时组内顺序抖动。
	for (const k of Object.keys(groups)) {
		groups[k].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	}

	const orderedGroups = GROUP_ORDER.filter((g) => groups[g]?.length);

	return (
		<div className="editor-section">
			<h4 className="section-title">可用 skills</h4>
			<p className="section-desc">
				选择该 Agent 可以使用的 skills。勾选的 skill 会按 id(目录名)写入
				<code>skillPolicy.enabledSkills</code>。
			</p>

			{/* sub-8 (decision 11): per-agent 写权限门禁。默认关;开 → agent 经
			    `[skills]/<id>/SKILL.md` 虚拟路径用 Write/Edit 自建/编辑 skill,
			    仅落 ~/.zero-core/skills/,外部来源只读。门禁在 Write/Edit 工具内查。 */}
			<div className="tool-item skill-author-toggle">
				<div className="tool-info">
					<span className="tool-name">允许此 agent 创建 skill</span>
					<span className="tool-desc">
						开启后,该 agent 可用 Write/Edit 经 <code>[skills]/&lt;id&gt;/SKILL.md</code> 虚拟路径
						创建或编辑 skill(仅落 ~/.zero-core/skills/,外部来源只读)。默认关闭。
					</span>
				</div>
				<input
					type="checkbox"
					className="skill-author-toggle__checkbox"
					checked={canAuthorSkills}
					onChange={(e) => toggleCanAuthorSkills(e.target.checked)}
					aria-label="允许此 agent 创建 skill"
				/>
			</div>

			{orderedGroups.length === 0 && (
				<p className="section-desc">未检测到任何 skill。</p>
			)}

			{orderedGroups.map((group) => (
				<div key={group} className="tool-group">
					<h5 className="tool-group-title">
						{GROUP_LABELS[group]}
						<span className="skills-group-count">{groups[group].length}</span>
					</h5>
					<div className="tool-list">
						{groups[group].map((skill) => {
							// 值绑 id(目录名),UI 显示 display name。
							const enabled = enabledSet.has(skill.id);
							return (
								<div key={skill.id} className="tool-item">
									<div className="tool-info">
										<span className="tool-name">{skill.name}</span>
										<span className="tool-desc">{skill.description || skill.id}</span>
									</div>
									<input
										type="checkbox"
										className="skill-checkbox"
										checked={enabled}
										onChange={() => toggleSkill(skill.id)}
										aria-label={`Toggle skill ${skill.name}`}
									/>
								</div>
							);
						})}
					</div>
				</div>
			))}
		</div>
	);
}
