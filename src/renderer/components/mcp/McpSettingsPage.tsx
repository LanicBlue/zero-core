// MCP 设置页面
//
// # 文件说明书
//
// ## 核心功能
// MCP 服务器管理页面，支持添加、编辑和测试 MCP 服务器。
//
// ## 输入
// - MCP 状态
// - IPC API 调用
//
// ## 输出
// - MCP 服务器列表
// - 连接管理
//
// ## 定位
// 渲染进程页面，被 AppLayout 使用。
//
// ## 依赖
// - react - React 框架
// - ../../store - 状态管理
//
// ## 维护规则
// - MCP 协议变更时需更新
// - 保持连接状态同步
//
import React, { useState, useEffect } from "react";
import { useMcpStore } from "../../store/mcp-store.js";
import type { McpServerConfig } from "../../../shared/types.js";
import McpServerCard from "./McpServerCard.js";

interface ServerStatus {
	id: string;
	name: string;
	connected: boolean;
	toolCount: number;
}

type Transport = "stdio" | "sse" | "streamable-http";


const EMPTY_FORM = {
	name: "",
	transport: "stdio" as Transport,
	command: "",
	args: "",
	env: "",
	url: "",
	enabled: true,
};

export default function McpSettingsPage() {
	const { servers, loading, create, update, remove, testConnection, connect, disconnect, getStatus } = useMcpStore();
	const [showForm, setShowForm] = useState(false);
	const [form, setForm] = useState(EMPTY_FORM);
	const [statuses, setStatuses] = useState<ServerStatus[]>([]);
	const [testResult, setTestResult] = useState<{ tools: { name: string; description?: string }[]; error?: string } | null>(null);
	const [testing, setTesting] = useState(false);

	const refreshStatus = async () => {
		try {
			const s = await getStatus();
			setStatuses(s);
		} catch { /* ignore */ }
	};

	useEffect(() => {
		refreshStatus();
		const interval = setInterval(refreshStatus, 10000);
		return () => clearInterval(interval);
	}, [servers]);

	const handleToggle = async (id: string, enabled: boolean) => {
		await update(id, { enabled });
		if (enabled) {
			await connect(id);
		} else {
			await disconnect(id);
		}
		refreshStatus();
	};

	const handleDelete = async (id: string) => {
		await remove(id);
		refreshStatus();
	};

	const handleTest = async (id: string) => {
		const server = servers.find((s) => s.id === id);
		if (!server) return;
		setTesting(true);
		setTestResult(null);
		try {
			const result = await testConnection({
				name: server.name,
				transport: server.transport,
				command: server.command,
				args: server.args,
				env: server.env,
				url: server.url,
				headers: server.headers,
				enabled: server.enabled,
			});
			setTestResult(result);
		} catch (err: any) {
			setTestResult({ tools: [], error: err.message });
		} finally {
			setTesting(false);
		}
	};

	const handleConnect = async (id: string) => {
		await connect(id);
		refreshStatus();
	};

	const handleDisconnect = async (id: string) => {
		await disconnect(id);
		refreshStatus();
	};

	const handleFormTest = async () => {
		setTesting(true);
		setTestResult(null);
		try {
			const input: any = {
				name: form.name || "test",
				transport: form.transport,
				enabled: form.enabled,
			};
			if (form.transport === "stdio") {
				input.command = form.command;
				if (form.args.trim()) input.args = form.args.split(/\s+/);
				if (form.env.trim()) {
					input.env = Object.fromEntries(
						form.env.split(",").map((e) => {
							const [k, ...v] = e.split("=");
							return [k.trim(), v.join("=").trim()];
						}),
					);
				}
			} else {
				input.url = form.url;
			}
			const result = await testConnection(input);
			setTestResult(result);
		} catch (err: any) {
			setTestResult({ tools: [], error: err.message });
		} finally {
			setTesting(false);
		}
	};

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		const input: any = {
			name: form.name,
			transport: form.transport,
			enabled: form.enabled,
		};
		if (form.transport === "stdio") {
			input.command = form.command;
			if (form.args.trim()) input.args = form.args.split(/\s+/);
			if (form.env.trim()) {
				input.env = Object.fromEntries(
					form.env.split(",").map((e) => {
						const [k, ...v] = e.split("=");
						return [k.trim(), v.join("=").trim()];
					}),
				);
			}
		} else {
			input.url = form.url;
		}

		await create(input);
		setForm(EMPTY_FORM);
		setShowForm(false);
		setTestResult(null);
		refreshStatus();
	};

	const getStatusFor = (id: string) => statuses.find((s) => s.id === id) ?? { connected: false, toolCount: 0 };

	return (
		<div className="mcp-page">
			<div className="mcp-page-header">
				<h2>MCP Servers</h2>
				<button
					type="button"
					className="btn-primary"
					onClick={() => { setShowForm(!showForm); setTestResult(null); }}
				>
					{showForm ? "Cancel" : "+ Add Server"}
				</button>
			</div>

			{showForm && (
				<form className="mcp-add-form" onSubmit={submit}>
					<label>Name
						<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="e.g. filesystem" />
					</label>
					<label>Transport
						<select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as Transport })}>
							<option value="stdio">STDIO</option>
							<option value="sse">SSE</option>
							<option value="streamable-http">Streamable HTTP</option>
						</select>
					</label>
					{form.transport === "stdio" ? (
						<>
							<label>Command
								<input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="e.g. npx -y @modelcontextprotocol/server-filesystem" required />
							</label>
							<label>Arguments (space-separated, optional)
								<input value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder="e.g. /path/to/dir" />
							</label>
							<label>Environment (key=val, comma-separated, optional)
								<input value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} placeholder="e.g. API_KEY=xxx,DEBUG=true" />
							</label>
						</>
					) : (
						<label>URL
							<input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="e.g. http://localhost:3000/sse" required />
						</label>
					)}
					<div className="mcp-form-actions">
						<button type="button" className="btn-ghost" onClick={handleFormTest} disabled={testing || !form.name}>
							{testing ? "Testing..." : "Test Connection"}
						</button>
						<button type="submit" className="btn-primary">
							Add Server
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
				</form>
			)}

			<div className="mcp-server-list">
				{loading && <p className="agents-empty">Loading...</p>}
				{!loading && servers.length === 0 && (
					<p className="agents-empty">No MCP servers configured. Add one to extend your agents with external tools.</p>
				)}
				{servers.map((server) => {
					const status = getStatusFor(server.id);
					return (
						<McpServerCard
							key={server.id}
							server={server}
							connected={status.connected}
							toolCount={status.toolCount}
							onToggle={handleToggle}
							onDelete={handleDelete}
							onTest={handleTest}
							onConnect={handleConnect}
							onDisconnect={handleDisconnect}
						/>
					);
				})}
			</div>

		</div>
	);
}
