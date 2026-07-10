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
import React from "react";
import AppLayout from "./components/layout/AppLayout.js";

export default function App() {
	return <AppLayout />;
}
