// 网络代理管理器
//
// # 文件说明书
//
// ## 核心功能
// 管理全局 HTTP 代理配置，通过 undici 的 setGlobalDispatcher 设置或清除 ProxyAgent
//
// ## 输入
// ProxyConfig（enabled、url），可选的代理配置对象
//
// ## 输出
// applyProxy 设置全局代理、isProxyActive 查询代理状态、getProxyUrl 占位接口
//
// ## 定位
// src/runtime/ — 运行时网络基础设施，被 config 加载和 Provider 调用链使用
//
// ## 依赖
// undici（ProxyAgent、setGlobalDispatcher、Agent）、../shared/types
//
// ## 维护规则
// 代理 URL 变更需先调用 applyProxy 清除旧代理再设置新代理
// 代理关闭时需恢复默认 Agent 避免请求中断
//
import { ProxyAgent, setGlobalDispatcher, Agent } from "undici";
import type { ProxyConfig } from "../shared/types.js";

let currentAgent: ProxyAgent | undefined;
let defaultAgent: Agent | undefined;

export function applyProxy(config?: ProxyConfig): void {
	// Clear previous proxy agent
	if (currentAgent) {
		try { currentAgent.close(); } catch { /* ignore */ }
		currentAgent = undefined;
	}

	if (config?.enabled && config.url) {
		currentAgent = new ProxyAgent({
			uri: config.url,
			requestTls: { timeout: 30_000 },
		});
		setGlobalDispatcher(currentAgent);
		console.log(`[proxy] Applied proxy: ${config.url}`);
	} else {
		// Restore default dispatcher
		if (!defaultAgent) defaultAgent = new Agent();
		setGlobalDispatcher(defaultAgent);
		console.log(`[proxy] Proxy disabled, using direct connection`);
	}
}

export function isProxyActive(): boolean {
	return currentAgent !== undefined;
}

export function getProxyUrl(): string | undefined {
	return undefined; // not exposed — use isProxyActive()
}
