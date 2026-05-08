import React from "react";
import { usePageStore } from "../../store/page-store.js";

export default function IconSidebar() {
	const { activePage, setActivePage } = usePageStore();

	return (
		<nav className="icon-sidebar">
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
		</nav>
	);
}
