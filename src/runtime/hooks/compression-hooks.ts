// StepEnd 压缩钩子 — steps-overhaul sub-3: DISABLED (no-op).
//
// # 文件说明书
//
// ## 核心功能(当前)
// registerCompressionHooks 仍向 StepEnd 注册一个处理器,但处理器**立即 no-op 返回**。
// 本文件不再执行任何压缩。这是 sub-3 把 `messages` 表语义从"LLM 视图内容落盘"
// 重定义为"summary 块 + 压缩游标"后的过渡产物:
//   - 旧 L1/L2(`compression-engine.ts`)写老 shape 的 messages + 调已删的
//     `syncTurnsAfterCompression`/`replaceStepsFromMessages` → 一跑就崩。
//   - 新压缩核心(Extractor A,多步 agent)由 **sub-4** 落地:它会调
//     `db.saveSummaryAndAdvanceCursor(...)`(sub-3 已就位)写 summary + 推进游标。
//   - sub-3 → sub-4 之间无压缩(过渡;阶段2 的中间区 tool stub 由组装规则常驻提供,
//     不依赖本 hook)。
//
// ## 为什么保留死代码而不删整个文件
// sub-4 的拆除清单明确认领:删 `compression-engine.ts`(L1/L2/identifyTurns/
// TurnBoundary)+ 旧配置键 + 本 hook 的 StepEnd 触发器(届时 no-op 注册也一并删)。
// sub-3 只禁用触发(避免崩溃)+ 删旁路 sync;引擎代码本身留死代码给 sub-4 一次性清。
// hooks/index.ts 仍 import + register,保持注册签名稳定,sub-4 移除时只动两处。
//
// ## 已删(sub-3)
// - syncTurnsAfterCompression(把压缩 messages 重灌进 steps 表的旁路)—— messages
//   改引用模型后 LLM view 从 messages.summary + steps[压缩游标..] 组装,
//   turns/steps sync 不再必要;它也是 sub-2 Lens B 标的"从 messages 重灌原始字节
//   进 steps"的旁路,删掉闭合 steps 不可变不变量。
//
// ## 定位
// runtime/hooks 层。当前为过渡占位;sub-4 整体拆除。
//
// ## 维护规则
// - sub-4 落地时:删本文件的 StepEnd 注册(或换成新 Extractor A 触发器)、删
//   compression-engine.ts、删 SessionConfig.compression 的 l1Threshold/l2Threshold/
//   keepRecentTurns 旧键。本文件届时可整体退役或重写为新触发器宿主。

import { HookRegistry } from "../../core/hook-registry.js";
import { log } from "../../core/logger.js";

/**
 * sub-3: register a NO-OP StepEnd handler. The old compression trigger is
 * disabled because it relied on the retired messages-table shape + the deleted
 * syncTurnsAfterCompression/replaceStepsFromMessages path. The replacement
 * (Extractor A, stage-3 compression) lands in sub-4.
 *
 * We still register (rather than removing the call from hooks/index.ts) so the
 * hook wiring surface stays stable — sub-4 removes this whole module in one
 * shot. The no-op logs once at debug level so a tracer can see it fired.
 */
export function registerCompressionHooks(registry: HookRegistry = HookRegistry.getInstance()): void {
	registry.register("StepEnd", async (_ctx) => {
		// steps-overhaul sub-3: compression disabled (transition to sub-4's
		// Extractor A). Old L1/L2 engine code is retained as dead code; this
		// handler must NOT call it — it would write the retired messages shape
		// and invoke the deleted sync path, crashing the step.
		log.debug("compression", "StepEnd compression trigger skipped (steps-overhaul sub-3 disabled; sub-4 lands Extractor A)");
		return;
	});

	log.debug("hooks", "Compression hooks registered (StepEnd) — NO-OP (steps-overhaul sub-3; sub-4 will replace)");
}
