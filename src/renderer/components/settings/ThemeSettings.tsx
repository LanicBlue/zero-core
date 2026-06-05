// 主题设置组件
//
// # 文件说明书
//
// ## 核心功能
// 展示和编辑应用主题模式（dark/light/system）和自定义主色调
//
// ## 输入
// theme-store 中的主题状态
//
// ## 输出
// 主题选择和颜色配置 JSX
//
// ## 定位
// src/renderer/components/settings/ — 设置页面组件，外观主题配置
//
// ## 依赖
// store/theme-store.ts
//
// ## 维护规则
// 主题模式变更需确保全局样式同步切换
//
import { useThemeStore } from "../../store/theme-store.js";

export function ThemeSettings() {
	const { mode, setMode, customPrimaryColor, setCustomPrimaryColor } = useThemeStore();
	const modes = [
		{ key: "dark", label: "Dark" },
		{ key: "light", label: "Light" },
		{ key: "system", label: "System" },
	];

	return (
		<div className="theme-section">
			<div className="theme-mode-group">
				{modes.map((m) => (
					<button
						key={m.key}
						type="button"
						className={"theme-mode-btn " + (mode === m.key ? "active" : "")}
						onClick={() => setMode(m.key as any)}
					>
						{m.label}
					</button>
				))}
			</div>
			<div className="theme-color-row">
				<input
					type="color"
					value={customPrimaryColor ?? "#1f6feb"}
					onChange={(e) => setCustomPrimaryColor(e.target.value)}
				/>
				<span className="theme-color-label">Custom Primary Color</span>
				{customPrimaryColor && (
					<button type="button" className="btn-ghost btn-sm" onClick={() => setCustomPrimaryColor(null)}>Reset</button>
				)}
			</div>
		</div>
	);
}
