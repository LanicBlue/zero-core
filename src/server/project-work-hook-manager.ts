// project-work hook 触发器
//
// # 文件说明书
//
// ## 核心功能
// 订阅 data-change-hub 的 domain 事件(requirements/projects/crons/agents 的
// create/update/delete),按 `${collection}.${op}` 拼事件名,匹配
// project_work.hooks[].event;命中且 record.projectId 一致 → 调
// ProjectWorkRunner.fireProjectWork(空岗/缺工具自动 skip)。复用 data-change-hub
// 的 tick coalesce(同 tick 多变更已去重),非净新增事件总线。
//
// plan-08 §1:`project_wiki` 不再在 data-change-hub 白名单里(project_wiki 表
// 退役 + ProjectWikiStore 删除),本管理器不会再收到 project_wiki.* 事件。
//
// ## 输入
// - data-change-hub 事件流
//
// ## 输出
// - 命中的 project-work 被触发(agent 收到 actionPrompt user message)
//
// ## 定位
// 服务层,server/index.ts 构造时 start(),会话期内常驻。
//
// ## 依赖
// - ./data-change-hub onDataChange
// - ./project-work-store listWithHook
// - ./project-work-runner fireProjectWork
//

import { onDataChange, type DataChangeEvent } from "./data-change-hub.js";
import type { ProjectWorkStore } from "./project-work-store.js";
import type { ProjectWorkRunner } from "./project-work-runner.js";
import { log } from "../core/logger.js";

export interface ProjectWorkHookManagerDeps {
	projectWorkStore: ProjectWorkStore;
	projectWorkRunner: ProjectWorkRunner;
}

export class ProjectWorkHookManager {
	private deps: ProjectWorkHookManagerDeps;
	private unsubscribe?: () => void;
	/** 正在触发的 work(去重:同一 work 并发只跑一个,避免事件风暴)。 */
	private inFlight = new Set<string>();

	constructor(deps: ProjectWorkHookManagerDeps) {
		this.deps = deps;
	}

	/** 订阅 data-change-hub。返回 stop 函数(测试/拆除用)。 */
	start(): () => void {
		this.unsubscribe = onDataChange((e) => {
			void this.handleDataChange(e);
		});
		return () => this.stop();
	}

	stop(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
	}

	private async handleDataChange(e: DataChangeEvent): Promise<void> {
		// 事件名约定:`${collection}.${op}` —— 如 "requirements.create"。
		// project-flow F2: 若 change 带 `signal`(命名迁移信号,如 "ready"),
		// 用 `${collection}.${signal}`(如 "requirements.ready")。两种事件名同款
		// 字符串匹配 work.hooks[].event。record.projectId 过滤到该 project 的 work。
		for (const change of e.changes) {
			const event = change.signal ? `${e.collection}.${change.signal}` : `${e.collection}.${change.op}`;
			const record = change.record as { projectId?: string } | undefined;
			const projectId = record?.projectId;
			if (!projectId) continue; // 无 projectId 的事件无法定位 project,跳过
			const candidates = this.deps.projectWorkStore.listWithHook(event);
			for (const work of candidates) {
				if (work.projectId !== projectId) continue;
				if (this.inFlight.has(work.id)) continue; // 同 work 并发去重
				this.inFlight.add(work.id);
				try {
					const result = await this.deps.projectWorkRunner.fireProjectWork(work.id, {
						requirementId: e.collection === "requirements" ? change.id : undefined,
					});
					if (result.status === "error") {
						log.warn("project-work", `hook ${event} → work ${work.id} error: ${result.error}`);
					}
				} catch (err) {
					log.warn("project-work", `hook ${event} → work ${work.id} threw: ${(err as Error).message}`);
				} finally {
					this.inFlight.delete(work.id);
				}
			}
		}
	}
}
