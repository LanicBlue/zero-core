import React, { useRef, useCallback } from "react";

interface Props {
	children: React.ReactNode[];
	defaults: number[]; // initial widths in px
	mins: number[]; // min widths in px
}

/**
 * Horizontal resizable panel layout.
 * Renders N children separated by draggable dividers.
 */
export default function ResizableLayout({ children, defaults, mins }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const widthsRef = useRef<number[]>(defaults.slice());
	// Track positions for drag calculation
	const dragRef = useRef<{
		index: number; // which divider (0 = between child 0 and 1)
		startX: number;
		startWidths: number[];
	} | null>(null);

	const handleMouseDown = useCallback((index: number) => (e: React.MouseEvent) => {
		e.preventDefault();
		dragRef.current = {
			index,
			startX: e.clientX,
			startWidths: widthsRef.current.slice(),
		};

		const handleMouseMove = (ev: MouseEvent) => {
			if (!dragRef.current || !containerRef.current) return;
			const { index: idx, startX, startWidths } = dragRef.current;
			const dx = ev.clientX - startX;

			const newLeft = startWidths[idx] + dx;
			const newRight = startWidths[idx + 1] - dx;

			if (newLeft >= mins[idx] && newRight >= mins[idx + 1]) {
				const updated = startWidths.slice();
				updated[idx] = newLeft;
				updated[idx + 1] = newRight;
				widthsRef.current = updated;
				applyWidths(containerRef.current!, updated);
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
	}, [mins]);

	const panels: React.ReactNode[] = [];
	for (let i = 0; i < children.length; i++) {
		panels.push(
			<div
				key={`panel-${i}`}
				className="resizable-panel"
				style={{ width: defaults[i], minWidth: mins[i] }}
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

function applyWidths(container: HTMLElement, widths: number[]): void {
	let panelIdx = 0;
	for (let i = 0; i < container.children.length; i++) {
		const el = container.children[i] as HTMLElement;
		if (el.classList.contains("resizable-panel")) {
			el.style.width = `${widths[panelIdx]}px`;
			panelIdx++;
		}
	}
}
