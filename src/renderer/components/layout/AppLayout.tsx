import React from "react";
import Sidebar from "./Sidebar.js";
import ChatPanel from "./ChatPanel.js";
import DocPanel from "./DocPanel.js";

export default function AppLayout() {
	return (
		<div className="app-layout">
			<Sidebar />
			<ChatPanel />
			<DocPanel />
		</div>
	);
}
