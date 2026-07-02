// 页面导航状态管理
//
// # 文件说明书
//
// ## 核心功能
// 页面导航的 Zustand 状态管理，跟踪当前活动页面。
//
// ## 输入
// - setActivePage 调用
//
// ## 输出
// - activePage 状态
//
// ## 定位
// 渲染进程状态管理，被 AppLayout 使用。
//
// ## 依赖
// - zustand - 状态管理
//
// ## 维护规则
// - 新增页面时需更新类型
// - 保持页面列表完整
//
import { create } from "zustand";

type PageType = "dashboard" | "chat" | "agents" | "settings" | "mcp" | "skills" | "tools" | "requirements" | "wiki" | "cron";

interface PageState {
	activePage: PageType;
	setActivePage: (page: PageType) => void;
	activeRequirementId: string | null;
	setActiveRequirementId: (id: string | null) => void;
	activeWikiProjectId: string | null;
	setActiveWikiProjectId: (id: string | null) => void;
}

export const usePageStore = create<PageState>((set) => ({
	activePage: "dashboard",
	setActivePage: (page) => set({ activePage: page }),
	activeRequirementId: null,
	setActiveRequirementId: (id) => set({ activeRequirementId: id }),
	activeWikiProjectId: null,
	setActiveWikiProjectId: (id) => set({ activeWikiProjectId: id }),
}));
