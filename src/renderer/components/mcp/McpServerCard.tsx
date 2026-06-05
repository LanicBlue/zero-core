// MCP 服务器卡片组件
//
// # 文件说明书
//
// ## 核心功能
// 以卡片形式展示单个 MCP 服务器的配置和状态
//
// ## 输入
// McpServerConfig 数据
//
// ## 输出
// 服务器卡片 JSX（含状态指示、编辑/删除操作）
//
// ## 定位
// src/renderer/components/mcp/ — MCP 页面组件，用于服务器列表展示
//
// ## 依赖
// React、shared/types.ts
//
// ## 维护规则
// 服务器状态指示器需反映实际连接状态
//
import React, { useState } from "react";
import type { McpServerConfig } from "../../../shared/types.js";

interface Props {
	server: McpServerConfig;
	connected: boolean;
	toolCount: number;
	onToggle: (id: string, enabled: boolean) => void;
	onDelete: (id: string) => void;
	onTest: (id: string) => void;
	onConnect: (id: string) => void;
	onDisconnect: (id: string) => void;
}

export default function McpServerCard({
	server, connected, toolCount, onToggle, onDelete, onTest, onConnect, onDisconnect,
}: Props) {
	const [expanded, setExpanded] = useState(false);

	const statusColor = connected ? "var(--color-success-fg)" : server.enabled ? "var(--color-warning-fg)" : "var(--fg-faint)";
	const statusText = connected ? "Connected" : server.enabled ? "Disconnected" : "Disabled";

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
					/>
					{server.enabled && !connected && (
						<button type="button" className="btn-ghost btn-sm" onClick={() => onConnect(server.id)}>
							Connect
						</button>
					)}
					{connected && (
						<button type="button" className="btn-ghost btn-sm" onClick={() => onDisconnect(server.id)}>
							Disconnect
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
								<div className="mcp-detail-row"><span>Env:</span><code>{JSON.stringify(server.env)}</code></div>
							)}
						</>
					) : (
						<div className="mcp-detail-row"><span>URL:</span><code>{server.url}</code></div>
					)}
					<div className="mcp-detail-actions">
						<button type="button" className="btn-ghost btn-sm" onClick={() => onTest(server.id)}>
							Test Connection
						</button>
						<button type="button" className="btn-danger btn-sm" onClick={() => onDelete(server.id)}>
							Delete
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
