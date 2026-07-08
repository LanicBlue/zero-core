// Skills 发现 / 浏览 / 编辑页面(双栏)
//
// # 文件说明书
//
// ## 核心功能
// 双栏布局:
//   - 左:skill 列表,按来源分组("本软件 skills" `source==="app"` 置顶,外部其下);
//     每项 display name + source 标记。
//   - 右:选中 skill 详情——display name / description / source / body(body 按需取)。
// 本软件 skill(source==="app"):可编辑(display name + description + body)、新建、删除。
// 外部来源(source==="user"):只读,无编辑/删除按钮。
// body 经 `skillsGetBody(id)` 按需取(scanner 不持有 body,见 F4)。
//
// ## 输入
// - window.api.skillsList():DiscoveredSkill[]
// - window.api.skillsGetBody(id):{ body, source }
// - window.api.skillsCreate/update/delete(本软件 skill 写操作)
//
// ## 输出
// - 渲染的双栏 DOM(.skills-page / .skills-two-pane / .skills-detail-pane 等)
//
// ## 定位
// 渲染进程组件,被 AppLayout 路由到 skills 页面时加载。
//
// ## 依赖
// - react
// - ../../../shared/types (DiscoveredSkill)
// - window.api(preload 暴露的 skills* 接口)
//
// ## 维护规则
// - DiscoveredSkill 字段变化时同步详情渲染。
// - Skill 来源类别新增(如 plugin)时需要扩展分组逻辑。
// - 写路径安全护栏在后端(skill-router);本组件只负责按 source 控按钮可见性。
// - v1 边界:CRUD 只管 SKILL.md 入口;兄弟文件/脚本的新建编辑留后续 sub。
//

import React, { useState, useEffect, useCallback } from "react";
import type { DiscoveredSkill } from "../../../shared/types.js";

const api = () => (window as any).api;

type SkillSource = "app" | "user";

interface BodyState {
	loading: boolean;
	body: string;
	error?: string;
}

type Mode =
	| { kind: "view" }
	| { kind: "edit" }
	| { kind: "create" };

export default function SkillsPage() {
	const [skills, setSkills] = useState<DiscoveredSkill[]>([]);
	const [loadingList, setLoadingList] = useState(true);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [mode, setMode] = useState<Mode>({ kind: "view" });
	const [body, setBody] = useState<BodyState>({ loading: false, body: "" });
	const [toast, setToast] = useState<{ kind: "error" | "info"; text: string } | null>(null);

	const loadSkills = useCallback(async () => {
		setLoadingList(true);
		try {
			const list = await api().skillsList();
			setSkills(list ?? []);
		} catch {
			setSkills([]);
		} finally {
			setLoadingList(false);
		}
	}, []);

	useEffect(() => {
		loadSkills();
	}, [loadSkills]);

	// 选中项变化 → 按需拉 body(F4)。create 模式不拉(用空表单)。
	useEffect(() => {
		if (mode.kind === "create") {
			setBody({ loading: false, body: "" });
			return;
		}
		if (!selectedId) {
			setBody({ loading: false, body: "" });
			return;
		}
		let cancelled = false;
		setBody({ loading: true, body: "" });
		(async () => {
			try {
				const res = await api().skillsGetBody(selectedId);
				if (cancelled) return;
				if (res && typeof res.body === "string") {
					setBody({ loading: false, body: res.body });
				} else {
					setBody({ loading: false, body: "", error: res?.error ?? "Failed to load body" });
				}
			} catch (e) {
				if (cancelled) return;
				setBody({ loading: false, body: "", error: (e as Error).message });
			}
		})();
		return () => { cancelled = true; };
	}, [selectedId, mode.kind]);

	const selected = skills.find((s) => s.id === selectedId) ?? null;

	const showToast = (kind: "error" | "info", text: string) => {
		setToast({ kind, text });
		setTimeout(() => setToast(null), 4000);
	};

	const handleSelect = (id: string) => {
		setSelectedId(id);
		setMode({ kind: "view" });
	};

	const handleCreateClick = () => {
		setSelectedId(null);
		setMode({ kind: "create" });
	};

	const handleCancel = () => {
		setMode({ kind: "view" });
	};

	const handleCreate = async (input: { id: string; name: string; description: string; body: string }) => {
		try {
			const res = await api().skillsCreate(input);
			if (res && res.id) {
				await loadSkills();
				setSelectedId(input.id);
				setMode({ kind: "view" });
				showToast("info", `Created skill: ${input.id}`);
			} else {
				showToast("error", (res as any)?.error ?? "Failed to create skill");
			}
		} catch (e) {
			showToast("error", (e as Error).message);
		}
	};

	const handleSave = async (id: string, input: { name: string; description: string; body: string }) => {
		try {
			const res = await api().skillsUpdate(id, input);
			if (res && res.id) {
				await loadSkills();
				setBody({ loading: false, body: input.body });
				setMode({ kind: "view" });
				showToast("info", `Saved skill: ${id}`);
			} else {
				showToast("error", (res as any)?.error ?? "Failed to save skill");
			}
		} catch (e) {
			showToast("error", (e as Error).message);
		}
	};

	const handleDelete = async (id: string) => {
		if (!window.confirm(`Delete skill "${id}"?\n\nThis removes the entire skill directory (~/.zero-core/skills/${id}/) including any sibling files. This cannot be undone.`)) {
			return;
		}
		try {
			const res = await api().skillsDelete(id);
			if (res && res.success) {
				await loadSkills();
				if (selectedId === id) setSelectedId(null);
				setMode({ kind: "view" });
				showToast("info", `Deleted skill: ${id}`);
			} else {
				showToast("error", (res as any)?.error ?? "Failed to delete skill");
			}
		} catch (e) {
			showToast("error", (e as Error).message);
		}
	};

	const appSkills = skills.filter((s) => s.source === "app");
	const userSkills = skills.filter((s) => s.source === "user");

	return (
		<div className="skills-page">
			<div className="skills-page-header">
				<h2>Skills</h2>
				<div className="skills-page-header-actions">
					<button
						type="button"
						className="btn-ghost"
						onClick={loadSkills}
						disabled={loadingList}
					>
						{loadingList ? "Loading..." : "Refresh"}
					</button>
					<button
						type="button"
						className="btn-primary"
						onClick={handleCreateClick}
						title="Create a new skill in ~/.zero-core/skills/"
					>
						+ New Skill
					</button>
				</div>
			</div>

			{toast && (
				<div className={`skills-toast skills-toast-${toast.kind}`}>{toast.text}</div>
			)}

			<div className="skills-two-pane">
				<div className="skills-list-pane">
					{skills.length === 0 && !loadingList && (
						<div className="skills-empty">
							<p>No skills detected.</p>
							<p className="skills-empty-hint">
								Install skills to ~/.claude/skills/ or ~/.agents/skills/, or click &quot;New Skill&quot;.
							</p>
						</div>
					)}

					{appSkills.length > 0 && (
						<SkillListSection
							title="本软件 skills"
							skills={appSkills}
							selectedId={selectedId}
							onSelect={handleSelect}
						/>
					)}
					{userSkills.length > 0 && (
						<SkillListSection
							title="外部 skills"
							skills={userSkills}
							selectedId={selectedId}
							onSelect={handleSelect}
						/>
					)}
				</div>

				<div className="skills-detail-pane">
					{mode.kind === "create" && (
						<SkillCreateForm onCancel={handleCancel} onCreate={handleCreate} />
					)}
					{mode.kind !== "create" && !selected && (
						<div className="skills-detail-empty">
							<p>Select a skill on the left to view details.</p>
						</div>
					)}
					{mode.kind !== "create" && selected && mode.kind === "view" && (
						<SkillDetailView
							skill={selected}
							body={body}
							onEdit={() => setMode({ kind: "edit" })}
							onDelete={() => handleDelete(selected.id)}
						/>
					)}
					{mode.kind !== "create" && selected && mode.kind === "edit" && (
						<SkillEditForm
							skill={selected}
							initialBody={body.body}
							onCancel={handleCancel}
							onSave={(input) => handleSave(selected.id, input)}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

function SkillListSection({
	title,
	skills,
	selectedId,
	onSelect,
}: {
	title: string;
	skills: DiscoveredSkill[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	return (
		<div className="skills-group">
			<h3 className="skills-group-title">
				{title}
				<span className="skills-group-count">{skills.length}</span>
			</h3>
			<div className="skills-list">
				{skills.map((skill) => (
					<button
						type="button"
						key={skill.id}
						className={`skill-item${selectedId === skill.id ? " skill-item-selected" : ""}`}
						onClick={() => onSelect(skill.id)}
					>
						<div className="skill-item-header">
							<span className="skill-item-name">{skill.name}</span>
							<span className={`skill-item-source skill-source-${skill.source}`}>
								{skill.source}
							</span>
						</div>
						<p className="skill-item-description">{skill.description}</p>
						<p className="skill-item-id">id: {skill.id}</p>
					</button>
				))}
			</div>
		</div>
	);
}

function SkillDetailView({
	skill,
	body,
	onEdit,
	onDelete,
}: {
	skill: DiscoveredSkill;
	body: BodyState;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const isApp = skill.source === "app";
	return (
		<div className="skill-detail">
			<div className="skill-detail-header">
				<div>
					<h3 className="skill-detail-name">{skill.name}</h3>
					<p className="skill-detail-meta">
						<span className={`skill-source-${skill.source}`}>{skill.source}</span>
						{" · id: "}<code>{skill.id}</code>
					</p>
				</div>
				{isApp && (
					<div className="skill-detail-actions">
						<button type="button" className="btn-ghost" onClick={onEdit}>Edit</button>
						<button type="button" className="btn-danger" onClick={onDelete}>Delete</button>
					</div>
				)}
			</div>

			<div className="skill-detail-field">
				<label className="skill-detail-label">Description</label>
				<p className="skill-detail-description">{skill.description}</p>
			</div>

			<div className="skill-detail-field">
				<label className="skill-detail-label">Body</label>
				{body.loading && <p className="skill-detail-body-loading">Loading…</p>}
				{!body.loading && body.error && (
					<p className="skill-detail-body-error">Failed to load body: {body.error}</p>
				)}
				{!body.loading && !body.error && (
					<pre className="skill-detail-body">{body.body || "(empty)"}</pre>
				)}
			</div>

			{!isApp && (
				<p className="skill-detail-readonly-hint">
					Read-only — external skills cannot be edited or deleted from here.
				</p>
			)}
		</div>
	);
}

function SkillEditForm({
	skill,
	initialBody,
	onCancel,
	onSave,
}: {
	skill: DiscoveredSkill;
	initialBody: string;
	onCancel: () => void;
	onSave: (input: { name: string; description: string; body: string }) => void;
}) {
	const [name, setName] = useState(skill.name);
	const [description, setDescription] = useState(skill.description);
	const [body, setBodyState] = useState(initialBody);

	return (
		<div className="skill-detail skill-detail-editing">
			<div className="skill-detail-header">
				<h3 className="skill-detail-name">Edit: {skill.name}</h3>
				<p className="skill-detail-meta">
					id: <code>{skill.id}</code> (read-only — directory name)
				</p>
			</div>

			<div className="skill-detail-field">
				<label className="skill-detail-label" htmlFor="skill-edit-name">Display name</label>
				<input
					id="skill-edit-name"
					className="skill-input"
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
			</div>

			<div className="skill-detail-field">
				<label className="skill-detail-label" htmlFor="skill-edit-desc">Description</label>
				<input
					id="skill-edit-desc"
					className="skill-input"
					type="text"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
				/>
			</div>

			<div className="skill-detail-field">
				<label className="skill-detail-label" htmlFor="skill-edit-body">Body (SKILL.md content)</label>
				<textarea
					id="skill-edit-body"
					className="skill-textarea"
					value={body}
					onChange={(e) => setBodyState(e.target.value)}
					rows={18}
				/>
			</div>

			<div className="skill-detail-actions">
				<button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
				<button
					type="button"
					className="btn-primary"
					onClick={() => onSave({ name: name.trim(), description: description.trim(), body })}
					disabled={!name.trim() || !description.trim()}
				>
					Save
				</button>
			</div>
		</div>
	);
}

function SkillCreateForm({
	onCancel,
	onCreate,
}: {
	onCancel: () => void;
	onCreate: (input: { id: string; name: string; description: string; body: string }) => void;
}) {
	const [id, setId] = useState("");
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [body, setBody] = useState("");
	const idValid = /^[a-zA-Z0-9._-]+$/.test(id) && id.length > 0 && id.length <= 64;

	return (
		<div className="skill-detail skill-detail-creating">
			<div className="skill-detail-header">
				<h3 className="skill-detail-name">New skill</h3>
				<p className="skill-detail-meta">
					Created in <code>~/.zero-core/skills/&lt;id&gt;/SKILL.md</code>
				</p>
			</div>

			<div className="skill-detail-field">
				<label className="skill-detail-label" htmlFor="skill-create-id">
					id (directory name — path-safe, immutable)
				</label>
				<input
					id="skill-create-id"
					className="skill-input"
					type="text"
					value={id}
					onChange={(e) => setId(e.target.value)}
					placeholder="e.g. my-skill"
				/>
				{!idValid && id.length > 0 && (
					<p className="skill-field-hint skill-field-hint-error">
						id must be path-safe (letters, digits, <code>.</code>, <code>_</code>, <code>-</code>), 1–64 chars.
					</p>
				)}
			</div>

			<div className="skill-detail-field">
				<label className="skill-detail-label" htmlFor="skill-create-name">Display name</label>
				<input
					id="skill-create-name"
					className="skill-input"
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
			</div>

			<div className="skill-detail-field">
				<label className="skill-detail-label" htmlFor="skill-create-desc">Description</label>
				<input
					id="skill-create-desc"
					className="skill-input"
					type="text"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
				/>
			</div>

			<div className="skill-detail-field">
				<label className="skill-detail-label" htmlFor="skill-create-body">Body (SKILL.md content)</label>
				<textarea
					id="skill-create-body"
					className="skill-textarea"
					value={body}
					onChange={(e) => setBody(e.target.value)}
					rows={18}
				/>
			</div>

			<div className="skill-detail-actions">
				<button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
				<button
					type="button"
					className="btn-primary"
					onClick={() => onCreate({ id: id.trim(), name: name.trim(), description: description.trim(), body })}
					disabled={!idValid || !name.trim() || !description.trim()}
				>
					Create
				</button>
			</div>
		</div>
	);
}
