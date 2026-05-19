import React, { useState, useEffect } from "react";
import { useMcpStore, type McpServerConfig } from "../../store/mcp-store.js";
import McpServerCard from "./McpServerCard.js";

interface ServerStatus {
	id: string;
	name: string;
	connected: boolean;
	toolCount: number;
}

type Transport = "stdio" | "sse" | "streamable-http";

// Built-in MCP server tool groups
const BUILTIN_SERVERS = [
	{
		name: "Web Fetch",
		icon: "🌐",
		desc: "Fetch web pages and convert to HTML/Markdown/text/JSON",
		tools: [
			{ name: "fetch_html", description: "获取网页返回 HTML" },
			{ name: "fetch_markdown", description: "获取网页返回 Markdown" },
			{ name: "fetch_text", description: "获取网页返回纯文本" },
			{ name: "fetch_json", description: "获取 JSON 数据" },
		],
	},
	{
		name: "Knowledge Graph Memory",
		icon: "🧠",
		desc: "Persistent entity-relation knowledge graph",
		tools: [
			{ name: "memory_create_entities", description: "创建实体" },
			{ name: "memory_create_relations", description: "创建关系" },
			{ name: "memory_add_observations", description: "添加观察" },
			{ name: "memory_delete_entities", description: "删除实体" },
			{ name: "memory_delete_relations", description: "删除关系" },
			{ name: "memory_read_graph", description: "读取图谱" },
			{ name: "memory_search_nodes", description: "搜索节点" },
		],
	},
	{
		name: "Sequential Thinking",
		icon: "💭",
		desc: "Multi-step reasoning with thought history",
		tools: [
			{ name: "sequentialthinking", description: "多步骤顺序推理" },
		],
	},
	{
		name: "Filesystem",
		icon: "📂",
		desc: "File operations within workspace directory",
		tools: [
			{ name: "fs_read", description: "读取文件（带行号）" },
			{ name: "fs_write", description: "创建/覆盖文件" },
			{ name: "fs_edit", description: "字符串替换编辑" },
			{ name: "fs_delete", description: "删除文件/目录" },
			{ name: "fs_list", description: "列出目录（树形）" },
			{ name: "fs_glob", description: "按模式匹配文件" },
			{ name: "fs_grep", description: "按正则搜索内容" },
		],
	},
	{
		name: "Assistant",
		icon: "🔧",
		desc: "App diagnostics: info, logs, config, providers",
		tools: [
			{ name: "assistant_info", description: "运行时信息" },
			{ name: "assistant_logs", description: "读取日志" },
			{ name: "assistant_config", description: "读取配置" },
			{ name: "assistant_read_source", description: "读取源码" },
			{ name: "assistant_list_providers", description: "列出提供者" },
			{ name: "assistant_list_files", description: "列出数据文件" },
		],
	},
];

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
	const [expandedBuiltIn, setExpandedBuiltIn] = useState<string | null>(null);

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

			{/* Built-in Tools Section */}
			<div className="builtin-tools-section">
				<h3 className="builtin-tools-header">
					Built-in Tools
					<span className="builtin-tools-count">{BUILTIN_SERVERS.reduce((sum, s) => sum + s.tools.length, 0)}</span>
				</h3>
				<p className="builtin-tools-desc">These tools are always available to all agents. No configuration needed.</p>
				<div className="builtin-servers-grid">
					{BUILTIN_SERVERS.map((server) => (
						<div key={server.name} className="builtin-server-card">
							<div
								className="builtin-server-header"
								onClick={() => setExpandedBuiltIn(expandedBuiltIn === server.name ? null : server.name)}
							>
								<span className="builtin-server-icon">{server.icon}</span>
								<div className="builtin-server-info">
									<span className="builtin-server-name">{server.name}</span>
									<span className="builtin-server-desc">{server.desc}</span>
								</div>
								<span className="builtin-server-badge">{server.tools.length}</span>
								<span className={`builtin-expand-icon ${expandedBuiltIn === server.name ? "expanded" : ""}`}>▸</span>
							</div>
							{expandedBuiltIn === server.name && (
								<div className="builtin-tool-list">
									{server.tools.map((tool) => (
										<div key={tool.name} className="builtin-tool-item">
											<code>{tool.name}</code>
											<span className="builtin-tool-desc">{tool.description}</span>
										</div>
									))}
								</div>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
