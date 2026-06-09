import React, { useState } from "react";
import type { McpServerConfig } from "../../../shared/types.js";

interface Props {
	server: McpServerConfig;
	connected: boolean;
	toolCount: number;
	onToggle: (id: string, enabled: boolean) => void;
	onDelete: (id: string) => void;
	onTest: (id: string) => Promise<{ tools: { name: string; description?: string }[]; error?: string }>;
	onConnect: (id: string) => Promise<any>;
	onDisconnect: (id: string) => Promise<void>;
}

export default function McpServerCard({
	server, connected, toolCount, onToggle, onDelete, onTest, onConnect, onDisconnect,
}: Props) {
	const [expanded, setExpanded] = useState(false);
	const [connecting, setConnecting] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<{ tools: { name: string; description?: string }[]; error?: string } | null>(null);

	const statusColor = connected ? "var(--color-success-fg)" : server.enabled ? "var(--color-warning-fg)" : "var(--fg-faint)";
	const statusText = connecting ? "Connecting..." : connected ? "Connected" : server.enabled ? "Disconnected" : "Disabled";

	const handleConnect = async () => {
		setConnecting(true);
		try {
			await onConnect(server.id);
		} finally {
			setConnecting(false);
		}
	};

	const handleDisconnect = async () => {
		setConnecting(true);
		try {
			await onDisconnect(server.id);
		} finally {
			setConnecting(false);
		}
	};

	const handleTest = async () => {
		setTesting(true);
		setTestResult(null);
		try {
			const result = await onTest(server.id);
			setTestResult(result);
		} catch (err: any) {
			setTestResult({ tools: [], error: err.message });
		} finally {
			setTesting(false);
		}
	};

	return (
		<div className={`mcp-server-card ${connected ? "connected" : ""}`}>
			<div className="mcp-server-header" onClick={() => setExpanded(!expanded)}>
				<div className="mcp-server-info">
					<span className="mcp-server-name">{server.name}</span>
					<span className="mcp-server-transport">{server.transport}</span>
					<span className="mcp-server-status" style={{ color: statusColor }}>{statusText}</span>
					{connected && <span className="mcp-server-tools">{toolCount} tools</span>}
				</div>
				<div className="mcp-server-actions" onClick={(e) => e.stopPropagation()}>
					<button
						type="button"
						className={`toggle-switch ${server.enabled ? "on" : ""}`}
						onClick={() => onToggle(server.id, !server.enabled)}
						title={server.enabled ? "Disable" : "Enable"}
						disabled={connecting}
					/>
					{server.enabled && !connected && (
						<button type="button" className="btn-ghost btn-sm" onClick={handleConnect} disabled={connecting}>
							{connecting ? "Connecting..." : "Connect"}
						</button>
					)}
					{connected && (
						<button type="button" className="btn-ghost btn-sm" onClick={handleDisconnect} disabled={connecting}>
							{connecting ? "Disconnecting..." : "Disconnect"}
						</button>
					)}
					<button type="button" className="btn-ghost btn-sm" onClick={() => setExpanded(!expanded)}>
						{expanded ? "Less" : "Details"}
					</button>
				</div>
			</div>

			{expanded && (
				<div className="mcp-server-details">
					{server.transport === "stdio" ? (
						<>
							<div className="mcp-detail-row"><span>Command:</span><code>{server.command} {(server.args ?? []).join(" ")}</code></div>
							{server.env && Object.keys(server.env).length > 0 && (
								<div className="mcp-detail-row"><span>Env:</span><code>{Object.keys(server.env).map(k => k).join(", ")}</code></div>
							)}
						</>
					) : (
						<div className="mcp-detail-row"><span>URL:</span><code>{server.url}</code></div>
					)}
					<div className="mcp-detail-actions">
						<button type="button" className="btn-ghost btn-sm" onClick={handleTest} disabled={testing}>
							{testing ? "Testing..." : "Test Connection"}
						</button>
						<button type="button" className="btn-danger btn-sm" onClick={() => onDelete(server.id)}>
							Delete
						</button>
					</div>
					{testResult && (
						<div className="mcp-test-result">
							{testResult.error && <p className="mcp-test-error">Error: {testResult.error}</p>}
							{testResult.tools.length > 0 && (
								<div className="mcp-test-tools">
									<p>Found {testResult.tools.length} tool(s):</p>
									<ul>
										{testResult.tools.map((t) => (
											<li key={t.name}><strong>{t.name}</strong> {t.description ? `— ${t.description}` : ""}</li>
										))}
									</ul>
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
