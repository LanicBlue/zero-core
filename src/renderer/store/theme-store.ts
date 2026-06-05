// 主题模式状态管理
//
// # 文件说明书
//
// ## 核心功能
// 管理应用主题模式（dark/light/system）和自定义主色调
//
// ## 输入
// 主题模式切换请求、自定义颜色值
//
// ## 输出
// ThemeState（mode、resolvedTheme、customPrimaryColor）
//
// ## 定位
// src/renderer/store/ — 渲染进程状态层，为 UI 提供主题配置
//
// ## 依赖
// zustand
//
// ## 维护规则
// 主题模式变更需确保 resolvedTheme 正确解析
//
import { create } from "zustand";

type ThemeMode = "dark" | "light" | "system";

interface ThemeState {
	mode: ThemeMode;
	resolvedTheme: "dark" | "light";
	customPrimaryColor: string | null;
	setMode: (mode: ThemeMode) => void;
	setCustomPrimaryColor: (color: string | null) => void;
	init: () => void;
}

const api = () => (window as any).api;

function getSystemTheme(): "dark" | "light" {
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved: "dark" | "light") {
	document.documentElement.setAttribute("data-theme", resolved);
}

function applyCustomPrimary(color: string | null, resolved: "dark" | "light") {
	const root = document.documentElement;
	if (color) {
		root.style.setProperty("--color-primary", color);
		root.style.setProperty("--color-primary-hover", color);
		root.style.setProperty("--color-primary-fg", color);
	} else {
		root.style.removeProperty("--color-primary");
		root.style.removeProperty("--color-primary-hover");
		root.style.removeProperty("--color-primary-fg");
	}
}

export const useThemeStore = create<ThemeState>((set, get) => ({
	mode: "dark",
	resolvedTheme: "dark",
	customPrimaryColor: null,

	setMode: (mode) => {
		const resolved = mode === "system" ? getSystemTheme() : mode;
		applyTheme(resolved);
		applyCustomPrimary(get().customPrimaryColor, resolved);
		set({ mode, resolvedTheme: resolved });
		api()?.configSetTheme?.({ mode, customPrimaryColor: get().customPrimaryColor }).catch(() => {});
	},

	setCustomPrimaryColor: (color) => {
		applyCustomPrimary(color, get().resolvedTheme);
		set({ customPrimaryColor: color });
		api()?.configSetTheme?.({ mode: get().mode, customPrimaryColor: color }).catch(() => {});
	},

	init: () => {
		api()?.configGetTheme?.().then((data: any) => {
			if (!data) return;
			const mode: ThemeMode = data.mode ?? "dark";
			const resolved = mode === "system" ? getSystemTheme() : mode;
			applyTheme(resolved);
			if (data.customPrimaryColor) {
				applyCustomPrimary(data.customPrimaryColor, resolved);
			}
			set({
				mode,
				resolvedTheme: resolved,
				customPrimaryColor: data.customPrimaryColor ?? null,
			});
		}).catch(() => {
			applyTheme("dark");
		});

		window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
			if (get().mode === "system") {
				const resolved = getSystemTheme();
				applyTheme(resolved);
				applyCustomPrimary(get().customPrimaryColor, resolved);
				set({ resolvedTheme: resolved });
			}
		});
	},
}));
