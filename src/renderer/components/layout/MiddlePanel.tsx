// 中间栏 —— 三段可折叠 + 可上下拖拽调高(WORKSPACE 文件目录 / WIKI 锚点 / TASKS 委派任务)
//
// # 文件说明书
//
// ## 核心功能
// chat 中间栏垂直堆叠三个段。每段标题点击切换折叠/展开;展开的相邻段之间有
// row-resize 拖拽条,可上下调高度(weights = flex-grow 权重,展开段始终填满栏)。
// 点文件/wiki/task 选中项分别通过 zero-file-select / zero-wiki-select /
// zero-task-select 派发到右侧 DocViewerPanel。
//
// ## 定位
// src/renderer/components/layout/ — 被 AppLayout 作为中间栏嵌入。
//
import React, { useRef, useState } from "react";
import FileTreePanel from "./FileTreePanel.js";
import WikiTreePanel from "./WikiTreePanel.js";
import TaskTreePanel from "./TaskTreePanel.js";

type SectionId = "workspace" | "wiki" | "tasks";

const SECTIONS: { id: SectionId; label: string }[] = [
	{ id: "workspace", label: "WORKSPACE · 文件" },
	{ id: "wiki", label: "WIKI · 锚点" },
	{ id: "tasks", label: "TASKS · 委派任务" },
];

const MIN_WEIGHT = 0.15;

export default function MiddlePanel() {
	// Default: workspace + wiki open, tasks collapsed. Sections persist for the
	// session via local state (no cross-session persistence needed for v1).
	const [open, setOpen] = useState<Record<SectionId, boolean>>({
		workspace: true,
		wiki: true,
		tasks: false,
	});
	// flex-grow weight per section (open sections share the column by weight;
	// drag splitters adjust the two adjacent weights). Collapsed sections ignore
	// their weight (flex: 0 0 auto).
	const [weights, setWeights] = useState<Record<SectionId, number>>({
		workspace: 1,
		wiki: 1,
		tasks: 1,
	});
	const panelRef = useRef<HTMLDivElement>(null);

	const toggle = (id: SectionId) => setOpen((s) => ({ ...s, [id]: !s[id] }));

	// Row-resize between two adjacent OPEN sections (a above, b below). Converts
	// the pixel drag delta into a weight-space delta so sections keep filling the
	// column while their proportions track the pointer.
	const startDrag = (a: SectionId, b: SectionId) => (e: React.MouseEvent) => {
		e.preventDefault();
		const startY = e.clientY;
		const panelH = panelRef.current?.clientHeight ?? 1;
		const startWeights = { ...weights };
		const totalOpen = SECTIONS.filter((s) => open[s.id]).reduce((sum, s) => sum + startWeights[s.id], 0) || 1;
		const onMove = (ev: MouseEvent) => {
			const dy = ev.clientY - startY;
			const k = (dy * totalOpen) / panelH; // weight-space delta
			let na = startWeights[a] + k;
			let nb = startWeights[b] - k;
			if (na < MIN_WEIGHT) { nb -= (MIN_WEIGHT - na); na = MIN_WEIGHT; }
			if (nb < MIN_WEIGHT) { na -= (MIN_WEIGHT - nb); nb = MIN_WEIGHT; }
			setWeights((w) => ({ ...w, [a]: na, [b]: nb }));
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			document.body.style.cursor = "";
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		document.body.style.cursor = "row-resize";
	};

	return (
		<div className="middle-panel middle-panel-stack" ref={panelRef}>
			{SECTIONS.map((sec, i) => {
				const isOpen = open[sec.id];
				const next = SECTIONS[i + 1];
				// Splitter only between two adjacent (in fixed order) OPEN sections.
				// A collapsed section between two open ones breaks the pair — its
				// header bounds them, so no direct splitter (expected).
				const showSplitter = isOpen && next && open[next.id];
				return (
					<React.Fragment key={sec.id}>
						<div
							className={`middle-section${isOpen ? " open" : " collapsed"}`}
							// Open sections size by weight (override the CSS flex:1 1 0 so
							// drag-adjusted proportions stick). Collapsed stays auto (undefined
							// inline style → CSS .collapsed flex:0 0 auto applies).
							style={isOpen ? { flex: `${weights[sec.id]} 1 0` } : undefined}
						>
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
						{showSplitter && (
							<div className="middle-splitter" onMouseDown={startDrag(sec.id, next.id)} />
						)}
					</React.Fragment>
				);
			})}
		</div>
	);
}
