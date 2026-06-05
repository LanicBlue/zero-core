// 预加载类型声明
//
// # 文件说明书
//
// ## 核心功能
// 全局类型声明，为 window.api 提供类型安全。
//
// ## 输入
// 无 - 类型声明文件。
//
// ## 输出
// - Window.api 类型声明
//
// ## 定位
// 渲染进程类型声明。
//
// ## 依赖
// - ../preload/index - 预加载模块
//
// ## 维护规则
// - API 变更时需更新
//
import type { ExposedAPI } from "../preload/index.js";

declare global {
	interface Window {
		api: ExposedAPI;
	}
}
