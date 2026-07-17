// Wiki v2 运行时单例(wiki-system-redesign plan-05 §5)
//
// # 文件说明书
//
// ## 核心功能
// 进程级单例注册,持有 `WikiService`(sub-02)+ `WikiSearchService`(sub-03)
// 实例。plan-05 在 `server/index.ts` 启动序列中调用 `setWikiRuntime(...)`,
// 之后 Wiki v2 工具(`createWikiTool` factory)通过 `getWikiService()` /
// `getWikiSearchService()` 直读最新实例。
//
// ## 设计依据
// - 与现有 `setManagementService` / `setAgentService` / `getWikiStoreGlobal`
//   单例模式一致(tool-decoupling 决策 1)。
// - WikiService / WikiSearchService 不再经 ToolExecutionContext 或 ctx 注入 ——
//   工具直接 import getter,避免 per-loop handle 漂移。
// - 头部加载顺序:`server/index.ts` 在 WikiDatabase + 各 repo 构造完成后、
//   任何 session restore / tool 调用前 setWikiRuntime。
//
// ## 缺失行为
// - 未 setWikiRuntime 时 getter 返 undefined。Wiki v2 工具在 callerCtx.wikiAccess
//   缺失时立即 ACCESS_DENIED,所以 undefined service 不会触发崩溃 —— 但会让所有
//   Wiki 调用失败(测试环境 / headless 路径需注意)。
//
// 参见:
//   - docs/plan/wiki-system-redesign/plan-05-agent-runtime-prompt.md §5
//   - src/tools/wiki-v2-tool.ts(factory)
//   - src/server/index.ts(注册点)

import type { WikiService } from "./wiki-service.js";
import type { WikiSearchService } from "./wiki-search-service.js";

interface WikiRuntime {
	readonly wikiService: WikiService;
	readonly searchService: WikiSearchService;
}

let runtime: WikiRuntime | undefined;

/**
 * 注册 Wiki v2 运行时单例。`server/index.ts` 在 WikiService +
 * WikiSearchService 构造完成后调用一次。重复调用覆盖前值(测试场景需 reset)。
 */
export function setWikiRuntime(rt: WikiRuntime | null): void {
	runtime = rt ?? undefined;
}

/** 读取已注册的 WikiService 单例(未注册返 undefined)。 */
export function getWikiService(): WikiService | undefined {
	return runtime?.wikiService;
}

/** 读取已注册的 WikiSearchService 单例(未注册返 undefined)。 */
export function getWikiSearchService(): WikiSearchService | undefined {
	return runtime?.searchService;
}

/**
 * Test-only: reset 单例(便于单元测试隔离)。production 永不调用。
 */
export function _resetWikiRuntimeForTests(): void {
	runtime = undefined;
}
