// 全局类型声明
//
// # 文件说明书
//
// ## 核心功能
// 为 Window 对象添加 api 属性的全局类型声明
//
// ## 输入
// shared/preload-types.ts 中的 WindowApi 类型
//
// ## 输出
// Window.api 类型声明
//
// ## 定位
// src/renderer/types/ — 渲染进程类型层，为 TS 编译提供全局类型
//
// ## 依赖
// shared/preload-types.ts
//
// ## 维护规则
// preload API 变更需同步更新 WindowApi 类型
//
import type { WindowApi } from "../../shared/preload-types.js";

declare global {
	interface Window {
		api: WindowApi;
	}
}
