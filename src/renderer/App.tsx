// React 应用根组件
//
// # 文件说明书
//
// ## 核心功能
// React 应用的根组件，渲染主布局。
//
// ## 输入
// - 无
//
// ## 输出
// - AppLayout 组件
//
// ## 定位
// 渲染进程入口，被 Electron 加载。
//
// ## 依赖
// - react - React 框架
// - ./components/layout/AppLayout - 主布局
//
// ## 维护规则
// - 全局配置变更时需更新
// - 保持组件层次清晰
//
import React, { useEffect } from "react";
import AppLayout from "./components/layout/AppLayout.js";

export default function App() {
	// Electron/Chromium:文件拖入窗口默认显示 no-drop 光标 + 会导航打开该文件。
	// document 级 dragover+drop preventDefault → 全窗口不再禁止光标、不再打开文件;
	// 实际附件 ingest 由 chat-panel 的 onDrop 处理(multimodal-input)。
	// 拖到 chat 区以外:仅阻止导航,不 ingest(无 onDrop 命中)。
	useEffect(() => {
		const prevent = (e: DragEvent) => {
			e.preventDefault();
		};
		document.addEventListener("dragover", prevent);
		document.addEventListener("drop", prevent);
		return () => {
			document.removeEventListener("dragover", prevent);
			document.removeEventListener("drop", prevent);
		};
	}, []);

	return <AppLayout />;
}
