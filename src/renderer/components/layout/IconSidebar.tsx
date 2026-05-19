import React from "react";
import { usePageStore } from "../../store/page-store.js";
import { useThemeStore } from "../../store/theme-store.js";

export default function IconSidebar() {
	const { activePage, setActivePage } = usePageStore();
	const { mode, setMode } = useThemeStore();

	const cycleTheme = () => {
		const next = mode === "dark" ? "light" : mode === "light" ? "system" : "dark";
		setMode(next);
	};

	const themeIcon = mode === "dark"
		? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
		: mode === "light"
			? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>
			: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>;

	return (
		<nav className="icon-sidebar">
			<div className="icon-sidebar-top">
				<button
					type="button"
					className={`icon-btn ${activePage === "chat" ? "active" : ""}`}
					onClick={() => setActivePage("chat")}
					title="Chat"
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
						<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
					</svg>
				</button>
				<button
					type="button"
					className={`icon-btn ${activePage === "agents" ? "active" : ""}`}
					onClick={() => setActivePage("agents")}
					title="Agents"
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
						<rect x="5" y="8" width="14" height="12" rx="3" />
						<circle cx="9.5" cy="14" r="1.5" fill="currentColor" />
						<circle cx="14.5" cy="14" r="1.5" fill="currentColor" />
						<path d="M10 17h4" />
						<path d="M12 2v3" />
						<path d="M9 5h6" />
						<path d="M3 12h2" />
						<path d="M19 12h2" />
					</svg>
				</button>
				<button
					type="button"
					className={`icon-btn ${activePage === "mcp" ? "active" : ""}`}
					onClick={() => setActivePage("mcp")}
					title="MCP Servers"
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
						<rect x="2" y="2" width="20" height="8" rx="2" />
						<rect x="2" y="14" width="20" height="8" rx="2" />
						<circle cx="6" cy="6" r="1" fill="currentColor" />
						<circle cx="6" cy="18" r="1" fill="currentColor" />
					</svg>
				</button>
			<button
				type="button"
				className={}
				onClick={() => setActivePage("knowledge")}
				title="Knowledge Base"
			>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
					<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
					<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
				</svg>
			</button>
			</div>
			<div className="icon-sidebar-bottom">
				<button
					type="button"
					className="icon-btn"
					onClick={cycleTheme}
					title={`Theme: ${mode}`}
				>
					{themeIcon}
				</button>
				<button
					type="button"
					className={`icon-btn ${activePage === "settings" ? "active" : ""}`}
					onClick={() => setActivePage("settings")}
					title="Settings"
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
						<circle cx="12" cy="12" r="3" />
						<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
					</svg>
				</button>
			</div>
		</nav>
	);
}
