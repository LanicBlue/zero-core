// Electron Vite 配置
//
// # 文件说明书
//
// ## 核心功能
// Electron Vite 构建配置，定义主进程、预加载和渲染进程的构建设置。
//
// ## 输入
// - Vite 构建命令
//
// ## 输出
// - 构建产物
//
// ## 定位
// 构建配置文件，被 electron-vite 使用。
//
// ## 依赖
// - electron-vite - Electron Vite 插件
// - @vitejs/plugin-react - React 插件
//
// ## 维护规则
// - 构建目标变更时需更新
// - 保持插件版本兼容
//
import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			lib: {
				entry: resolve("src/main/index.ts"),
				formats: ["cjs"],
				fileName: () => "index.js",
			},
			rollupOptions: {
				external: ["electron", "ws", "bufferutil", "utf-8-validate"],
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			lib: {
				entry: resolve("src/preload/index.ts"),
				formats: ["cjs"],
				fileName: () => "index.js",
			},
		},
	},
	renderer: {
		plugins: [react()],
		resolve: {
			alias: {
				"@renderer": resolve("src/renderer"),
			},
		},
	},
});
