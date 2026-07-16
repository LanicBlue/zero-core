// tool-decoupling(决策 1 + 决策 6):app 级服务实例的启动注册。
//
// 工具(execute)直读数据源模块(getter/setter 单例),不靠 per-loop ctx 注入。
// 这要求每个数据源模块在 **任何工具调用前** 注册实例。两处启动路径都要调:
//
// - server/index.ts 的 startServer()(完整 app:所有 stores 都有)。
// - cli.ts 的 main()(headless:多数 stores 缺,getter 返 undefined →
//   数据工具优雅报错,design 决策 6)。
//
// 本文件抽出共用注册逻辑,两处都调 `registerServerInstances({...})`,避免
// server/cli 双份漂移(同 design 决策 6)。
//
// # 文件说明书
// ## 核心功能
// registerServerInstances(deps) —— 把启动时构造的 store/service 实例写进
// 各模块的 process-wide 单例。
// ## 输入
// ServerInstances —— 可选字段;缺省(undefined)的就不注册(headless 路径)。
// ## 输出
// 无(副作用:写各模块单例)。
// ## 定位
// src/server/ —— 启动 wiring,被 server/index.ts + cli.ts 共用。
// ## 维护规则
// - 新增"工具要读的数据源模块"时:(1) 该模块加 getter/setter;(2) 在此加字段 +
//   setXxx 调用;(3) server/index.ts 构造时传实例。
// - 字段全部可选(headless 兼容)。

import { setAgentService } from "./agent-service.js";
import { setCoreDatabase } from "./core-database.js";
import { setWikiStoreGlobal, type WikiStore } from "./wiki-node-store.js";
import { setProjectWikiStore, type ProjectWikiStore } from "./project-wiki-store.js";
import { setRequirementStore, type RequirementStore } from "./requirement-store.js";
import { setManagementService, type ManagementService } from "./management-service.js";
import { setPmService, type PmService } from "./pm-service.js";
import { setToolUsageStore, type ToolUsageStore } from "./tool-usage-store.js";
import type { AgentService } from "./agent-service.js";
import type { CoreDatabase } from "./core-database.js";

/**
 * 启动时已构造的 app 级服务实例集合。字段全可选 —— headless/CLI 路径只
 * 构造其中一部分,缺的留 undefined(对应 getter 返 undefined,工具降级)。
 *
 * server/index.ts 构造齐全;cli.ts 通常只传 sessionDB(其它 stores 不起)。
 */
export interface ServerInstances {
	agentService?: AgentService;
	sessionDB?: CoreDatabase;
	wikiStoreGlobal?: WikiStore;
	projectWikiStore?: ProjectWikiStore;
	requirementStore?: RequirementStore;
	managementService?: ManagementService;
	pmService?: PmService;
	toolUsageStore?: ToolUsageStore;
}

/**
 * 把启动构造的实例写进各数据源模块的 process-wide 单例。在任何工具调用前
 * 调一次(server/cli 启动序)。undefined 字段跳过(不覆盖,保留旧值/undefined)。
 *
 * 注意:这是单向"设置最新实例"——热重载(dev watcher 重启)时会重设,
 * 但工具若在切换瞬间读旧实例会拿到 stale 句柄。当前可接受(同 ctx 注入的
 * 既有 race);sub-2+ 若需要更强一致性再处理。
 */
export function registerServerInstances(deps: ServerInstances): void {
	if (deps.agentService !== undefined) setAgentService(deps.agentService);
	if (deps.sessionDB !== undefined) setCoreDatabase(deps.sessionDB);
	if (deps.wikiStoreGlobal !== undefined) setWikiStoreGlobal(deps.wikiStoreGlobal);
	if (deps.projectWikiStore !== undefined) setProjectWikiStore(deps.projectWikiStore);
	if (deps.requirementStore !== undefined) setRequirementStore(deps.requirementStore);
	if (deps.managementService !== undefined) setManagementService(deps.managementService);
	if (deps.pmService !== undefined) setPmService(deps.pmService);
	if (deps.toolUsageStore !== undefined) setToolUsageStore(deps.toolUsageStore);
}
