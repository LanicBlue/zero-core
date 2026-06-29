// 中间栏 —— 上下两段(文件目录 + Wiki 节点)
//
// # 文件说明书
//
// ## 核心功能
// chat 中间栏垂直分割:上段 FileTreePanel(文件目录),下段 WikiTreePanel
// (wiki 节点)。中间一条可拖拽的横向分隔条,控制上段高度百分比(15%~85%)。
// 两段都能把选中项送到右侧 DocViewerPanel(文件走 zero-file-select,wiki
// 走 zero-wiki-select)。
//
// ## 定位
// src/renderer/components/layout/ — 被 AppLayout 作为中间栏嵌入(取代裸
// FileTreePanel)。
//
import React, { useCallback, useRef, useState } from "react";
import FileTreePanel from "./FileTreePanel.js";
import WikiTreePanel from "./WikiTreePanel.js";

export default function MiddlePanel() {
	const containerRef = useRef<HTMLDivElement>(null);
	const [topPct, setTopPct] = useState(50);

	const onSplitterDown = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		const el = containerRef.current;
		if (!el) return;
		const start = { startY: e.clientY, h: el.clientHeight, pct: topPct };
		const move = (ev: MouseEvent) => {
			if (!el) return;
			const dy = ev.clientY - start.startY;
			const next = Math.min(85, Math.max(15, start.pct + (dy / start.h) * 100));
			setTopPct(next);
		};
		const up = () => {
			document.removeEventListener("mousemove", move);
			document.removeEventListener("mouseup", up);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};
		document.body.style.cursor = "row-resize";
		document.body.style.userSelect = "none";
		document.addEventListener("mousemove", move);
		document.addEventListener("mouseup", up);
	}, [topPct]);

	return (
		<div ref={containerRef} className="middle-panel">
			<div className="middle-pane" style={{ height: `${topPct}%` }}>
				<FileTreePanel />
			</div>
			<div className="middle-splitter" onMouseDown={onSplitterDown} />
			<div className="middle-pane" style={{ height: `${100 - topPct}%` }}>
				<WikiTreePanel />
			</div>
		</div>
	);
}
