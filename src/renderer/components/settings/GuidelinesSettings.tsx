// 指南设置组件
//
// # 文件说明书
//
// ## 核心功能
// 展示和编辑全局行为指南（guidelines）配置
//
// ## 输入
// preload API 返回的指南数据
//
// ## 输出
// 指南文本编辑表单 JSX
//
// ## 定位
// src/renderer/components/settings/ — 设置页面组件，全局行为指南配置
//
// ## 依赖
// React、preload API
//
// ## 维护规则
// 指南变更需实时同步到 system-prompt
//
import { useEffect, useState } from "react";

const api = () => (window as any).api;

export function GuidelinesSettings() {
	const [guidelines, setGuidelines] = useState<string[]>([]);
	const [defaults, setDefaults] = useState<string[]>([]);
	const [newGuideline, setNewGuideline] = useState("");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		api().guidelinesGet().then((r: any) => {
			setGuidelines(r.guidelines ?? []);
			setDefaults(r.defaults ?? []);
		}).catch(() => {});
	}, []);

	const handleSave = async () => {
		setSaving(true);
		try {
			await api().guidelinesSave(guidelines);
			setSaved(true);
			setTimeout(() => setSaved(false), 2000);
		} finally {
			setSaving(false);
		}
	};

	const addGuideline = () => {
		const trimmed = newGuideline.trim();
		if (trimmed) {
			setGuidelines([...guidelines, trimmed]);
			setNewGuideline("");
		}
	};

	const removeGuideline = (idx: number) => {
		setGuidelines(guidelines.filter((_, i) => i !== idx));
	};

	const updateGuideline = (idx: number, value: string) => {
		setGuidelines(guidelines.map((g, i) => i === idx ? value : g));
	};

	return (
		<div className="guidelines-section">
			<p className="section-desc" style={{ color: "var(--text-muted)", marginBottom: 12 }}>
				Global guidelines are included in the system prompt for agents that have them enabled.
			</p>
			<div className="guidelines-list" style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
				{guidelines.map((g, idx) => (
					<div key={idx} style={{ display: "flex", gap: 8, alignItems: "center" }}>
						<input
							type="text"
							value={g}
							onChange={(e) => updateGuideline(idx, e.target.value)}
							style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 13 }}
						/>
						<button type="button" className="btn-ghost btn-sm" onClick={() => removeGuideline(idx)}>Remove</button>
					</div>
				))}
			</div>
			<div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
				<input
					type="text"
					value={newGuideline}
					onChange={(e) => setNewGuideline(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") addGuideline(); }}
					placeholder="Add a new guideline..."
					style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 13 }}
				/>
				<button type="button" className="btn-ghost btn-sm" onClick={addGuideline} disabled={!newGuideline.trim()}>Add</button>
			</div>
			<div style={{ display: "flex", gap: 8 }}>
				<button type="button" className="btn-ghost btn-sm" onClick={() => setGuidelines([...defaults])} disabled={guidelines.length === defaults.length && guidelines.every((g, i) => g === defaults[i])}>
					Restore Defaults
				</button>
				<button type="button" className="btn-primary btn-sm" onClick={handleSave} disabled={saving}>
					{saving ? "Saving..." : saved ? "Saved ✓" : "Save"}
				</button>
			</div>
		</div>
	);
}
