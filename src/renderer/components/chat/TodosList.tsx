// TodoWrite 待办列表组件
//
// # 文件说明书
//
// ## 核心功能
// 显示 Agent 创建的待办事项列表及其状态
//
// ## 输入
// TodoItem 数组（内容、状态）
//
// ## 输出
// 带状态标记的待办列表 JSX
//
// ## 定位
// src/renderer/components/chat/ — 聊天组件，显示 Agent 任务进度
//
// ## 依赖
// React、store/interaction-store.ts
//
// ## 维护规则
// 任务状态类型变更需同步更新渲染逻辑
//
import React from "react";
import type { TodoItem } from "../../store/interaction-store.js";

interface Props {
	todos: TodoItem[];
}

export default function TodosList({ todos }: Props) {
	if (todos.length === 0) return null;

	const completed = todos.filter((t) => t.status === "completed").length;
	const progress = Math.round((completed / todos.length) * 100);

	return (
		<div className="todos-list">
			<div className="todos-header">
				<span className="todos-title">Tasks</span>
				<span className="todos-progress">{completed}/{todos.length} ({progress}%)</span>
			</div>
			<div className="todos-bar">
				<div className="todos-bar-fill" style={{ width: `${progress}%` }} />
			</div>
			<div className="todos-items">
				{todos.map((todo, i) => (
					<div key={i} className={`todos-item ${todo.status}`}>
						<span className="todos-status">
							{todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▶" : "○"}
						</span>
						<span className="todos-text">
							{todo.status === "in_progress" ? todo.activeForm : todo.content}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}
