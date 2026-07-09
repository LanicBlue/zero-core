// Skills 发现 / 浏览 / 编辑页面(双栏)
//
// # 文件说明书
//
// ## 核心功能
// 双栏布局:
//   - 左:skill 列表,**按 origin 分组**(sub-14;原按 source 2 组改为 ZERO-CORE/CLAUDE/
//     AGENTS/CODEX 分组,zero-core 组置顶)。每项 display name + description(2 行截断);
//     **不再显示 per-item origin badge**(分组标题已表示来源,item 3)。
//   - 右:选中 skill 详情——header(display name / origin / id)→
//     Frontmatter 全字段(metadata,含 description;sub-13 置顶 + 去掉独立 Description 字段)→
//     body(sub-11 view 模式 markdown 渲染)/ 兄弟文件列表(Files 段)。
// 本软件 skill(source==="app"):可编辑(display name + description + body)、新建、删除。
// 外部来源(source==="user"):只读,无编辑/删除按钮,但 body/frontmatter/files 仍可读。
// body + frontmatter 经 `skillsGetBody(id)` 按需取(scanner 不持有 body,见 F4)。
// 兄弟文件经 `skillsListFiles(id)` 按需取(sub-11,只读)。
//
// ## 输入
// - window.api.skillsList():DiscoveredSkill[]
// - window.api.skillsGetBody(id):{ body, source, frontmatter }(sub-11 加 frontmatter)
// - window.api.skillsListFiles(id):{ files, source }(sub-11 新增,兄弟文件/脚本)
// - window.api.skillsCreate/update/delete/installGit(本软件 skill 写操作 + git 安装)
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
// - ../../../shared/skill-origin (originLabel + originGroupOrder —— sub-14 分组)
// - ../common/MarkdownRenderer (sub-11 view 模式 body 渲染)
// - window.api(preload 暴露的 skills* 接口)
//
// ## 维护规则
// - DiscoveredSkill 字段变化时同步详情渲染。
// - Skill 来源类别新增(如 plugin)时:扩展 origin 联合类型 + originLabel 映射,
//   originGroupOrder 自动兜底(未知 origin 排在 zero-core 之后)。
// - 写路径安全护栏在后端(skill-router);本组件只负责按 source 控按钮可见性。
// - v1 边界:CRUD 只管 SKILL.md 入口;兄弟文件/脚本的新建编辑留后续 sub(Files 段只读)。
//

import React, { useState, useEffect, useCallback } from "react";
import type { DiscoveredSkill } from "../../../shared/types.js";
import { originLabel, originGroupOrder } from "../../../shared/skill-origin.js";
import MarkdownRenderer from "../common/MarkdownRenderer.js";

const api = () => (window as any).api;

type SkillSource = "app" | "user";

interface BodyState {
	loading: boolean;
	body: string;
	/** sub-11: SKILL.md frontmatter 全字段(供 Metadata 段展示)。 */
	frontmatter: Record<string, string>;
	error?: string;
}

interface SkillFileEntry {
	relPath: string;
	kind: "file" | "dir";
	size: number;
	name: string;
}

interface FilesState {
	loading: boolean;
	files: SkillFileEntry[];
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
	const [body, setBody] = useState<BodyState>({ loading: false, body: "", frontmatter: {} });
	const [files, setFiles] = useState<FilesState>({ loading: false, files: [] });
	const [toast, setToast] = useState<{ kind: "error" | "info"; text: string } | null>(null);
	// sub-7: 从 git 安装弹窗(open / installing / closed)。
	const [installOpen, setInstallOpen] = useState(false);
	const [installing, setInstalling] = useState(false);

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

	// 选中项变化 → 按需拉 body + frontmatter(F4)。create 模式不拉(用空表单)。
	useEffect(() => {
		if (mode.kind === "create") {
			setBody({ loading: false, body: "", frontmatter: {} });
			return;
		}
		if (!selectedId) {
			setBody({ loading: false, body: "", frontmatter: {} });
			return;
		}
		let cancelled = false;
		setBody({ loading: true, body: "", frontmatter: {} });
		(async () => {
			try {
				const res = await api().skillsGetBody(selectedId);
				if (cancelled) return;
				if (res && typeof res.body === "string") {
					setBody({
						loading: false,
						body: res.body,
						frontmatter: res.frontmatter ?? {},
					});
				} else {
					setBody({ loading: false, body: "", frontmatter: {}, error: res?.error ?? "Failed to load body" });
				}
			} catch (e) {
				if (cancelled) return;
				setBody({ loading: false, body: "", frontmatter: {}, error: (e as Error).message });
			}
		})();
		return () => { cancelled = true; };
	}, [selectedId, mode.kind]);

	// sub-11: 选中项变化 → 按需拉兄弟文件列表(只读展示)。
	// edit/create 模式不拉(编辑只管 SKILL.md 入口,兄弟文件 v1 不可编辑)。
	useEffect(() => {
		if (mode.kind !== "view" || !selectedId) {
			setFiles({ loading: false, files: [] });
			return;
		}
		let cancelled = false;
		setFiles({ loading: true, files: [] });
		(async () => {
			try {
				const res = await api().skillsListFiles(selectedId);
				if (cancelled) return;
				if (res && Array.isArray(res.files)) {
					setFiles({ loading: false, files: res.files });
				} else {
					setFiles({ loading: false, files: [], error: res?.error ?? "Failed to load files" });
				}
			} catch (e) {
				if (cancelled) return;
				setFiles({ loading: false, files: [], error: (e as Error).message });
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
				// body 重置(下次切回 view 模式 useEffect 会重拉 frontmatter)。
				setBody({ loading: false, body: input.body, frontmatter: {} });
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

	// sub-7: 从 git URL 安装(异步:clone + auto-detect + 校验 + 落盘)。
	const handleInstallGit = async (url: string) => {
		setInstalling(true);
		try {
			const res = await api().skillsInstallGit(url);
			if (res && Array.isArray((res as any).installed)) {
				await loadSkills();
				const ids = (res as any).installed.map((s: DiscoveredSkill) => s.id).join(", ");
				setInstallOpen(false);
				showToast("info", `Installed ${ids}`);
			} else {
				showToast("error", (res as any)?.error ?? "Failed to install from git");
			}
		} catch (e) {
			showToast("error", (e as Error).message);
		} finally {
			setInstalling(false);
		}
	};

	// sub-14: 按 origin 分组(取代原 source 2 组)。zero-core 置顶,其余按 originLabel 字母序。
	const orderedOrigins = originGroupOrder(skills.map((s) => s.origin));
	const skillsByOrigin = new Map<string, DiscoveredSkill[]>();
	for (const origin of orderedOrigins) {
		skillsByOrigin.set(origin, skills.filter((s) => s.origin === origin));
	}

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
						className="btn-ghost"
						onClick={() => setInstallOpen(true)}
						title="Clone a skill from a git URL into ~/.zero-core/skills/"
					>
						⬇ Install from git
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

			{installOpen && (
				<SkillInstallGitForm
					installing={installing}
					onCancel={() => { if (!installing) setInstallOpen(false); }}
					onInstall={handleInstallGit}
				/>
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

					{orderedOrigins.map((origin) => {
						const group = skillsByOrigin.get(origin) ?? [];
						if (group.length === 0) return null;
						return (
							<SkillListSection
								key={origin}
								title={originLabel(origin)}
								skills={group}
								selectedId={selectedId}
								onSelect={handleSelect}
							/>
						);
					})}
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
							files={files}
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
	files,
	onEdit,
	onDelete,
}: {
	skill: DiscoveredSkill;
	body: BodyState;
	files: FilesState;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const isApp = skill.source === "app";
	// sub-13: frontmatter 全字段置顶(开头展示)。
	//   - name 仍由 header(.skill-detail-name)单独显示 → 在 frontmatter 段去重 name。
	//   - description 不再单独成字段(原 "Description (trigger phrase)" 已删)→
	//     description 只在 frontmatter 段出现一次,保留作触发词主体;给它的 value
	//     加一个 "(trigger)" 小标记保留语义提示。
	const fmEntries = Object.entries(body.frontmatter ?? {}).filter(([k]) => k !== "name");
	const hasFiles = files.files.length > 0;
	return (
		<div className="skill-detail">
			<div className="skill-detail-header">
				<div>
					<h3 className="skill-detail-name">{skill.name}</h3>
					<p className="skill-detail-meta">
						<span className={`skill-source-${skill.source} skill-origin-badge`}>
							{originLabel(skill.origin)}
						</span>
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

			{fmEntries.length > 0 && (
				<div className="skill-detail-field">
					<label className="skill-detail-label">Frontmatter <span className="skill-detail-label-hint">(metadata)</span></label>
					<dl className="skill-frontmatter">
						{fmEntries.map(([k, v]) => (
							<div className="skill-frontmatter-row" key={k}>
								<dt className="skill-frontmatter-key">{k}</dt>
								<dd className="skill-frontmatter-value">
									{v}
									{k === "description" && (
										<span className="skill-frontmatter-trigger-hint"> (trigger)</span>
									)}
								</dd>
							</div>
						))}
					</dl>
				</div>
			)}

			<div className="skill-detail-field">
				<label className="skill-detail-label">Body</label>
				{body.loading && <p className="skill-detail-body-loading">Loading…</p>}
				{!body.loading && body.error && (
					<p className="skill-detail-body-error">Failed to load body: {body.error}</p>
				)}
				{!body.loading && !body.error && (
					// sub-11: view 模式 markdown 渲染(取代 <pre> 裸显)。
					// 用 .skill-detail-body 容器保留滚动 + 边框;MarkdownRenderer 内含 .markdown-body。
					<div className="skill-detail-body skill-detail-body-md">
						{body.body
							? <MarkdownRenderer content={body.body} />
							: <span className="skill-detail-body-empty">(empty)</span>}
					</div>
				)}
			</div>

			<div className="skill-detail-field">
				<label className="skill-detail-label">Files</label>
				{files.loading && <p className="skill-detail-body-loading">Loading…</p>}
				{!files.loading && files.error && (
					<p className="skill-detail-body-error">Failed to load files: {files.error}</p>
				)}
				{!files.loading && !files.error && !hasFiles && (
					<p className="skill-detail-body-loading">Only SKILL.md (no sibling files or scripts).</p>
				)}
				{!files.loading && !files.error && hasFiles && (
					<ul className="skill-files-list">
						{files.files.map((f) => (
							<li key={f.relPath} className={`skill-file skill-file-${f.kind}`}>
								<span className="skill-file-kind">{f.kind === "dir" ? "📁" : "📄"}</span>
								<span className="skill-file-name" title={f.relPath}>{f.name}</span>
								{f.kind === "dir" && <span className="skill-file-rel">/</span>}
								{f.relPath !== f.name && (
									<span className="skill-file-rel">{f.relPath}</span>
								)}
								{f.name === "SKILL.md" && (
									<span className="skill-file-tag skill-file-tag-entry">entry</span>
								)}
								{f.kind === "file" && f.size > 0 && (
									<span className="skill-file-size">{formatBytes(f.size)}</span>
								)}
							</li>
						))}
					</ul>
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

/** sub-11: 文件大小人类可读展示(bytes → KB/MB)。 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

// sub-7: 从 git URL 安装第三方 skill 的弹窗。
//
// 协议:clone → auto-detect(根 + 一层子目录)→ 校验 → 重名整批拒绝 → 落 ~/.zero-core/skills。
// id 由后端从 repo 名 / 子目录名派生(path-safe),UI 不暴露 id 输入。
//
// 安全警示(对齐 design 安全段):远程代码,装前请审计来源。
function SkillInstallGitForm({
	installing,
	onCancel,
	onInstall,
}: {
	installing: boolean;
	onCancel: () => void;
	onInstall: (url: string) => void;
}) {
	const [url, setUrl] = useState("");
	// 简单 URL 校验:非空 + 以 http(s)/git/file 协议或 git@ scp 风格开头。
	const urlValid = (() => {
		const u = url.trim();
		if (u.length === 0) return false;
		return /^(https?:\/\/|git:\/\/|file:\/\/|ssh:\/\/|git@|[\w.-]+:[\w./-]+\/)/.test(u) ||
			// 本地路径(无协议):绝对路径驱动器(Win)或 / 开头(POSIX)
			/^[A-Za-z]:[\\/]/.test(u) || u.startsWith("/");
	})();

	return (
		<div className="skill-install-overlay">
			<div className="skill-install-modal">
				<div className="skill-install-header">
					<h3>Install skills from git</h3>
				</div>

				<div className="skill-install-warning">
					⚠ Remote code: skills are scripts the agent may run. Audit the source before installing.
				</div>

				<div className="skill-detail-field">
					<label className="skill-detail-label" htmlFor="skill-install-url">Git URL</label>
					<input
						id="skill-install-url"
						className="skill-input"
						type="text"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						placeholder="https://github.com/owner/skills-repo.git"
						disabled={installing}
						autoFocus
					/>
					{!urlValid && url.length > 0 && (
						<p className="skill-field-hint skill-field-hint-error">
							Enter a valid git URL (https://, git@, file://, or local path).
						</p>
					)}
					<p className="skill-field-hint">
						Detects skills at repo root and in direct subdirectories (one level, not nested).
						Ids come from the repo / subdirectory name. Existing ids reject the whole batch.
					</p>
				</div>

				<div className="skill-detail-actions">
					<button type="button" className="btn-ghost" onClick={onCancel} disabled={installing}>
						Cancel
					</button>
					<button
						type="button"
						className="btn-primary"
						onClick={() => onInstall(url.trim())}
						disabled={!urlValid || installing}
					>
						{installing ? "Installing…" : "Install"}
					</button>
				</div>
			</div>
		</div>
	);
}
