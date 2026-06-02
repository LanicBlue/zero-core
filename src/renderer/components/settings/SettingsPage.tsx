import { useEffect, useState } from "react";
import { useProviderStore } from "../../store/provider-store.js";
import type { Provider } from "../../../shared/types.js";
import { ProviderCard } from "./ProviderCard.js";
import { ProviderEditor } from "./ProviderEditor.js";
import { DeviceContextSettings } from "./DeviceContextSettings.js";
import { GuidelinesSettings } from "./GuidelinesSettings.js";
import { WorkspaceSettings } from "./WorkspaceSettings.js";
import { ThemeSettings } from "./ThemeSettings.js";
import { SearchSettings } from "./SearchSettings.js";

export default function SettingsPage() {
	const { providers, loading, fetchProviders } = useProviderStore();
	const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
	const [creating, setCreating] = useState(false);
	const [activeSection, setActiveSection] = useState<string>("providers");

	useEffect(() => { fetchProviders(); }, [fetchProviders]);

	const enabledCount = providers.filter((p) => p.enabled).length;

	const sections = [
		{ key: "providers", label: "API Providers", badge: String(providers.length) },
		{ key: "device-context", label: "Device Context" },
		{ key: "guidelines", label: "Guidelines" },
		{ key: "theme", label: "Theme" },
		{ key: "workspace", label: "Workspace" },
		{ key: "search", label: "Search" },
	];

	return (
		<div className="settings-page">
			<div className="settings-header">
				<h2>Settings</h2>
				<div className="settings-header-info">
					<span>{enabledCount} of {providers.length} providers enabled</span>
				</div>
			</div>

			<div className="settings-content">
				<div className="settings-nav">
					{sections.map((s) => (
						<button
							key={s.key}
							type="button"
							className={`settings-nav-item ${activeSection === s.key ? "active" : ""}`}
							onClick={() => setActiveSection(s.key)}
						>
							<span className="settings-nav-label">{s.label}</span>
							{s.badge && <span className="settings-nav-badge">{s.badge}</span>}
						</button>
					))}
				</div>

				<div className="settings-panel">
					{activeSection === "providers" && (
						<>
							<div className="section-title-row">
								<h3>API Providers</h3>
								<button
									type="button"
									className="btn-primary btn-sm"
									onClick={() => { setCreating(true); setEditingProvider(null); }}
								>
									+ Add Provider
								</button>
							</div>
							{loading && <p className="settings-empty">Loading providers...</p>}
							{!loading && providers.length === 0 && (
								<p className="settings-empty">No providers configured.</p>
							)}
							<div className="providers-grid">
								{providers.map((p) => (
									<ProviderCard
										key={p.id}
										provider={p}
										onEdit={() => { setEditingProvider(p); setCreating(false); }}
									/>
								))}
							</div>
						</>
					)}

					{activeSection === "device-context" && (
						<>
							<div className="section-title-row"><h3>Device Context</h3></div>
							<DeviceContextSettings />
						</>
					)}

					{activeSection === "guidelines" && (
						<>
							<div className="section-title-row"><h3>Guidelines</h3></div>
							<GuidelinesSettings />
						</>
					)}

					{activeSection === "theme" && (
						<>
							<div className="section-title-row"><h3>Theme</h3></div>
							<ThemeSettings />
						</>
					)}

					{activeSection === "workspace" && (
						<>
							<div className="section-title-row"><h3>Workspace</h3></div>
							<WorkspaceSettings />
						</>
					)}

					{activeSection === "search" && (
						<>
							<div className="section-title-row"><h3>Web Search</h3></div>
							<SearchSettings />
						</>
					)}
				</div>
			</div>

			{(creating || editingProvider) && (
				<ProviderEditor
					provider={creating ? null : editingProvider}
					onClose={() => { setCreating(false); setEditingProvider(null); }}
				/>
			)}
		</div>
	);
}
