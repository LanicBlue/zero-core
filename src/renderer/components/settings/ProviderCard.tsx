import { useState } from "react";
import { useProviderStore } from "../../store/provider-store.js";
import type { Provider } from "../../../shared/types.js";

export function ProviderCard({ provider, onEdit }: { provider: Provider; onEdit: () => void }) {
	const { update, remove } = useProviderStore();
	const [confirmDelete, setConfirmDelete] = useState(false);

	const toggleEnabled = async () => {
		await update(provider.id, { enabled: !provider.enabled });
	};

	const handleDelete = async () => {
		if (!confirmDelete) {
			setConfirmDelete(true);
			return;
		}
		await remove(provider.id);
	};

	const modelCount = provider.models.length;

	return (
		<div className={`provider-card ${provider.enabled ? "enabled" : ""}`}>
			<div className="provider-card-header">
				<div className="provider-info">
					<span className="provider-name">{provider.name}</span>
					<span className="provider-type-badge">{provider.type}</span>
					{provider.apiKey && <span className="provider-key-status active">Key set</span>}
					{!provider.apiKey && <span className="provider-key-status">No key</span>}
					{provider.enableConcurrencyLimit && <span className="concurrency-badge">Max {provider.maxConcurrency} concurrent</span>}
				</div>
				<div className="provider-actions">
					<button
						type="button"
						className={`toggle-switch ${provider.enabled ? "on" : ""}`}
						onClick={toggleEnabled}
						title={provider.enabled ? "Disable" : "Enable"}
					/>
					<button type="button" className="btn-ghost btn-sm" onClick={onEdit}>Edit</button>
					{!provider.isSystem && (
						<button
							type="button"
							className={`btn-sm ${confirmDelete ? "btn-danger" : "btn-ghost"}`}
							onClick={handleDelete}
							onBlur={() => setConfirmDelete(false)}
						>
							{confirmDelete ? "Confirm?" : "Delete"}
						</button>
					)}
				</div>
			</div>
			<div className="provider-meta">
				<span className="provider-url">{provider.baseUrl}</span>
				<span className="provider-model-count">{modelCount} model{modelCount !== 1 ? "s" : ""}</span>
			</div>
		</div>
	);
}
