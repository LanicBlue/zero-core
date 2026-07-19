// Wiki v2 工具注册入口(wiki-system-redesign plan-05 §5 原子切换)
//
// # 文件说明书
//
// ## 核心功能
// 把 `createWikiTool(deps)` 工厂(sub-04 deliverable,sub-05 前未注册)原子
// 注册到 ToolRegistry,取代本文件历史上 10-action 的旧实现。
//
// **新 action 闭集(design.md §8.1,9 个)**:
//     expand / read / search / create / update / delete / link / unlink / move
//
// 旧 action 全部退役:
//     createMemory / updateMemory / docRead / docWrite / docEdit
// Agent 调旧 action 由 zod schema 校验失败返 schema validation error(不 fallback)。
//
// ## 旧实现删除清单(plan-05 §5)
//   - `wikiActionSchema`(旧 10-action schema)—— **删除**。
//   - `buildGlobalAnchorWikiCallerCtx`(memory turn 全树权限捷径)—— **删除**。
//     plan-05 §8 明确要求:memory turn 不再隐式全树;改由 AgentService 在
//     session build 时显式编译 CompiledWikiAccess(只含 own memory grant)。
//   - `groupByParent` / `collectSubtree` / `resolveNodeIdArg` 等旧 helper ——
//     **删除**(v2 实现里对应逻辑在 WikiService / WikiSearchService)。
//   - 旧 wiki-anchor 注入(`formatNodeId` / `formatBodySize` / `shortIdOf`)——
//     退役;v2 schema 不接受 nodeId,只接受 logical address / canonical path。
//
// ## 懒加载策略
// `tools/index.ts` 在 module load 时把 `wikiTool` 放进 `TOOL_DEFS`,但此刻
// `server/index.ts` 还没执行 —— WikiService / WikiSearchService 尚未注册到
// `wiki-runtime` 单例。因此 `createWikiTool` 的 deps 必须以 getter 形态传入,
// execute 调用时才解析(lazy resolve)。schema / prompt / format 不依赖 deps,
// 可在 module load 时直读 v2 模块的导出常量。
//
// 参见:
//   - docs/archive/wiki-system-redesign/plan-05-agent-runtime-prompt.md §5
//   - src/tools/wiki-v2-tool.ts(factory + schema + prompt + format)
//   - src/server/wiki/wiki-runtime.ts(单例 getter)

import { createWikiTool } from "./wiki-v2-tool.js";
import { getWikiService, getWikiSearchService } from "../server/wiki/wiki-runtime.js";

/**
 * Wiki v2 工具实例(注册到 ToolRegistry)。
 *
 * 通过 getter 形态把 deps 延迟到 execute 时解析,避开 module-load 时序陷阱。
 * `createWikiTool` 内部 buildTool 仍然在 import 时执行一次(锁 name/description
 * /prompt/schema/format 等静态字段),但 execute 调用时才读 `getWikiService()`
 * / `getWikiSearchService()` 的当前返回值。runtime 单例由 `server/index.ts`
 * 在 WikiService / WikiSearchService 构造完成后调用 `setWikiRuntime` 注册。
 *
 * 工具名为 `"Wiki"`(与旧实现同名,acceptance-05 §B「ToolRegistry 对 Agent
 * 只暴露一个名为 Wiki 的新 schema」),无 Legacy / V2 / fallback 别名。
 */
export const wikiTool = createWikiTool({
	wikiService: getWikiService,
	searchService: getWikiSearchService,
});

// 历史导出清单(已删除,仅留注释便于 grep 找到迁移点):
//   - wikiActionSchema         → 旧 10-action schema;v2 用 wikiV2ActionSchema
//                                 (从 wiki-v2-tool.ts 导出,顶层 z.object)。
//   - buildGlobalAnchorWikiCallerCtx → 退役;memory turn 的 own-memory grant
//                                      由 AgentService 在 session build 编译。
