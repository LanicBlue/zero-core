import React, { useState } from "react";
import { useKbStore } from "../../store/kb-store.js";
import type { KnowledgeBase, KbFileInfo } from "../../../shared/types.js";

type Tab = "list" | "create" | "detail";

export default function KnowledgeBasePage() {
	const { knowledgeBases, loading, create, remove, addFiles, removeFile } = useKbStore();
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

	const selected = selectedId ? knowledgeBases.find((kb) => kb.id === selectedId) : null;

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

	return (
		<div className="kb-page">
			<div className="kb-page-header">
				<h2>Knowledge Base</h2>
				{tab === "list" && (
					<button type="button" className="btn-primary" onClick={() => setTab("create")}>
						+ New
					</button>
				)}
				{tab !== "list" && (
					<button type="button" className="btn-ghost" onClick={() => { setTab("list"); setSelectedId(null); }}>
						Back
					</button>
				)}
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
		</div>
	);
}
