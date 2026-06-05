// Agent 权限配置区段
//
// # 文件说明书
//
// ## 核心功能
// 在 Agent 编辑器中管理工具执行权限策略（toolPolicy）
//
// ## 输入
// FormState 中的 toolPolicy、更新回调
//
// ## 输出
// 权限配置表单 JSX
//
// ## 定位
// src/renderer/components/agents/ — Agent 编辑器的子区段
//
// ## 依赖
// agent-editor-types.ts
//
// ## 维护规则
// 权限策略字段变更需同步更新 toolPolicy 类型
//
import type { FormState } from "./agent-editor-types.js";

interface Props {
	form: FormState;
	updateToolPolicy: (patch: Partial<NonNullable<FormState["toolPolicy"]>>) => void;
}

export function PermissionsSection({ form, updateToolPolicy }: Props) {
	return (
		<div className="editor-section">
			<h4 className="section-title">权限范围</h4>
			<label>读取范围
				<select
					value={form.toolPolicy?.readScope ?? "filesystem"}
					onChange={(e) => updateToolPolicy({ readScope: e.target.value as "filesystem" | "workspace" })}
				>
					<option value="filesystem">整个文件系统</option>
					<option value="workspace">仅工作目录</option>
				</select>
			</label>
			<label>执行模式
				<select
					value={form.toolPolicy?.executionMode ?? ""}
					onChange={(e) => updateToolPolicy({ executionMode: (e.target.value || undefined) as "sequential" | "parallel" | undefined })}
				>
					<option value="">并行 (默认)</option>
					<option value="sequential">顺序</option>
					<option value="parallel">并行</option>
				</select>
			</label>
			<p className="section-desc">写/改/删工具始终限制在工作目录内</p>
		</div>
	);
}
