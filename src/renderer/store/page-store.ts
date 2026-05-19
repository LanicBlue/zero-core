import { create } from "zustand";

interface PageState {
	activePage: "chat" | "agents" | "settings" | "mcp" | "knowledge";
	setActivePage: (page: "chat" | "agents" | "settings" | "mcp" | "knowledge") => void;
}

export const usePageStore = create<PageState>((set) => ({
	activePage: "chat",
	setActivePage: (page) => set({ activePage: page }),
}));
