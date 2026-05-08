import { create } from "zustand";

interface PageState {
	activePage: "chat" | "agents";
	setActivePage: (page: "chat" | "agents") => void;
}

export const usePageStore = create<PageState>((set) => ({
	activePage: "chat",
	setActivePage: (page) => set({ activePage: page }),
}));
