// 工具配置页面
//
// # 文件说明书
//
// ## 核心功能
// 工具管理页面，提供工具列表、配置、测试和统计功能。
//
// ## 输入
// - IPC API 调用（toolsList, toolConfigGet, toolConfigSave, toolExecute, toolExecutions*）
//
// ## 输出
// - 工具配置更新
// - 工具测试执行
// - 工具统计展示
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
import React, { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { ToolExecutionStats, ToolExecutionRecord } from "../../../shared/types";

const api = () => (window as any).api;

type DetailTab = "config" | "test" | "stats";

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
	const [detailTab, setDetailTab] = useState<DetailTab>("config");
	const [testInput, setTestInput] = useState<Record<string, any>>({});
	const [testResult, setTestResult] = useState<{ ok: boolean; result?: string; error?: string; elapsedMs: number } | null>(null);
	const [testing, setTesting] = useState(false);

	// Statistics state (per-tool)
	const [stats, setStats] = useState<ToolExecutionStats[]>([]);
	const [recentErrors, setRecentErrors] = useState<ToolExecutionRecord[]>([]);
	const [statsLoading, setStatsLoading] = useState(false);
	const [analysisResult, setAnalysisResult] = useState<string | null>(null);
	const [analyzing, setAnalyzing] = useState(false);
	const [analysisExpanded, setAnalysisExpanded] = useState(false);

	const [loginModalOpen, setLoginModalOpen] = useState(false);
	const [loginUrl, setLoginUrl] = useState("https://");
	const [loginStatus, setLoginStatus] = useState<{ ok: boolean; cookieCount: number; error?: string } | null>(null);
	const [loggingIn, setLoggingIn] = useState(false);
	const [cookieInfo, setCookieInfo] = useState<Record<string, number>>({});

	useEffect(() => {
		(async () => {
			const [t, c] = await Promise.all([api().toolsList(), api().toolConfigGet()]);
			setTools(t ?? []);
			setConfig(c ?? {});
			setLoading(false);
		})();
	}, []);

	const loadStats = useCallback(async (toolName: string) => {
		setStatsLoading(true);
		try {
			const [s, e] = await Promise.all([
				api().toolExecutionsStats(),
				api().toolExecutionsQuery({ toolName, success: false, limit: 20 }),
			]);
			// Filter stats to the selected tool
			const allStats: ToolExecutionStats[] = s ?? [];
			setStats(allStats.filter((st: ToolExecutionStats) => st.toolName === toolName));
			setRecentErrors(e ?? []);
		} finally {
			setStatsLoading(false);
		}
	}, []);

	useEffect(() => {
		if (selected && detailTab === "stats") {
			loadStats(selected);
		}
	}, [selected, detailTab, loadStats]);

	useEffect(() => {
		setTestInput({});
		setTestResult(null);
		setDetailTab("config");
		setLoginStatus(null);
		setLoginModalOpen(false);
	}, [selected]);

	const grouped = tools.reduce((acc: Record<string, any[]>, t: any) => {
		const cat = t.group || t.source || "other";
		(acc[cat] ??= []).push(t);
		return acc;
	}, {} as Record<string, any[]>);

	const runAnalysis = async () => {
		if (analyzing || !selected) return;
		setAnalyzing(true);
		setAnalysisResult(null);
		setAnalysisExpanded(false);
		try {
			const result = await api().toolExecutionsAnalyze(selected);
			if (result.error) {
				setAnalysisResult("Error: " + result.error);
			} else {
				setAnalysisResult(result.analysis);
				setAnalysisExpanded(true);
			}
		} catch (err: any) {
			setAnalysisResult("Error: " + err.message);
		} finally {
			setAnalyzing(false);
		}
	};

	const loadCookieInfo = async () => {
		try {
			const info = await api().webfetchCookies();
			setCookieInfo(info);
		} catch { /* ignore */ }
	};

	const runLogin = async () => {
		if (!loginUrl || loggingIn) return;
		setLoggingIn(true);
		setLoginStatus(null);
		try {
			const result = await api().webfetchLogin(loginUrl);
			setLoginStatus(result);
			if (result.ok) await loadCookieInfo();
		} catch (err: any) {
			setLoginStatus({ ok: false, cookieCount: 0, error: err.message });
		} finally {
			setLoggingIn(false);
		}
	};

	const clearAllCookies = async () => {
		await api().webfetchClearCookies();
		setCookieInfo({});
		setLoginStatus(null);
	};

	const openLoginModal = async () => {
		setLoginModalOpen(true);
		setLoginStatus(null);
		await loadCookieInfo();
	};

	const formatTime = (iso: string) => {
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	};

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

	// Per-tool stats derived from filtered data
	const toolStat = stats.length > 0 ? stats[0] : null;

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
				<button type="button" className="btn-primary" onClick={save}>
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

								{/* Detail panel tab bar */}
								<div className="tools-detail-tabs">
									<button
										type="button"
										className={`tools-detail-tab ${detailTab === "config" ? "active" : ""}`}
										onClick={() => setDetailTab("config")}
									>
										Configuration
									</button>
									<button
										type="button"
										className={`tools-detail-tab ${detailTab === "test" ? "active" : ""}`}
										onClick={() => setDetailTab("test")}
									>
										Test
									</button>
									<button
										type="button"
										className={`tools-detail-tab ${detailTab === "stats" ? "active" : ""}`}
										onClick={() => setDetailTab("stats")}
									>
										Statistics
									</button>
								</div>
							</div>

							{detailTab === "config" && (
								selectedTool.configSchema?.length > 0 ? (
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
								)
							)}

							{selected === "WebFetch" && detailTab === "config" && (
							<div className="tools-page-login-row">
								<button type="button" className="btn-primary btn-sm" onClick={openLoginModal}>
									Cookie Login
								</button>
								{Object.keys(cookieInfo).length > 0 && (
									<span className="tools-page-cookie-badge">
										{Object.values(cookieInfo).reduce((a, b) => a + b, 0)} cookies saved
									</span>
								)}
							</div>
						)}

						{detailTab === "test" && (
								selectedTool.inputFields?.length > 0 ? (
									<div className="tools-page-test-panel">
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
								) : (
									<p className="tools-page-no-config">No testable parameters.</p>
								)
							)}

							{detailTab === "stats" && (
								<div className="tools-stats-content">
									{statsLoading ? (
										<div className="tools-stats-empty">Loading statistics...</div>
									) : !toolStat ? (
										<div className="tools-stats-empty">No execution data for this tool yet.</div>
									) : (
										<>
											{/* Overview cards */}
											<div className="tools-stats-cards">
												<div className="tools-stats-card">
													<div className="tools-stats-card-value">{toolStat.totalCalls.toLocaleString()}</div>
													<div className="tools-stats-card-label">Total Calls</div>
												</div>
												<div className="tools-stats-card">
													<div className="tools-stats-card-value error">{toolStat.errorCount.toLocaleString()}</div>
													<div className="tools-stats-card-label">Errors</div>
												</div>
												<div className="tools-stats-card">
													<div className={`tools-stats-card-value ${toolStat.errorRate > 0.1 ? "error" : ""}`}>
														{(toolStat.errorRate * 100).toFixed(1)}%
													</div>
													<div className="tools-stats-card-label">Error Rate</div>
												</div>
												<div className="tools-stats-card">
													<div className="tools-stats-card-value">{toolStat.avgDurationMs}ms</div>
													<div className="tools-stats-card-label">Avg Duration</div>
												</div>
											</div>

											{/* AI Analysis */}
											<div className="tools-stats-section">
												<div className="tools-stats-analysis-header">
													<h4 className="tools-stats-section-title">AI Analysis</h4>
													<button
														type="button"
														className={"btn-primary btn-sm" + (analyzing ? " disabled" : "")}
														onClick={runAnalysis}
														disabled={analyzing}
													>
														{analyzing ? "Analyzing..." : "Run Analysis"}
													</button>
												</div>
												{analysisResult && (
													<details
														className="tools-stats-analysis-result"
														open={analysisExpanded}
														onToggle={(e: any) => setAnalysisExpanded(e.target.open)}
													>
														<summary>{analysisExpanded ? "Hide Analysis" : "Show Analysis"}</summary>
														<div className="tools-stats-analysis-body">
															{analysisResult}
														</div>
													</details>
												)}
											</div>

											{/* Recent errors */}
											{recentErrors.length > 0 && (
												<div className="tools-stats-section">
													<h4 className="tools-stats-section-title">Recent Errors</h4>
													<div className="tools-stats-errors">
														{recentErrors.map((e) => (
															<div key={e.id} className="tools-stats-error-item">
																<div className="tools-stats-error-header">
																	<span className="tools-stats-error-tool">{e.toolName}</span>
																	<span className="tools-stats-error-time">{formatTime(e.createdAt)}</span>
																</div>
																<div className="tools-stats-error-msg">{e.errorMessage ?? "Unknown error"}</div>
																{e.inputPreview && (
																	<details className="tools-stats-error-details">
																		<summary>Input</summary>
																		<pre>{e.inputPreview}</pre>
																	</details>
																)}
															</div>
														))}
													</div>
												</div>
											)}
										</>
									)}
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
		{loginModalOpen && createPortal(
							<div className="modal-overlay">
								<div className="modal" onClick={(e) => e.stopPropagation()}>
									<div className="modal-header">
										<h3>Cookie Login</h3>
										<button type="button" className="modal-close" onClick={() => setLoginModalOpen(false)}>x</button>
									</div>
									<p className="modal-desc">Open a browser window to log into a website. Cookies will be saved automatically.</p>
									<div className="modal-body">
										<div className="tools-page-config-field">
											<input
												type="text"
												placeholder="https://example.com"
												value={loginUrl}
												onChange={(e) => setLoginUrl(e.target.value)}
											/>
											<button
												type="button"
												className={"btn-primary btn-sm" + (loggingIn ? " disabled" : "")}
												onClick={runLogin}
												disabled={loggingIn || !loginUrl.startsWith("http")}
											>
												{loggingIn ? "Waiting..." : "Open Login Window"}
											</button>
										</div>
										{loginStatus && (
											<div className={"tools-page-login-status " + (loginStatus.ok ? "ok" : "error")}>
												{loginStatus.ok
													? "Saved " + loginStatus.cookieCount + " cookies"
													: "Error: " + (loginStatus.error ?? "unknown")}
											</div>
										)}
										{Object.keys(cookieInfo).length > 0 && (
											<div className="tools-page-cookie-info">
												<h5>Saved Cookies</h5>
												{Object.entries(cookieInfo).map(([domain, count]) => (
													<div key={domain} className="tools-page-cookie-entry">
														<span>{domain}: {count} cookies</span>
													</div>
												))}
												<button type="button" className="btn-sm" onClick={clearAllCookies}>Clear All</button>
											</div>
										)}
									</div>
								</div>
						</div>
				, document.body)}
		</div>
	);
}
