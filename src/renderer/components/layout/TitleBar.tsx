// 自定义窗口标题栏
//
// # 文件说明书
//
// ## 核心功能
// Electron frameless 窗口的自定义标题栏，显示应用名并按平台提供最小化/最大化/关闭按钮，调用 window.api 暴露的窗口控制接口。
//
// ## 输入
// - window.api.platform：当前操作系统平台
// - window.api.windowMinimize / windowMaximize / windowClose
//
// ## 输出
// - 渲染的标题栏 DOM
//
// ## 定位
// 渲染进程顶层布局组件，挂在 AppLayout 最顶部（frameless 窗口装饰）。
//
// ## 依赖
// - react
// - window.api（preload 暴露的窗口控制接口）
//
// ## 维护规则
// - 平台判断或窗口控制 API 变化时同步本组件。
// - 仅在 win32/linux 显示窗口控件；macOS 使用系统原生红绿灯。
//
import React from "react";

const api = () => (window as any).api;

export default function TitleBar() {
	const platform = api()?.platform ?? "win32";
	const showControls = platform === "win32" || platform === "linux";

	return (
		<div className="title-bar">
			<span className="title-bar-name">Zero-Core</span>
			{showControls && (
				<div className="title-bar-controls">
					<button
						type="button"
						className="title-bar-btn title-bar-btn-minimize"
						onClick={() => api()?.windowMinimize?.()}
						aria-label="Minimize"
					>
						&#x2500;
					</button>
					<button
						type="button"
						className="title-bar-btn title-bar-btn-maximize"
						onClick={() => api()?.windowMaximize?.()}
						aria-label="Maximize"
					>
						&#x25A1;
					</button>
					<button
						type="button"
						className="title-bar-btn title-bar-btn-close"
						onClick={() => api()?.windowClose?.()}
						aria-label="Close"
					>
						&#x2715;
					</button>
				</div>
			)}
		</div>
	);
}
