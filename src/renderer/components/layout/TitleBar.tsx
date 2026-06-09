import React from "react";

const api = () => (window as any).api;

export default function TitleBar() {
	const platform = api()?.platform ?? "win32";
	const showControls = platform === "win32" || platform === "linux";

	return (
		<div className="title-bar">
			<span className="title-bar-name">Zero-Core</span>
			{showControls && (
				<div className="title-bar-controls">
					<button
						type="button"
						className="title-bar-btn title-bar-btn-minimize"
						onClick={() => api()?.windowMinimize?.()}
						aria-label="Minimize"
					>
						&#x2500;
					</button>
					<button
						type="button"
						className="title-bar-btn title-bar-btn-maximize"
						onClick={() => api()?.windowMaximize?.()}
						aria-label="Maximize"
					>
						&#x25A1;
					</button>
					<button
						type="button"
						className="title-bar-btn title-bar-btn-close"
						onClick={() => api()?.windowClose?.()}
						aria-label="Close"
					>
						&#x2715;
					</button>
				</div>
			)}
		</div>
	);
}
