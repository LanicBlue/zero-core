// Generic config-sync StepEnd hook (wiki-system-redesign plan-05 §7).
//
// # 文件说明书
//
// ## 核心功能
// 把 AgentService 排队的 pending generic config patch 在 busy loop 的
// StepEnd 安全边界应用到 AgentLoop。section 维度通用 —— 不含 Wiki 专用
// 判断(plan-05 §7 + feedback-agent-loop-hooks-only + acceptance-05 §D 41-44)。
//
// ## 触发模型
// AgentService 维护每 session 的 pending config patch:
//   - session create / active project change / Agent grants/context publish /
//     显式 refresh / memory archive 完成时,AgentService 把 patch 排队。
//   - **idle session** → AgentService 立即直接调 `loop.applyConfigUpdate(patch)`。
//   - **busy session** → patch 留在队列;StepEnd hook 在每步安全边界调用
//     host 注入的 `flushPendingConfigUpdate(sessionId)` 取出 patch 并应用。
//   - **在途 tool call** → patch 不会影响当前 turn 的 wikiAccess 快照
//     (CallerCtx.wikiAccess 已被 buildRequestContext 拷贝;新 patch 只影响
//     下一个 tool call / 下一 turn 的 system section)。
//
// ## 关键不变量
//   - **通用** hook:不 import Wiki compiler/store,不出现 'wiki-context' /
//     'wiki-system-anchors' 字面量,不读 access.grants 判 Wiki。
//   - **hooks-only**:在 `src/runtime/hooks/` 下,经 registerHooksForLoop 注册,
//     不内联进 agent-loop.ts(feedback-agent-loop-hooks-only)。
//   - **StepEnd**:本 sub 阶段新增/修改代码中 PostTurnComplete 零引用
//     (acceptance-05 §D 42)。
//   - **安全边界**:在 streamText 的 finish-step 之后、下一步 streamText
//     之前应用,避免半应用状态(下一次 tool call 拿到的是完整的 compiled access)。
//   - **失败容忍**:flush 失败记 warn,不阻断 StepEnd 链(其它 hook 仍要跑)。
//
// ## AgentService 注入
// AgentService 把 `flushPendingConfigUpdate` 函数放到 hook 的 deps 里。
// 该函数读 AgentService 的 pendingPatch Map,取出对应 sessionId 的 patch
// (取出即清空 —— 每个排队的 patch 只应用一次)。
//
// 参见:
//   - docs/plan/wiki-system-redesign/plan-05-agent-runtime-prompt.md §7
//   - src/runtime/agent-loop.ts(applyConfigUpdate 消费 patch)
//   - src/server/agent-service.ts(pendingPatch 维护)

import type { HookRegistry } from "../../core/hook-registry.js";
import { log } from "../../core/logger.js";

/**
 * AgentService 注入的 flush 函数。返回 pending patch 或 null(无 patch)。
 *
 * 取出即清空 —— 每个排队的 patch 只应用一次。AgentService 在 idle session
 * 直接调 `loop.applyConfigUpdate`(不经 hook);busy session 才走本 hook。
 */
export type FlushPendingConfigUpdate = (
	sessionId: string,
) => ConfigSyncPatch | null;

/**
 * 通用 config-sync patch。`targetLoop` 是 AgentService 拿到的 loop 实例;
 * `update` 是 applyConfigUpdate 的入参(任意子集字段)。
 *
 * Wiki section / wikiAccess / dynamicSystemSections / systemPrompt 等都通走
 * 这个 patch —— AgentService 决定 patch 内容,hook 只负责在 StepEnd 应用。
 */
export interface ConfigSyncPatch {
	/** 目标 sessionId(校验防止跨 session 误应用)。 */
	sessionId: string;
	/** applyConfigUpdate 的入参(部分字段;详见 AgentLoop.applyConfigUpdate)。 */
	update: Record<string, unknown>;
}

/**
 * config-sync hook 的依赖。
 *
 * AgentService 在 buildHookDeps 时构造 flushPendingConfigUpdate 闭包并传入。
 */
export interface ConfigSyncHooksDeps {
	/** 取出 pending patch(取出即清空)。无 patch 返 null。 */
	flushPendingConfigUpdate: FlushPendingConfigUpdate;
	/**
	 * 可选:把 loop 实例的 applyConfigUpdate 暴露给 hook。AgentService 注册
	 * 时把 loopByIdx(sessionId → loop)的查找函数传进来;hook 用 sessionId
	 * 解析 loop,然后调 loop.applyConfigUpdate(patch.update)。
	 */
	resolveLoop: (sessionId: string) => {
		applyConfigUpdate(update: Record<string, unknown>): void;
	} | null;
}

/**
 * 注册 config-sync StepEnd hook。AgentService 在 registerHooksForLoop 之外
 * 显式调用(registerHooksForLoop 的 deps 不含 flushPendingConfigUpdate ——
 * 那是 AgentService 拥有的运行时状态,不该进通用 HookWiringDeps)。
 *
 * 注册位置:StepEnd。在所有持久化 hook 之后(metrics / durable / turn-hooks)
 * 应用 —— 保证 patch 应用时本步已完整落盘,下一 turn 拿到的是干净状态。
 */
export function registerConfigSyncHooks(
	registry: HookRegistry,
	deps: ConfigSyncHooksDeps,
): void {
	registry.register("StepEnd", async (ctx: Record<string, unknown>) => {
		const sessionId = ctx.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) return;
		try {
			const patch = deps.flushPendingConfigUpdate(sessionId);
			if (!patch) return;
			if (patch.sessionId !== sessionId) {
				log.warn(
					"config-sync",
					`StepEnd: patch sessionId mismatch (${patch.sessionId} ≠ ${sessionId}) — skipped`,
				);
				return;
			}
			const loop = deps.resolveLoop(sessionId);
			if (!loop) {
				log.warn(
					"config-sync",
					`StepEnd: loop not found for sessionId=${sessionId} — patch discarded`,
				);
				return;
			}
			loop.applyConfigUpdate(patch.update);
		} catch (err) {
			log.warn(
				"config-sync",
				`StepEnd flush failed (session=${sessionId}): ${(err as Error).message}`,
			);
		}
	});
}
