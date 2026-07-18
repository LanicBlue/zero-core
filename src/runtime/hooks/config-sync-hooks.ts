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
//   - **合并语义(round-2 fix §3)**:busy session 在一个 Step 边界内可能累积
//     多个 patch(如 onChange FULL SessionConfig + refresh wiki-only)。flush
//     按入队顺序浅合并 —— 同字段后写覆盖前写,异字段都保留;整体替换字段
//     (dynamicSystemSections/capabilities/wikiAccess 等)取最末值原样替换。
//   - **失败容忍 + 恢复**:flush 不清空队列;apply 成功后才 confirm 清空。
//     apply 失败则合并后的整批 patch 留队列,下个 StepEnd 重新 flush + apply
//     (applyConfigUpdate 是内存操作,不会持续失败,bounded 重试无损)。
//     flush 自身失败/loop 丢失只记 warn,不阻断 StepEnd 链(其它 hook 仍要跑)。
//
// ## AgentService 注入
// AgentService 把 `flushPendingConfigUpdate`(peek + merge,不清空)+
// `confirmPendingConfigApplied`(apply 成功后清空)两个函数放到 hook 的 deps
// 里。flush 读 AgentService 的 pendingPatch Map,返回合并后的 patch;
// confirm 清空对应 sessionId 的队列。
//
// 参见:
//   - docs/plan/wiki-system-redesign/plan-05-agent-runtime-prompt.md §7
//   - src/runtime/agent-loop.ts(applyConfigUpdate 消费 patch)
//   - src/server/agent-service.ts(pendingPatch 维护)

import type { HookRegistry } from "../../core/hook-registry.js";
import { log } from "../../core/logger.js";

/**
 * AgentService 注入的 flush 函数:返回 pending patch 的合并结果(或 null
 * 表示无 patch)。**不清空队列** —— 合并是只读 peek。
 *
 * 合并语义(round-2 fix §3):同一 sessionId 队列里所有 patch.update 按入队
 * 顺序浅合并到一个对象 —— 同字段后写覆盖前写,异字段都保留;整体替换字段
 * (dynamicSystemSections/capabilities/wikiAccess 等)取最末值原样替换,不数组
 * 拼接、不深合并。这样早到的 FULL SessionConfig patch 的 systemPrompt/modelId
 * /toolPolicy/capabilities 不会被后到的 wiki-only patch 整对象丢弃。
 *
 * 清空队列由独立的 confirmPendingConfigApplied 在 apply 成功后调用,保证
 * apply 失败时整批 patch 还在队列里、下个 StepEnd 可重试。AgentService 在
 * idle session 直接调 `loop.applyConfigUpdate`(不经 hook);busy session 才
 * 走本 hook。
 */
export type FlushPendingConfigUpdate = (
	sessionId: string,
) => ConfigSyncPatch | null;

/**
 * AgentService 注入的 confirm 函数:清空指定 sessionId 的 pending 队列。
 *
 * hook 仅在 applyConfigUpdate 成功后调用;apply 失败时不调,合并后的 patch
 * 留在队列里,下个 StepEnd 重新 flush + apply(applyConfigUpdate 是内存操作,
 * 不会持续失败,bounded 重试无损)。
 */
export type ConfirmPendingConfigApplied = (sessionId: string) => void;

/**
 * 通用 config-sync patch。`targetLoop` 是 AgentService 拿到的 loop 实例;
 * `update` 是 applyConfigUpdate 的入参(任意子集字段)。
 *
 * Wiki section / wikiAccess / dynamicSystemSections / systemPrompt 等都通走
 * 这个 patch —— AgentService 决定 patch 内容,hook 只负责在 StepEnd 应用。
 *
 * 当 flush 返回的 patch 由多个排队 patch 合并而成时,update 是合并后的
 * 统一对象(详见 FlushPendingConfigUpdate)。
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
 * AgentService 在 buildHookDeps 时构造 flushPendingConfigUpdate(peek+merge,
 * 不清空)+ confirmPendingConfigApplied(apply 成功后清空)闭包并传入。
 */
export interface ConfigSyncHooksDeps {
	/**
	 * 取出 pending patch 的合并结果(不清空队列)。无 patch 返 null。多个
	 * patch 按入队顺序浅合并:同字段后写覆盖前写,异字段都保留;整体替换
	 * 字段取最末值原样替换。
	 */
	flushPendingConfigUpdate: FlushPendingConfigUpdate;
	/**
	 * 确认 pending patch 已成功 apply,清空队列。hook 仅在 applyConfigUpdate
	 * 成功后调用;失败时不调,合并后的 patch 留队列等下个 StepEnd 重试。
	 */
	confirmPendingConfigApplied: ConfirmPendingConfigApplied;
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
		// round-2 fix §3:flush → apply → confirm-on-success。
		// flush 返回队列合并后的 patch(不清空);apply 成功才 confirm 清空,
		// apply 失败则整批 patch 留队列、下个 StepEnd 重新 flush + apply
		// (applyConfigUpdate 是内存操作,不会持续失败,bounded 重试无损)。
		//
		// 本变更只改"如何合并 + 失败如何恢复",**不改 apply 时机**:apply
		// 仍发生在 StepEnd 安全边界。当前 tool call 的 CallerCtx 快照
		// (wikiAccess / systemPrompt / ...)在 buildRequestContext 里已拷贝,
		// 本 patch 只影响下一个 tool call / 下一 turn 的 system section ——
		// StepEnd snapshot 不变量保持(feedback-verify-runtime-wiring)。
		let patch: ConfigSyncPatch | null;
		try {
			patch = deps.flushPendingConfigUpdate(sessionId);
		} catch (err) {
			log.warn(
				"config-sync",
				`StepEnd flush failed (session=${sessionId}): ${(err as Error).message}`,
			);
			return;
		}
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
				`StepEnd: loop not found for sessionId=${sessionId} — patch left in queue for retry`,
			);
			return;
		}
		try {
			loop.applyConfigUpdate(patch.update);
		} catch (err) {
			// 不 confirm —— 合并后的整批 patch 留队列,下个 StepEnd 重新
			// flush + apply。applyConfigUpdate 是内存操作,不会持续失败,
			// bounded 重试无损。
			log.warn(
				"config-sync",
				`StepEnd applyConfigUpdate failed (session=${sessionId}): ${(err as Error).message} — merged patch retained for next StepEnd retry`,
			);
			return;
		}
		// apply 成功才清空队列。
		deps.confirmPendingConfigApplied(sessionId);
	});
}
