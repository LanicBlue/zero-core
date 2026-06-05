// 模板卡片组件
//
// # 文件说明书
//
// ## 核心功能
// 以卡片形式展示单个 Agent 模板的摘要信息
//
// ## 输入
// PromptTemplate 数据
//
// ## 输出
// 模板卡片 JSX（含名称、描述、操作按钮）
//
// ## 定位
// src/renderer/components/agents/ — Agent 页面组件，用于模板列表展示
//
// ## 依赖
// React、shared/types.ts
//
// ## 维护规则
// 模板字段变更需更新卡片展示内容
//
import React from "react";
import type { PromptTemplate } from "../../../shared/types.js";

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
