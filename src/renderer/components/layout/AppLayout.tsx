import React from "react";
import IconSidebar from "./IconSidebar.js";
import Sidebar from "./Sidebar.js";
import ChatPanel from "./ChatPanel.js";
import DocPanel from "./DocPanel.js";
import ResizableLayout from "./ResizableLayout.js";
import AgentsPage from "../agents/AgentsPage.js";
import { usePageStore } from "../../store/page-store.js";

export default function AppLayout() {
	const { activePage } = usePageStore();

	return (
		<div className="app-layout">
			<IconSidebar />
			{activePage === "chat" ? (
				<ResizableLayout
					defaults={[260, 500, 300]}
					mins={[180, 300, 180]}
				>
					<Sidebar />
					<ChatPanel />
					<DocPanel />
				</ResizableLayout>
			) : (
				<AgentsPage />
			)}
		</div>
	);
}
