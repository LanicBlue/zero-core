// Skills 发现与浏览页面
//
// # 文件说明书
//
// ## 核心功能
// 通过 window.api.skillsList 拉取已发现的 Skill，按 user / app 来源分组渲染名称、来源标签与描述，支持手动刷新。
//
// ## 输入
// - window.api.skillsList：返回 DiscoveredSkill[]
//
// ## 输出
// - 渲染的页面 DOM（User Skills / App Skills 两组卡片）
//
// ## 定位
// 渲染进程组件，被 AppLayout 路由到 skills 页面时加载。
//
// ## 依赖
// - react
// - ../../../shared/types (DiscoveredSkill)
// - window.api（preload 暴露的 skillsList 接口）
//
// ## 维护规则
// - DiscoveredSkill 字段变化时同步卡片渲染。
// - Skill 来源类别新增（如 plugin）时需要扩展分组逻辑。
//
import React, { useState, useEffect, useCallback } from "react";
import type { DiscoveredSkill } from "../../../shared/types.js";

const api = () => (window as any).api;

export default function SkillsPage() {
	const [skills, setSkills] = useState<DiscoveredSkill[]>([]);
	const [loading, setLoading] = useState(true);

	const loadSkills = useCallback(async () => {
		setLoading(true);
		try {
			const list = await api().skillsList();
			setSkills(list ?? []);
		} catch {
			setSkills([]);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadSkills();
	}, [loadSkills]);

	const userSkills = skills.filter((s) => s.source === "user");
	const appSkills = skills.filter((s) => s.source === "app");

	return (
		<div className="skills-page">
			<div className="skills-page-header">
				<h2>Skills</h2>
				<button
					type="button"
					className="btn-ghost"
					onClick={loadSkills}
					disabled={loading}
				>
					{loading ? "Loading..." : "Refresh"}
				</button>
			</div>
			<div className="skills-page-body">
				{skills.length === 0 && !loading && (
					<div className="skills-empty">
						<p>No skills detected.</p>
						<p className="skills-empty-hint">
							Install skills to ~/.claude/skills/ or ~/.agents/skills/
						</p>
					</div>
				)}

				{userSkills.length > 0 && (
					<SkillGroup title="User Skills" skills={userSkills} />
				)}
				{appSkills.length > 0 && (
					<SkillGroup title="App Skills" skills={appSkills} />
				)}
			</div>
		</div>
	);
}

function SkillGroup({ title, skills }: { title: string; skills: DiscoveredSkill[] }) {
	return (
		<div className="skills-group">
			<h3 className="skills-group-title">
				{title}
				<span className="skills-group-count">{skills.length}</span>
			</h3>
			<div className="skills-list">
				{skills.map((skill) => (
					<SkillCard key={skill.id} skill={skill} />
				))}
			</div>
		</div>
	);
}

function SkillCard({ skill }: { skill: DiscoveredSkill }) {
	return (
		<div className="skill-card">
			<div className="skill-card-header">
				<span className="skill-card-name">{skill.name}</span>
				<span className={`skill-card-source skill-source-${skill.source}`}>
					{skill.source}
				</span>
			</div>
			<p className="skill-card-description">{skill.description}</p>
		</div>
	);
}
