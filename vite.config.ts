// 渲染进程 Vite 开发配置
//
// # 文件说明书
//
// ## 核心功能
// 配置 Vite 开发服务器和构建参数，设置 React 插件、API/WebSocket 代理和输出目录
//
// ## 输入
// Vite 配置参数（插件、root、server、build）
//
// ## 输出
// Vite 开发服务器（端口 5173）和 dist/renderer 构建产物
//
// ## 定位
// 项目根目录 — 渲染进程独立开发时的 Vite 入口（非 Electron 模式）
//
// ## 依赖
// vite、@vitejs/plugin-react
//
// ## 维护规则
// API 代理路径变更需同步检查 electron.vite.config.ts
// 端口变更需确保不与 Electron 开发服务器冲突
//
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	root: "src/renderer",
	server: {
		port: 5173,
		proxy: {
			"/api": "http://localhost:3210",
			"/ws": {
				target: "ws://localhost:3210",
				ws: true,
			},
		},
	},
	build: {
		outDir: "../../dist/renderer",
	},
});
