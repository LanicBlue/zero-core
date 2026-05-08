import React from "react";
import IconSidebar from "./IconSidebar.js";
import ChatPanel from "./ChatPanel.js";
import FileTreePanel from "./FileTreePanel.js";
import DocViewerPanel from "./DocViewerPanel.js";
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
					defaults={[4, 2, 4]}
					mins={[280, 160, 200]}
				>
					<ChatPanel />
					<FileTreePanel />
					<DocViewerPanel />
				</ResizableLayout>
			) : (
				<AgentsPage />
			)}
		</div>
	);
}
