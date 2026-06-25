// 知识库与记忆浏览页面
//
// # 文件说明书
//
// ## 核心功能
// 知识库管理页面，提供 Libraries（RAG 知识库 CRUD + 文件导入）和 Memory（记忆节点浏览/搜索/删除）两个 Tab，并展示嵌入提供商配置。
//
// ## 输入
// - kbStore (Zustand)：knowledgeBases / loading / create / remove / addFiles / removeFile
// - window.api.memoryNode*：记忆节点的 subject / list / search / delete 接口
//
// ## 输出
// - 渲染的页面 DOM（列表 / 创建表单 / 详情 / 记忆面板）
//
// ## 定位
// 渲染进程组件，被 AppLayout 路由到 kb 页面时加载。
//
// ## 依赖
// - react
// - ../../store/kb-store
// - ../../../shared/types (KnowledgeBase / KbFileInfo)
// - window.api（preload 暴露的记忆节点接口）
//
// ## 维护规则
// - 记忆节点接口或 kbStore 行为变化时同步本组件。
// - 新增知识库字段（如 chunk 策略）时需要扩展创建表单与详情展示。
//
import React, { useState, useEffect } from "react";
import { useKbStore } from "../../store/kb-store.js";
import type { KnowledgeBase, KbFileInfo } from "../../../shared/types.js";

const api = () => (window as any).api;

type Tab = "list" | "create" | "detail" | "memory";

interface MemoryNode {
	id: string;
	subject: string;
	type: string;
	content: string;
	updatedAt: string;
}

interface MemorySubject {
	subject: string;
	nodeCount: number;
	latestUpdate: string;
}

export default function KnowledgeBasePage() {
	const { knowledgeBases, loading, create, remove, addFiles, removeFile, fetchList } = useKbStore();
	// Fetch the KB list on page mount (lazy, not at app startup).
	useEffect(() => { void fetchList(); }, [fetchList]);
	const [tab, setTab] = useState<Tab>("list");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [form, setForm] = useState({
		name: "",
		description: "",
		embeddingProvider: "openai" as "openai" | "ollama",
		embeddingModel: "text-embedding-3-small",
	});
	const [addFilePath, setAddFilePath] = useState("");
	const [ingesting, setIngesting] = useState(false);

	// Memory state
	const [memorySubjects, setMemorySubjects] = useState<MemorySubject[]>([]);
	const [memoryNodes, setMemoryNodes] = useState<MemoryNode[]>([]);
	const [expandedSubject, setExpandedSubject] = useState<string | null>(null);
	const [subjectNodes, setSubjectNodes] = useState<MemoryNode[]>([]);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<MemoryNode[] | null>(null);

	const selected = selectedId ? knowledgeBases.find((kb) => kb.id === selectedId) : null;

	const loadMemorySubjects = async () => {
		try {
			const subjects = await api().memoryNodeSubjects();
			setMemorySubjects(subjects);
		} catch { /* ignore */ }
	};

	const loadRecentNodes = async () => {
		try {
			const nodes = await api().memoryNodeList(50);
			setMemoryNodes(nodes);
		} catch { /* ignore */ }
	};

	const handleMemoryTab = async () => {
		setTab("memory");
		setSearchResults(null);
		await Promise.all([loadMemorySubjects(), loadRecentNodes()]);
	};

	const handleSubjectExpand = async (subject: string) => {
		if (expandedSubject === subject) {
			setExpandedSubject(null);
			setSubjectNodes([]);
			return;
		}
		setExpandedSubject(subject);
		try {
			const result = await api().memoryNodeSubjectNodes(subject);
			setSubjectNodes(result.nodes ?? []);
		} catch { /* ignore */ }
	};

	const handleMemorySearch = async () => {
		if (!searchQuery.trim()) {
			setSearchResults(null);
			return;
		}
		try {
			const results = await api().memoryNodeSearch(searchQuery.trim());
			setSearchResults(results);
		} catch { /* ignore */ }
	};

	const handleDeleteNode = async (id: string) => {
		try {
			await api().memoryNodeDelete(id);
			await Promise.all([loadMemorySubjects(), loadRecentNodes()]);
			if (expandedSubject) {
				const result = await api().memoryNodeSubjectNodes(expandedSubject);
				setSubjectNodes(result.nodes ?? []);
			}
			if (searchResults) {
				setSearchResults(searchResults.filter((n: MemoryNode) => n.id !== id));
			}
		} catch { /* ignore */ }
	};

	const handleCreate = async (e: React.FormEvent) => {
		e.preventDefault();
		const created = await create({
			name: form.name,
			description: form.description,
			embeddingProvider: form.embeddingProvider,
			embeddingModel: form.embeddingModel,
			agentIds: [],
			files: [],
		});
		setSelectedId(created.id);
		setTab("detail");
		setForm({ name: "", description: "", embeddingProvider: "openai", embeddingModel: "text-embedding-3-small" });
	};

	const handleAddFile = async () => {
		if (!selectedId || !addFilePath.trim()) return;
		setIngesting(true);
		try {
			await addFiles(selectedId, [addFilePath.trim()]);
			setAddFilePath("");
		} finally {
			setIngesting(false);
		}
	};

	const handleDelete = async (id: string) => {
		await remove(id);
		if (selectedId === id) {
			setSelectedId(null);
			setTab("list");
		}
	};

	const formatSize = (bytes: number) => {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	};

	const typeBadge = (type: string) => {
		return <span className={`memory-type-badge type-${type}`}>{type.replace("_", " ")}</span>;
	};

	return (
		<div className="kb-page">
			<div className="kb-page-header">
				<h2>Knowledge Base</h2>
				<div className="kb-header-spacer" />
				{(tab === "list") && (
					<button type="button" className="btn-primary" onClick={() => setTab("create")}>
						+ New
					</button>
				)}
				{(tab === "create" || tab === "detail") && (
					<button type="button" className="btn-ghost" onClick={() => { setTab("list"); setSelectedId(null); }}>
						Back
					</button>
				)}
			</div>
			<div className="kb-page-tabs">
				<button type="button" className={`kb-tab-btn ${tab === "list" || tab === "create" || tab === "detail" ? "active" : ""}`} onClick={() => setTab("list")}>
					Libraries
				</button>
				<button type="button" className={`kb-tab-btn ${tab === "memory" ? "active" : ""}`} onClick={handleMemoryTab}>
					Memory
				</button>
			</div>

			{tab === "create" && (
				<form className="kb-create-form" onSubmit={handleCreate}>
					<label>Name
						<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="e.g. Project Docs" />
					</label>
					<label>Description
						<input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Optional description" />
					</label>
					<label>Embedding Provider
						<select value={form.embeddingProvider} onChange={(e) => {
							const provider = e.target.value as "openai" | "ollama";
							setForm({
								...form,
								embeddingProvider: provider,
								embeddingModel: provider === "ollama" ? "nomic-embed-text" : "text-embedding-3-small",
							});
						}}>
							<option value="openai">OpenAI / Compatible</option>
							<option value="ollama">Ollama (Local)</option>
						</select>
					</label>
					<label>Embedding Model
						<input value={form.embeddingModel} onChange={(e) => setForm({ ...form, embeddingModel: e.target.value })} />
					</label>
					<button type="submit" className="btn-primary">Create</button>
				</form>
			)}

			{tab === "detail" && selected && (
				<div className="kb-detail">
					<div className="kb-detail-header">
						<div>
							<h3>{selected.name}</h3>
							<p className="kb-detail-desc">{selected.description}</p>
							<p className="kb-detail-meta">
								{selected.embeddingProvider}/{selected.embeddingModel} &middot; {selected.files.length} file(s)
							</p>
						</div>
						<button type="button" className="btn-danger btn-sm" onClick={() => handleDelete(selected.id)}>
							Delete
						</button>
					</div>

					<div className="kb-add-file">
						<input
							value={addFilePath}
							onChange={(e) => setAddFilePath(e.target.value)}
							placeholder="File or directory path..."
							disabled={ingesting}
						/>
						<button type="button" className="btn-primary btn-sm" onClick={handleAddFile} disabled={ingesting || !addFilePath.trim()}>
							{ingesting ? "Ingesting..." : "Add"}
						</button>
					</div>

					<div className="kb-file-list">
						{selected.files.length === 0 && (
							<p className="agents-empty">No files added yet. Add files to build the knowledge base.</p>
						)}
						{selected.files.map((file) => (
							<div key={file.path} className="kb-file-item">
								<div className="kb-file-info">
									<span className="kb-file-name">{file.name}</span>
									<span className="kb-file-meta">{formatSize(file.size)} &middot; {file.chunks} chunks</span>
								</div>
								<button
									type="button"
									className="btn-ghost btn-sm"
									onClick={() => removeFile(selected.id, file.path)}
								>
									Remove
								</button>
							</div>
						))}
					</div>
				</div>
			)}

			{tab === "list" && (
				<div className="kb-grid">
					{loading && <p className="agents-empty">Loading...</p>}
					{!loading && knowledgeBases.length === 0 && (
						<p className="agents-empty">No knowledge bases yet. Create one to enable RAG for your agents.</p>
					)}
					{knowledgeBases.map((kb) => (
						<div key={kb.id} className="kb-card" onClick={() => { setSelectedId(kb.id); setTab("detail"); }}>
							<div className="kb-card-name">{kb.name}</div>
							<div className="kb-card-desc">{kb.description || "No description"}</div>
							<div className="kb-card-meta">
								<span>{kb.files.length} file(s)</span>
								<span>{kb.embeddingProvider}</span>
							</div>
						</div>
					))}
				</div>
			)}

			{tab === "memory" && (
				<div className="memory-page-content">
					<div className="memory-search-bar">
						<input
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleMemorySearch()}
							placeholder="Search memory nodes..."
							className="memory-search-input"
						/>
						<button type="button" className="btn-primary btn-sm" onClick={handleMemorySearch} disabled={!searchQuery.trim()}>
							Search
						</button>
						{searchResults !== null && (
							<button type="button" className="btn-ghost btn-sm" onClick={() => { setSearchResults(null); setSearchQuery(""); }}>
								Clear
							</button>
						)}
					</div>

					<div className="memory-stats">
						<span>{memorySubjects.length} subjects</span>
						<span>{memoryNodes.length} nodes</span>
					</div>

					{searchResults !== null ? (
						<div className="memory-node-list">
							{searchResults.length === 0 && <p className="agents-empty">No results found.</p>}
							{searchResults.map((node) => (
								<div key={node.id} className="memory-node-card">
									<div className="memory-node-header">
										{typeBadge(node.type)}
										<span className="memory-node-subject">{node.subject}</span>
										<span className="memory-node-date">{node.updatedAt.slice(0, 10)}</span>
										<button type="button" className="btn-ghost btn-sm" onClick={() => handleDeleteNode(node.id)}>Delete</button>
									</div>
									<p className="memory-node-content">{node.content}</p>
								</div>
							))}
						</div>
					) : (
						<>
							<div className="memory-subjects">
								{memorySubjects.length === 0 && (
									<p className="agents-empty">No memory nodes yet. Enable Memory & Compression in Settings to start building memories from conversations.</p>
								)}
								{memorySubjects.map((s) => (
									<div key={s.subject} className="memory-subject-card">
										<div className="memory-subject-header" onClick={() => handleSubjectExpand(s.subject)}>
											<span className="memory-subject-name">{s.subject}</span>
											<span className="memory-subject-count">{s.nodeCount} node(s)</span>
											<span className="memory-subject-date">{s.latestUpdate.slice(0, 10)}</span>
											<span className="memory-subject-expand">{expandedSubject === s.subject ? "▲" : "▼"}</span>
										</div>
										{expandedSubject === s.subject && (
											<div className="memory-subject-nodes">
												{subjectNodes.map((node) => (
													<div key={node.id} className="memory-node-card">
														<div className="memory-node-header">
															{typeBadge(node.type)}
															<span className="memory-node-date">{node.updatedAt.slice(0, 10)}</span>
															<button type="button" className="btn-ghost btn-sm" onClick={() => handleDeleteNode(node.id)}>Delete</button>
														</div>
														<p className="memory-node-content">{node.content}</p>
													</div>
												))}
											</div>
										)}
									</div>
								))}
							</div>

							{memoryNodes.length > 0 && memorySubjects.length > 0 && (
								<>
									<h3 className="memory-recent-title">Recent Nodes</h3>
									<div className="memory-node-list">
										{memoryNodes.slice(0, 10).map((node) => (
											<div key={node.id} className="memory-node-card">
												<div className="memory-node-header">
													{typeBadge(node.type)}
													<span className="memory-node-subject">{node.subject}</span>
													<span className="memory-node-date">{node.updatedAt.slice(0, 10)}</span>
													<button type="button" className="btn-ghost btn-sm" onClick={() => handleDeleteNode(node.id)}>Delete</button>
												</div>
												<p className="memory-node-content">{node.content}</p>
											</div>
										))}
									</div>
								</>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}
