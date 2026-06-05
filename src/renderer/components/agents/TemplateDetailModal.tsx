// 模板详情弹窗组件
//
// # 文件说明书
//
// ## 核心功能
// 以弹窗形式展示模板的完整详情（含 Markdown 预览）
//
// ## 输入
// PromptTemplate 数据
//
// ## 输出
// 模板详情弹窗 JSX
//
// ## 定位
// src/renderer/components/agents/ — Agent 页面组件，模板详情查看
//
// ## 依赖
// React、shared/types.ts、common/MarkdownRenderer.tsx
//
// ## 维护规则
// 详情展示字段变更需同步更新渲染逻辑
//
import React, { useMemo } from "react";
import type { PromptTemplate } from "../../../shared/types.js";
import MarkdownRenderer from "../common/MarkdownRenderer.js";

interface Props {
	template: PromptTemplate;
	onUse: () => void;
	onExport: () => void;
	onClose: () => void;
}

export default function TemplateDetailModal({ template, onUse, onExport, onClose }: Props) {
	const tokenEstimate = useMemo(() => {
		const text = template.systemPrompt || "";
		const charCount = text.length;
		const wordCount = text.split(/\s+/).filter(Boolean).length;
		const tokens = Math.ceil(charCount / 4);
		if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k`;
		return `~${tokens}`;
	}, [template.systemPrompt]);
	return (
		<div className="modal-overlay">
			<div className="modal-content modal-detail" onClick={(e) => e.stopPropagation()}>
				<div className="modal-header">
					<div className="modal-detail-title">
						{template.color && <span className="modal-detail-color-dot" style={{ backgroundColor: template.color }} />}
						<span className="template-card-icon">{template.icon || "📄"}</span>
						<h3>{template.name}</h3>
					</div>
					<button type="button" className="btn-ghost btn-sm" onClick={onClose}>X</button>
				</div>
				<div className="modal-body">
					{template.description && (
						<div className="modal-detail-section">
							<p className="modal-detail-desc">{template.description}</p>
						</div>
					)}

					{template.tags.length > 0 && (
						<div className="modal-detail-section">
							<label className="modal-detail-label">Tags</label>
							<div className="template-card-tags">
								{template.tags.map((tag) => (
									<span key={tag} className="template-tag">{tag}</span>
								))}
							</div>
						</div>
					)}

					{template.recommendedTools && template.recommendedTools.length > 0 && (
						<div className="modal-detail-section">
							<label className="modal-detail-label">Recommended Tools</label>
							<div className="modal-detail-tools">
								{template.recommendedTools.map((tool) => (
									<span key={tool} className="modal-detail-tool-badge">{tool}</span>
								))}
							</div>
						</div>
					)}

					{(template.model || template.provider) && (
						<div className="modal-detail-section">
							<label className="modal-detail-label">Model</label>
							<p className="modal-detail-text">{template.provider || "default"} / {template.model || "default"}</p>
						</div>
					)}

					{template.sourceUrl && (
						<div className="modal-detail-section">
							<label className="modal-detail-label">Source</label>
							<p className="modal-detail-text modal-detail-url">{template.sourceUrl}</p>
						</div>
					)}

					{template.isBuiltIn && (
						<div className="modal-detail-section">
							<span className="modal-detail-badge">Built-in</span>
						</div>
					)}

					<div className="modal-detail-section">
						<div className="modal-detail-label-row">
							<label className="modal-detail-label">System Prompt</label>
							<span className="modal-detail-token-badge">{tokenEstimate} tokens</span>
						</div>
						<div className="modal-detail-prompt">
							<MarkdownRenderer content={template.systemPrompt} />
						</div>
					</div>

					<div className="modal-actions">
						<button type="button" className="btn-ghost" onClick={onClose}>Close</button>
						<button type="button" className="btn-ghost" onClick={onExport}>Export</button>
						<button type="button" className="btn-primary" onClick={onUse}>Use Template</button>
					</div>
				</div>
			</div>
		</div>
	);
}
