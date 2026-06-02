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
