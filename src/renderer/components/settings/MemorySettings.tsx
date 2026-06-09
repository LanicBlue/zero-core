import { useEffect, useState } from "react";
import { useProviderStore } from "../../store/provider-store.js";

const api = () => (window as any).api;

interface CompressionConfig {
	enabled?: boolean;
	keepRecentTurns?: number;
	l1Threshold?: number;
	l2Threshold?: number;
	provider?: string;
	model?: string;
}

interface MemoryConfig {
	enabled?: boolean;
	autoRecall?: boolean;
	recallLimit?: number;
}

export function MemorySettings() {
	const { providers } = useProviderStore();
	const [compression, setCompression] = useState<CompressionConfig>({ enabled: false });
	const [memory, setMemory] = useState<MemoryConfig>({ enabled: false });
	const [saved, setSaved] = useState(false);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		api().memoryConfigGet().then((data: any) => {
			setCompression(data.compression ?? { enabled: false });
			setMemory(data.memory ?? { enabled: false });
			setLoading(false);
		}).catch(() => setLoading(false));
	}, []);

	const enabledModels: { provider: string; id: string; name: string; group: string }[] = [];
	for (const p of providers) {
		if (!p.enabled) continue;
		for (const m of p.models) {
			enabledModels.push({ provider: p.name, id: m.id, name: m.name || m.id, group: m.group || p.name });
		}
	}

	const save = async () => {
		await api().memoryConfigUpdate({ compression, memory });
		setSaved(true);
		setTimeout(() => setSaved(false), 2000);
	};

	if (loading) return <p className="settings-empty">Loading...</p>;

	return (
		<div className="memory-config">
			<div className="memory-config-section">
				<h4 className="memory-config-title">Session Compression</h4>
				<p className="memory-config-desc">
					Automatically compress older turns when context fills up. L1 summarizes old turns; L2 extracts memory nodes and discards the originals.
				</p>

				<div className="memory-config-row">
					<label className="config-label">Enable Compression</label>
					<button
						type="button"
						className={`toggle-switch ${compression.enabled ? "on" : ""}`}
						title={compression.enabled ? "Disable compression" : "Enable compression"}
						onClick={() => setCompression({ ...compression, enabled: !compression.enabled })}
					/>
				</div>

				<div className="memory-config-row memory-config-row-stack">
					<label className="config-label">Model</label>
					<select
						className="default-model-select"
						aria-label="Compression Model"
						value={compression.provider && compression.model ? `${compression.provider}|${compression.model}` : ""}
						disabled={!compression.enabled}
						onChange={(e) => {
							if (!e.target.value) {
								setCompression({ ...compression, provider: undefined, model: undefined });
							} else {
								const [prov, model] = e.target.value.split("|");
								setCompression({ ...compression, provider: prov, model });
							}
						}}
					>
						<option value="">Same as Agent</option>
						{[...new Set(enabledModels.map((m) => m.group))].sort().map((group) => (
							<optgroup key={group} label={group}>
								{enabledModels
									.filter((m) => m.group === group)
									.map((m) => (
										<option key={`${m.provider}|${m.id}`} value={`${m.provider}|${m.id}`}>
											{m.name}
										</option>
									))}
							</optgroup>
						))}
					</select>
				</div>

				<div className="memory-config-row">
					<label className="config-label">Keep Recent Turns</label>
					<input
						type="number"
						className="memory-config-number"
						title="Keep Recent Turns"
						value={compression.keepRecentTurns ?? 5}
						min={2}
						max={20}
						onChange={(e) => setCompression({ ...compression, keepRecentTurns: parseInt(e.target.value, 10) || 5 })}
						disabled={!compression.enabled}
					/>
				</div>

				<div className="memory-config-row">
					<label className="config-label">L1 Threshold (compress trigger)</label>
					<div className="memory-config-slider-row">
						<input
							type="range"
							className="memory-config-slider"
							title="L1 Threshold"
							min={0.3}
							max={0.95}
							step={0.05}
							value={compression.l1Threshold ?? 0.7}
							onChange={(e) => setCompression({ ...compression, l1Threshold: parseFloat(e.target.value) })}
							disabled={!compression.enabled}
						/>
						<span className="memory-config-slider-val">{Math.round((compression.l1Threshold ?? 0.7) * 100)}%</span>
					</div>
				</div>

				<div className="memory-config-row">
					<label className="config-label">L2 Threshold (memory extraction)</label>
					<div className="memory-config-slider-row">
						<input
							type="range"
							className="memory-config-slider"
							title="L2 Threshold"
							min={0.2}
							max={0.9}
							step={0.05}
							value={compression.l2Threshold ?? 0.5}
							onChange={(e) => setCompression({ ...compression, l2Threshold: parseFloat(e.target.value) })}
							disabled={!compression.enabled}
						/>
						<span className="memory-config-slider-val">{Math.round((compression.l2Threshold ?? 0.5) * 100)}%</span>
					</div>
				</div>
			</div>

			<div className="memory-config-section">
				<h4 className="memory-config-title">Memory (Wiki Nodes)</h4>
				<p className="memory-config-desc">
					Persist extracted facts across sessions. Agents can recall memories automatically or via the MemoryRecall tool.
				</p>

				<div className="memory-config-row">
					<label className="config-label">Enable Memory</label>
					<button
						type="button"
						className={`toggle-switch ${memory.enabled ? "on" : ""}`}
						title={memory.enabled ? "Disable memory" : "Enable memory"}
						onClick={() => setMemory({ ...memory, enabled: !memory.enabled })}
					/>
				</div>

				<div className="memory-config-row">
					<label className="config-label">Auto Recall</label>
					<button
						type="button"
						className={`toggle-switch ${memory.autoRecall !== false ? "on" : ""}`}
						title={memory.autoRecall !== false ? "Disable auto recall" : "Enable auto recall"}
						onClick={() => setMemory({ ...memory, autoRecall: memory.autoRecall === false })}
						disabled={!memory.enabled}
					/>
				</div>

				<div className="memory-config-row">
					<label className="config-label">Recall Limit</label>
					<input
						type="number"
						className="memory-config-number"
						title="Recall Limit"
						value={memory.recallLimit ?? 10}
						min={1}
						max={50}
						onChange={(e) => setMemory({ ...memory, recallLimit: parseInt(e.target.value, 10) || 10 })}
						disabled={!memory.enabled}
					/>
				</div>
			</div>

			<button type="button" className="btn-primary btn-sm" onClick={save}>
				{saved ? "Saved ✓" : "Save"}
			</button>
		</div>
	);
}
