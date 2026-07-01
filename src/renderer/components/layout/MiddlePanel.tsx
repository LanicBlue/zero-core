// 中间栏 —— 三段可折叠(WORKSPACE 文件目录 / WIKI 锚点 / TASKS 委派任务)
//
// # 文件说明书
//
// ## 核心功能
// chat 中间栏垂直堆叠三个可折叠段。每段标题点击切换折叠/展开,展开的段平分
// 可用高度。点文件/wiki/task 选中项分别通过 zero-file-select / zero-wiki-select /
// zero-task-select 派发到右侧 DocViewerPanel。
//
// ## 定位
// src/renderer/components/layout/ — 被 AppLayout 作为中间栏嵌入。
//
import React, { useState } from "react";
import FileTreePanel from "./FileTreePanel.js";
import WikiTreePanel from "./WikiTreePanel.js";
import TaskTreePanel from "./TaskTreePanel.js";

type SectionId = "workspace" | "wiki" | "tasks";

const SECTIONS: { id: SectionId; label: string }[] = [
	{ id: "workspace", label: "WORKSPACE · 文件" },
	{ id: "wiki", label: "WIKI · 锚点" },
	{ id: "tasks", label: "TASKS · 委派任务" },
];

export default function MiddlePanel() {
	// Default: workspace + wiki open, tasks collapsed. Sections persist for the
	// session via local state (no cross-session persistence needed for v1).
	const [open, setOpen] = useState<Record<SectionId, boolean>>({
		workspace: true,
		wiki: true,
		tasks: false,
	});

	const toggle = (id: SectionId) => setOpen((s) => ({ ...s, [id]: !s[id] }));

	return (
		<div className="middle-panel middle-panel-stack">
			{SECTIONS.map((sec) => {
				const isOpen = open[sec.id];
				return (
					<div key={sec.id} className={`middle-section${isOpen ? " open" : " collapsed"}`}>
						<button type="button" className="middle-section-header" onClick={() => toggle(sec.id)}>
							<span className={`middle-section-caret${isOpen ? " open" : ""}`}>▸</span>
							<span>{sec.label}</span>
						</button>
						{isOpen && (
							<div className="middle-section-body">
								{sec.id === "workspace" && <FileTreePanel />}
								{sec.id === "wiki" && <WikiTreePanel />}
								{sec.id === "tasks" && <TaskTreePanel />}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
