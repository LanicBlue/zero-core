import { useEffect, useState } from "react";
import type { SearchProviderConfig, SearchProviderType } from "../../../shared/types.js";

const api = () => (window as any).api;

const PROVIDER_OPTIONS: { value: SearchProviderType; label: string; description: string }[] = [
	{ value: "duckduckgo", label: "DuckDuckGo", description: "Free, no API key required (default)" },
	{ value: "searxng", label: "SearXNG", description: "Self-hosted meta search" },
	{ value: "serpapi", label: "SerpAPI", description: "Google results via SerpAPI (paid)" },
	{ value: "brave", label: "Brave Search", description: "Free tier 2000 queries/month" },
];

export function SearchSettings() {
	const [config, setConfig] = useState<SearchProviderConfig>({ type: "duckduckgo" });
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api().getSearchProvider().then((c: SearchProviderConfig) => {
			setConfig(c ?? { type: "duckduckgo" });
		}).catch(() => {});
	}, []);

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			const result = await api().setSearchProvider(config);
			if (result?.error) {
				setError(result.error);
			} else {
				setSaved(true);
				setTimeout(() => setSaved(false), 2000);
			}
		} catch (err: any) {
			setError(err.message);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="search-settings">
			<p className="section-desc" style={{ color: "var(--text-muted)", marginBottom: 12 }}>
				Choose the backend used by the WebSearch tool.
			</p>

			<div className="search-provider-options" style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
				{PROVIDER_OPTIONS.map((opt) => (
					<label
						key={opt.value}
						className={`search-provider-option ${config.type === opt.value ? "selected" : ""}`}
						style={{
							display: "flex", gap: 10, padding: "10px 12px",
							border: `1px solid ${config.type === opt.value ? "var(--accent)" : "var(--border)"}`,
							borderRadius: 6, cursor: "pointer",
							background: config.type === opt.value ? "var(--bg-tertiary)" : "var(--bg-primary)",
						}}
					>
						<input
							type="radio"
							name="search-provider"
							checked={config.type === opt.value}
							onChange={() => setConfig({ ...config, type: opt.value })}
							style={{ marginTop: 2 }}
						/>
						<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
							<span style={{ fontWeight: 500 }}>{opt.label}</span>
							<span style={{ fontSize: 12, color: "var(--text-muted)" }}>{opt.description}</span>
						</div>
					</label>
				))}
			</div>

			{config.type === "searxng" && (
				<div className="search-config-row" style={{ marginBottom: 12 }}>
					<label className="config-label" style={{ display: "block", marginBottom: 4 }}>SearXNG URL</label>
					<input
						type="text"
						value={config.searxngUrl ?? ""}
						onChange={(e) => setConfig({ ...config, searxngUrl: e.target.value || undefined })}
						placeholder="http://localhost:8080"
						style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 13 }}
					/>
				</div>
			)}

			{config.type === "serpapi" && (
				<div className="search-config-row" style={{ marginBottom: 12 }}>
					<label className="config-label" style={{ display: "block", marginBottom: 4 }}>SerpAPI Key</label>
					<input
						type="password"
						value={config.serpApiKey ?? ""}
						onChange={(e) => setConfig({ ...config, serpApiKey: e.target.value || undefined })}
						placeholder="serpapi key"
						style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 13 }}
					/>
				</div>
			)}

			{config.type === "brave" && (
				<div className="search-config-row" style={{ marginBottom: 12 }}>
					<label className="config-label" style={{ display: "block", marginBottom: 4 }}>Brave API Key</label>
					<input
						type="password"
						value={config.braveApiKey ?? ""}
						onChange={(e) => setConfig({ ...config, braveApiKey: e.target.value || undefined })}
						placeholder="brave key"
						style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 13 }}
					/>
				</div>
			)}

			{error && (
				<div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 8 }}>{error}</div>
			)}

			<button type="button" className="btn-primary btn-sm" onClick={save} disabled={saving}>
				{saving ? "Saving..." : saved ? "Saved ✓" : "Save"}
			</button>
		</div>
	);
}
