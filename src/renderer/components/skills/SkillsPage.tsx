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
