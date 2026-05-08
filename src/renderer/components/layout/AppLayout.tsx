import React from "react";
import IconSidebar from "./IconSidebar.js";
import ChatPanel from "./ChatPanel.js";
import WorkspacePanel from "./WorkspacePanel.js";
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
					defaults={[500, 500]}
					mins={[300, 250]}
				>
					<ChatPanel />
					<WorkspacePanel />
				</ResizableLayout>
			) : (
				<AgentsPage />
			)}
		</div>
	);
}
