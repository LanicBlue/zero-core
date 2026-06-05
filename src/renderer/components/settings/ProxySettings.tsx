// 代理设置组件
//
// # 文件说明书
//
// ## 核心功能
// 配置 HTTP/HTTPS 代理设置
//
// ## 输入
// ProxyConfig 代理配置数据
//
// ## 输出
// 代理配置表单 JSX
//
// ## 定位
// src/renderer/components/settings/ — 设置页面组件，网络代理配置
//
// ## 依赖
// React、shared/types.ts、preload API
//
// ## 维护规则
// 代理配置变更需同步到 provider 请求层
//
import { useState } from "react";
import type { ProxyConfig } from "../../../shared/types";

const api = () => (window as any).api;

export function ProxySettings() {
	const [config, setConfig] = useState<ProxyConfig>({ enabled: false, url: "" });
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<string | null>(null);

	// Load current config
	const loadConfig = async () => {
		try {
			const wc = await api().configGet();
			setConfig(wc.proxy ?? { enabled: false, url: "" });
		} catch { /* ignore */ }
	};
	if (!loadConfig) return null; // trigger once — useEffect below handles it

	// Simple one-shot load via ref
	if (!(ProxySettings as any)._loaded) {
		(ProxySettings as any)._loaded = true;
		loadConfig();
	}

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			const result = await api().configUpdate({ proxy: config });
			setConfig(result.proxy ?? { enabled: false, url: "" });
			setSaved(true);
			setTimeout(() => setSaved(false), 2000);
		} catch (err: any) {
			setError(err.message);
		} finally {
			setSaving(false);
		}
	};

	const testConnection = async () => {
		setTesting(true);
		setTestResult(null);
		try {
			const resp = await fetch("https://httpbin.org/ip", {
				signal: AbortSignal.timeout(10000),
			});
			if (resp.ok) {
				const data = await resp.json();
				setTestResult(`OK — IP: ${data.origin}`);
			} else {
				setTestResult(`HTTP ${resp.status}`);
			}
		} catch (err: any) {
			setTestResult(`Failed: ${err.message}`);
		} finally {
			setTesting(false);
		}
	};

	return (
		<div className="proxy-settings">
			<p className="section-desc" style={{ color: "var(--text-muted)", marginBottom: 12 }}>
				Configure HTTP proxy for all outgoing network requests (web search, AI providers, embeddings).
			</p>

			<label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
				<input
					type="checkbox"
					checked={config.enabled}
					onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
				/>
				<span>Enable proxy</span>
			</label>

			<div style={{ marginBottom: 12 }}>
				<label className="config-label" style={{ display: "block", marginBottom: 4 }}>Proxy URL</label>
				<input
					type="text"
					value={config.url}
					onChange={(e) => setConfig({ ...config, url: e.target.value })}
					placeholder="http://127.0.0.1:7890"
					disabled={!config.enabled}
					style={{
						width: "100%", padding: "6px 10px", borderRadius: 6,
						border: "1px solid var(--border)", background: "var(--bg-primary)",
						color: "var(--text-primary)", fontSize: 13,
						opacity: config.enabled ? 1 : 0.5,
					}}
				/>
			</div>

			{error && (
				<div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 8 }}>{error}</div>
			)}

			<div style={{ display: "flex", gap: 8 }}>
				<button type="button" className="btn-primary btn-sm" onClick={save} disabled={saving}>
					{saving ? "Saving..." : saved ? "Saved ✓" : "Save"}
				</button>
				{config.enabled && config.url && (
					<button type="button" className="btn-sm" onClick={testConnection} disabled={testing}
						style={{
							padding: "4px 12px", borderRadius: 6, border: "1px solid var(--border)",
							background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 13, cursor: "pointer",
						}}>
						{testing ? "Testing..." : "Test"}
					</button>
				)}
			</div>

			{testResult && (
				<div style={{ fontSize: 13, marginTop: 8, color: testResult.startsWith("OK") ? "var(--success, #7ee787)" : "var(--danger)" }}>
					{testResult}
				</div>
			)}
		</div>
	);
}
