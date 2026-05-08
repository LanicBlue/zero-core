import React from "react";
import IconSidebar from "./IconSidebar.js";
import Sidebar from "./Sidebar.js";
import ChatPanel from "./ChatPanel.js";
import DocPanel from "./DocPanel.js";
import AgentsPage from "../agents/AgentsPage.js";
import { usePageStore } from "../../store/page-store.js";

export default function AppLayout() {
	const { activePage } = usePageStore();

	return (
		<div className="app-layout">
			<IconSidebar />
			{activePage === "chat" ? (
				<>
					<Sidebar />
					<ChatPanel />
					<DocPanel />
				</>
			) : (
				<AgentsPage />
			)}
		</div>
	);
}
