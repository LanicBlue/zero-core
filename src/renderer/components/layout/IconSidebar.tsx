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
					<path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
					<path d="M19 10v1a7 7 0 0 1-14 0v-1" />
					<line x1="12" y1="19" x2="12" y2="22" />
				</svg>
			</button>
		</nav>
	);
}
