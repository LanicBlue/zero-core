import React, { useState, useMemo, useRef } from "react";
import { useTemplateStore, type PromptTemplate } from "../../store/template-store.js";
import TemplateCard from "./TemplateCard.js";

interface Props {
	onUseTemplate: (template: PromptTemplate) => void;
}

export default function TemplateGallery({ onUseTemplate }: Props) {
	const { templates, loading, importTemplate } = useTemplateStore();
	const [search, setSearch] = useState("");
	const [activeTag, setActiveTag] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const allTags = useMemo(() => {
		const tagSet = new Set<string>();
		for (const t of templates) {
			for (const tag of t.tags) tagSet.add(tag);
		}
		return Array.from(tagSet).sort();
	}, [templates]);

	const filtered = useMemo(() => {
		let result = templates;
		if (activeTag) {
			result = result.filter((t) => t.tags.includes(activeTag));
		}
		if (search.trim()) {
			const q = search.toLowerCase();
			result = result.filter(
				(t) =>
					t.name.toLowerCase().includes(q) ||
					t.description.toLowerCase().includes(q) ||
					t.tags.some((tag) => tag.toLowerCase().includes(q)),
			);
		}
		return result;
	}, [templates, search, activeTag]);

	const handleExport = async (template: PromptTemplate) => {
		try {
			const json = await (window as any).api.templatesExport(template.id);
			const blob = new Blob([json], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `template-${template.name.toLowerCase().replace(/\s+/g, "-")}.json`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			console.error("Export failed:", err);
		}
	};

	const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		try {
			const text = await file.text();
			await importTemplate(text);
		} catch (err) {
			console.error("Import failed:", err);
		}
		if (fileInputRef.current) fileInputRef.current.value = "";
	};

	if (loading) {
		return <div className="template-gallery"><p className="agents-empty">Loading templates...</p></div>;
	}

	return (
		<div className="template-gallery">
			<div className="template-gallery-toolbar">
				<input
					type="text"
					className="template-search"
					placeholder="Search templates..."
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
				<button type="button" className="btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()}>
					Import
				</button>
				<input
					ref={fileInputRef}
					type="file"
					accept=".json"
					style={{ display: "none" }}
					onChange={handleImport}
				/>
			</div>

			{allTags.length > 0 && (
				<div className="template-tags-filter">
					<button
						type="button"
						className={`template-tag-filter-btn ${!activeTag ? "active" : ""}`}
						onClick={() => setActiveTag(null)}
					>
						All
					</button>
					{allTags.map((tag) => (
						<button
							key={tag}
							type="button"
							className={`template-tag-filter-btn ${activeTag === tag ? "active" : ""}`}
							onClick={() => setActiveTag(activeTag === tag ? null : tag)}
						>
							{tag}
						</button>
					))}
				</div>
			)}

			<div className="template-grid">
				{filtered.map((t) => (
					<TemplateCard key={t.id} template={t} onUse={onUseTemplate} onExport={handleExport} />
				))}
				{filtered.length === 0 && (
					<p className="agents-empty">No templates match your search.</p>
				)}
			</div>
		</div>
	);
}
