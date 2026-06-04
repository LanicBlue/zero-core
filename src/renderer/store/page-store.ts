import { create } from "zustand";

interface PageState {
	activePage: "dashboard" | "chat" | "agents" | "settings" | "mcp" | "knowledge" | "tools";
	setActivePage: (page: "dashboard" | "chat" | "agents" | "settings" | "mcp" | "knowledge" | "tools") => void;
}

export const usePageStore = create<PageState>((set) => ({
	activePage: "dashboard",
	setActivePage: (page) => set({ activePage: page }),
}));
