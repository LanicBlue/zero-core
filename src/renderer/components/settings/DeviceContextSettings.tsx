import { useEffect, useState } from "react";

const api = () => (window as any).api;

export function DeviceContextSettings() {
	const [content, setContent] = useState("");
	const [generating, setGenerating] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		api().deviceContextGet().then((r: any) => {
			setContent(r.content ?? "");
		}).catch(() => {});
	}, []);

	const handleGenerate = async () => {
		setGenerating(true);
		try {
			const r = await api().deviceContextGenerate();
			if (r.content) setContent(r.content);
		} finally {
			setGenerating(false);
		}
	};

	const handleSave = async () => {
		setSaving(true);
		try {
			await api().deviceContextSave(content);
			setSaved(true);
			setTimeout(() => setSaved(false), 2000);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="device-context-section">
			<p className="section-desc" style={{ color: "var(--text-muted)", marginBottom: 12 }}>
				Device context is included in the system prompt for agents that have it enabled.
				Click "Generate" to auto-detect hardware and OS info, then edit as needed.
			</p>
			<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
				<button type="button" className="btn-ghost btn-sm" onClick={handleGenerate} disabled={generating}>
					{generating ? "Generating..." : "Generate"}
				</button>
				<button type="button" className="btn-primary btn-sm" onClick={handleSave} disabled={saving}>
					{saving ? "Saving..." : saved ? "Saved ✓" : "Save"}
				</button>
			</div>
			<textarea
				className="device-context-editor"
				value={content}
				onChange={(e) => setContent(e.target.value)}
				placeholder="Click Generate to detect device info, or type custom context here..."
				rows={15}
				style={{ width: "100%", resize: "vertical", fontFamily: "monospace", fontSize: 13, padding: 12, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)" }}
			/>
		</div>
	);
}
