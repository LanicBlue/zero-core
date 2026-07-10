// 渲染进程入口
//
// # 文件说明书
//
// ## 核心功能
// 渲染进程入口，初始化 React 应用、主题和语法高亮。
//
// ## 输入
// 无 - 入口文件。
//
// ## 输出
// - 挂载的 React 应用
//
// ## 定位
// 渲染进程入口，被 index.html 加载。
//
// ## 依赖
// - react - React 框架
// - ./App - 应用根组件
//
// ## 维护规则
// - 初始化逻辑变更时需更新
//
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import { useThemeStore } from "./store/theme-store.js";
import { initShiki } from "./utils/shiki-init.js";
import "./styles/global.css";

useThemeStore.getState().init();
initShiki().catch(() => {});

// Electron/Chromium:文件拖入窗口默认 no-drop 光标 + 会导航打开文件。
// document 级 preventDefault → 全窗口允许 drop、阻止打开文件(multimodal-input 拖拽)。
// module-level:renderer 加载即挂,早于 React,无 mount timing 依赖。
const _preventDragDefault = (e: DragEvent) => e.preventDefault();
document.addEventListener("dragover", _preventDragDefault);
document.addEventListener("dragenter", _preventDragDefault);
document.addEventListener("drop", _preventDragDefault);
console.log("[renderer] drag preventDefault armed");

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
