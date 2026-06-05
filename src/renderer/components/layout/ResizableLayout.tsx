// 可调整大小的分割布局组件
//
// # 文件说明书
//
// ## 核心功能
// 提供可拖拽调整比例的多面板分割布局
//
// ## 输入
// 子组件数组、默认比例权重
//
// ## 输出
// 可拖拽分割的多面板布局 JSX
//
// ## 定位
// src/renderer/components/layout/ — 布局组件，支撑主界面三栏布局
//
// ## 依赖
// React
//
// ## 维护规则
// 拖拽交互和面板比例计算逻辑变更需充分测试
//
import React, { useRef, useCallback, useEffect, useState } from "react";

interface Props {
	children: React.ReactNode[];
	defaults: number[]; // proportion weights (e.g. [4, 2, 4])
	mins: number[]; // min widths in px
}

export default function ResizableLayout({ children, defaults, mins }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [widths, setWidths] = useState<number[]>([]);
	const totalWeight = defaults.reduce((a, b) => a + b, 0);
	const dragRef = useRef<{
		index: number;
		startX: number;
		startWidths: number[];
		containerWidth: number;
	} | null>(null);

	// Calculate initial widths from container size
	useEffect(() => {
		if (!containerRef.current) return;
		const containerWidth = containerRef.current.clientWidth;
		const totalMins = mins.reduce((a, b) => a + b, 0);
		const dividerSpace = (children.length - 1) * 4; // divider widths
		const available = containerWidth - dividerSpace;

		// If available space is too small, fall back to mins
		if (available <= totalMins) {
			setWidths(mins.slice());
			return;
		}

		const calculated = defaults.map((w, i) => {
			const fromWeight = Math.round((w / totalWeight) * available);
			return Math.max(fromWeight, mins[i]);
		});
		setWidths(calculated);
	}, []); // only on mount

	const handleMouseDown = useCallback((index: number) => (e: React.MouseEvent) => {
		e.preventDefault();
		if (!containerRef.current) return;
		dragRef.current = {
			index,
			startX: e.clientX,
			startWidths: widths.slice(),
			containerWidth: containerRef.current.clientWidth,
		};

		const handleMouseMove = (ev: MouseEvent) => {
			if (!dragRef.current || !containerRef.current) return;
			const { index: idx, startX, startWidths, containerWidth } = dragRef.current;
			const dx = ev.clientX - startX;

			const totalDividers = (children.length - 1) * 4;
			const totalAvailable = containerWidth - totalDividers;

			const newLeft = startWidths[idx] + dx;
			const newRight = startWidths[idx + 1] - dx;

			// Constrain to min sizes
			if (newLeft >= mins[idx] && newRight >= mins[idx + 1]) {
				const updated = startWidths.slice();
				updated[idx] = newLeft;
				updated[idx + 1] = newRight;
				setWidths(updated);
			}
		};

		const handleMouseUp = () => {
			dragRef.current = null;
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};

		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
	}, [widths, mins, children.length]);

	if (widths.length === 0) {
		// Render placeholder to measure container
		return <div ref={containerRef} className="resizable-layout" />;
	}

	const panels: React.ReactNode[] = [];
	for (let i = 0; i < children.length; i++) {
		panels.push(
			<div
				key={`panel-${i}`}
				className="resizable-panel"
				style={{ width: widths[i], minWidth: mins[i] }}
			>
				{children[i]}
			</div>,
		);
		if (i < children.length - 1) {
			panels.push(
				<div
					key={`divider-${i}`}
					className="resizable-divider"
					onMouseDown={handleMouseDown(i)}
				/>,
			);
		}
	}

	return (
		<div ref={containerRef} className="resizable-layout">
			{panels}
		</div>
	);
}
