import React from "react";
import type { PromptTemplate } from "../../store/template-store.js";

interface Props {
	template: PromptTemplate;
	onUse: (template: PromptTemplate) => void;
	onExport?: (template: PromptTemplate) => void;
	onDetail?: (template: PromptTemplate) => void;
	onDelete?: (template: PromptTemplate) => void;
}

export default function TemplateCard({ template, onUse, onExport, onDetail, onDelete }: Props) {
	return (
		<div className="template-card">
			<div className="template-card-icon">{template.icon || "📄"}</div>
			<div className="template-card-body">
				<div className="template-card-name">{template.name}</div>
				<div className="template-card-desc">{template.description}</div>
				{template.tags.length > 0 && (
					<div className="template-card-tags">
						{template.tags.map((tag) => (
							<span key={tag} className="template-tag">{tag}</span>
						))}
					</div>
				)}
			</div>
			<div className="template-card-actions">
				<button type="button" className="btn-primary btn-sm" onClick={() => onUse(template)}>
					Use
				</button>
				{onDetail && (
					<button type="button" className="btn-ghost btn-sm" onClick={() => onDetail(template)}>
						Detail
					</button>
				)}
				{onExport && (
					<button type="button" className="btn-ghost btn-sm" onClick={() => onExport(template)}>
						Export
					</button>
				)}
				{onDelete && !template.isBuiltIn && (
					<button type="button" className="btn-danger btn-sm" onClick={() => onDelete(template)}>
						Delete
					</button>
				)}
			</div>
		</div>
	);
}
