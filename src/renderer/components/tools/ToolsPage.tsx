// 工具配置页面
//
// # 文件说明书
//
// ## 核心功能
// 工具管理页面，提供工具列表、配置和测试功能。
//
// ## 输入
// - IPC API 调用（toolsList, toolConfigGet, toolConfigSave, toolExecute）
//
// ## 输出
// - 工具配置更新
// - 工具测试执行
//
// ## 定位
// 渲染进程页面组件，通过 AppLayout 访问。
//
// ## 依赖
// - react - React 框架
// - window.api - IPC API
//
// ## 维护规则
// - 新增工具配置字段时需同步更新
// - 保持与后端 tool-handlers 接口一致
//
import React, { useState, useEffect } from "react";

const api = () => (window as any).api;

const CATEGORY_LABELS: Record<string, string> = {
	runtime: "Base",
	task: "Task",
	web: "Web",
	memory: "Memory",
	thinking: "Thinking",
	assistant: "Assistant",
	interaction: "Interaction",
	mcp: "MCP",
	agent: "Agent",
};

export default function ToolsPage() {
	const [tools, setTools] = useState<any[]>([]);
	const [config, setConfig] = useState<Record<string, Record<string, any>>>({});
	const [selected, setSelected] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [loading, setLoading] = useState(true);
	const [testInput, setTestInput] = useState<Record<string, any>>({});
	const [testResult, setTestResult] = useState<{ ok: boolean; result?: string; error?: string; elapsedMs: number } | null>(null);
	const [testing, setTesting] = useState(false);

	useEffect(() => {
		(async () => {
			const [t, c] = await Promise.all([api().toolsList(), api().toolConfigGet()]);
			setTools(t ?? []);
			setConfig(c ?? {});
			setLoading(false);
		})();
	}, []);

	useEffect(() => {
		setTestInput({});
		setTestResult(null);
	}, [selected]);

	const grouped = tools.reduce((acc: Record<string, any[]>, t: any) => {
		const cat = t.group || t.source || "other";
		(acc[cat] ??= []).push(t);
		return acc;
	}, {} as Record<string, any[]>);

	const save = async () => {
		await api().toolConfigSave(config);
		setSaved(true);
		setTimeout(() => setSaved(false), 2000);
	};

	const updateField = (toolName: string, key: string, value: any) => {
		setConfig((prev: any) => ({
			...prev,
			[toolName]: { ...(prev[toolName] ?? {}), [key]: value },
		}));
	};

	const updateTestInput = (key: string, value: any) => {
		setTestInput((prev: any) => ({ ...prev, [key]: value }));
	};

	const runTest = async () => {
		if (!selected || testing) return;
		setTesting(true);
		setTestResult(null);
		try {
			const result = await api().toolExecute(selected, testInput);
			setTestResult(result);
		} catch (err: any) {
			setTestResult({ ok: false, error: err.message, elapsedMs: 0 });
		} finally {
			setTesting(false);
		}
	};

	const selectedTool = tools.find((t) => t.name === selected) ?? null;

	if (loading) {
		return (
			<div className="tools-page">
				<div className="tools-page-header">
					<h2>Tools</h2>
				</div>
				<p className="tools-page-empty">Loading tools...</p>
			</div>
		);
	}

	return (
		<div className="tools-page">
			<div className="tools-page-header">
				<h2>Tools</h2>
				<div className="tools-page-header-info">
					<span>{tools.length} tools registered</span>
				</div>
				<button type="button" className="btn-primary btn-sm" onClick={save}>
					{saved ? "Saved!" : "Save Configuration"}
				</button>
			</div>

			<div className="tools-page-body">
				<div className="tools-page-list">
					{Object.entries(grouped).map(([cat, catTools]) => (
						<div key={cat} className="tools-page-category">
							<div className="tools-page-category-title">
								{CATEGORY_LABELS[cat] ?? cat}
								<span className="tools-page-category-count">{catTools.length}</span>
							</div>
							{catTools.map((t: any) => (
								<div
									key={t.name}
									className={"tools-page-list-item" + (selected === t.name ? " active" : "")}
									onClick={() => setSelected(t.name)}
								>
									<span className="tools-page-list-name">{t.name}</span>
									{t.meta?.isDestructive && (
										<span className="tools-page-destructive-dot" title="destructive" />
									)}
								</div>
							))}
						</div>
					))}
				</div>

				<div className="tools-page-detail">
					{selectedTool ? (
						<>
							<div className="tools-page-detail-header">
								<div className="tools-page-detail-title">
									<span className="tools-page-detail-name">{selectedTool.name}</span>
									<span className={"tools-page-source-badge " + selectedTool.source}>
										{selectedTool.source}
									</span>
									{selectedTool.mcpServerName && (
										<span className="tools-page-mcp-badge">{selectedTool.mcpServerName}</span>
									)}
									{selectedTool.meta?.isDestructive && (
										<span className="tools-page-destructive-badge">destructive</span>
									)}
								</div>
								<p className="tools-page-detail-desc">{selectedTool.description}</p>
								{selectedTool.prompt && selectedTool.prompt !== selectedTool.description && (
									<details className="tools-page-ai-prompt-details">
										<summary>AI Prompt</summary>
										<pre className="tools-page-ai-prompt-content">{selectedTool.prompt}</pre>
									</details>
								)}
							</div>

							{selectedTool.configSchema?.length > 0 ? (
								<div className="tools-page-detail-config">
									<h4 className="tools-page-config-heading">Configuration</h4>
									{selectedTool.configSchema.map((field: any) => {
										const val = config[selectedTool.name]?.[field.key] ?? field.default ?? "";
										if (field.key === "auto_background_timeout" && !config[selectedTool.name]?.auto_background) return null;
										return (
											<div key={field.key} className="tools-page-config-field">
												<div className="tools-page-config-label-row">
													<label>{field.label}</label>
													{field.description && (
														<span className="tools-page-config-desc">{field.description}</span>
													)}
												</div>
												{field.type === "boolean" ? (
													<button
														type="button"
														title={val ? "Disable" : "Enable"}
														className={"toggle-switch " + (val ? "on" : "")}
														onClick={() => updateField(selectedTool.name, field.key, !val)}
													/>
												) : field.type === "select" ? (
													<select
														title={field.label}
														value={val}
														onChange={(e) => updateField(selectedTool.name, field.key, e.target.value)}
													>
														{(field.options ?? []).map((o: string) => (
															<option key={o} value={o}>{o}</option>
														))}
													</select>
												) : field.type === "number" ? (
													<input
														type="number"
														title={field.label}
														placeholder={field.label}
														value={val}
														onChange={(e) => updateField(selectedTool.name, field.key, Number(e.target.value))}
													/>
												) : (
													<input
														type={field.key.toLowerCase().includes("key") || field.key.toLowerCase().includes("api") ? "password" : "text"}
														value={val}
														onChange={(e) => updateField(selectedTool.name, field.key, e.target.value)}
														placeholder={field.description ?? ""}
													/>
												)}
											</div>
										);
									})}
								</div>
							) : (
								<p className="tools-page-no-config">No configurable parameters.</p>
							)}

							{selectedTool.inputFields?.length > 0 && (
								<div className="tools-page-test-panel">
									<h4 className="tools-page-config-heading">Test</h4>
									<div className="tools-page-test-body">
										<div className="tools-page-test-input">
											{selectedTool.meta?.isDestructive && (
												<div className="tools-page-test-warning">
													Destructive — will modify real files.
												</div>
											)}
											{selectedTool.inputFields.map((field: any) => (
												<div key={field.key} className="tools-page-config-field">
													<div className="tools-page-config-label-row">
														<label>{field.key}{field.required && " *"}</label>
														{field.description && (
															<span className="tools-page-config-desc">{field.description}</span>
														)}
													</div>
													{field.type === "boolean" ? (
														<button
															type="button"
															title={testInput[field.key] ? "false" : "true"}
															className={"toggle-switch " + (testInput[field.key] ? "on" : "")}
															onClick={() => updateTestInput(field.key, !testInput[field.key])}
														/>
													) : field.type === "select" ? (
														<div className="tools-page-test-combo">
															<input
																type="text"
																title={field.key}
																list={"test-" + field.key}
																placeholder={field.description ?? field.key}
																value={testInput[field.key] ?? ""}
																onChange={(e) => updateTestInput(field.key, e.target.value || undefined)}
															/>
															<datalist id={"test-" + field.key}>
																{field.enum.map((opt: string) => (
																	<option key={opt} value={opt} />
																))}
																<option value="" />
																<option value="__invalid__" />
															</datalist>
														</div>
													) : field.type === "number" ? (
														<input
															type="number"
															placeholder={field.description ?? field.key}
															value={testInput[field.key] ?? ""}
															onChange={(e) => updateTestInput(field.key, e.target.value ? Number(e.target.value) : undefined)}
														/>
													) : (
														<input
															type="text"
															placeholder={field.description ?? field.key}
															value={testInput[field.key] ?? ""}
															onChange={(e) => updateTestInput(field.key, e.target.value || undefined)}
														/>
													)}
												</div>
											))}
											<button
												type="button"
												className={"btn-primary btn-sm tools-page-test-run" + (testing ? " disabled" : "")}
												onClick={runTest}
												disabled={testing}
											>
												{testing ? "Running..." : "Run Test"}
											</button>
										</div>

										<div className="tools-page-test-output-wrap">
											{testResult ? (
												<div className="tools-page-test-output">
													<div className="tools-page-test-output-header">
														<span className={"tools-page-test-status " + (testResult.ok ? "ok" : "error")}>
															{testResult.ok ? "OK" : "ERROR"}
														</span>
														<span className="tools-page-test-elapsed">{testResult.elapsedMs}ms</span>
													</div>
													<pre className="tools-page-test-result">{testResult.result ?? testResult.error}</pre>
												</div>
											) : (
												<div className="tools-page-test-placeholder">Output will appear here</div>
											)}
										</div>
									</div>
								</div>
							)}
						</>
					) : (
						<div className="tools-page-detail-empty">
							<p>Select a tool to view details</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
