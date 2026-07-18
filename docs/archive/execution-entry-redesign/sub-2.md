# sub-2:Shell 恢复 background + timeout 默认

> 所属 effort:execution-entry-redesign(详见 [./design.md](./design.md))。
> 依赖:无(独立,为 sub-4 删 TaskStart{shell} 铺路)。

## 范围

恢复 Shell 的 `background?:true`(sub-4 移除的,从 git 历史捞回),立即后台返回 task_id;timeout 固化默认 300s;去掉 timeout config。**不含超时转后台**(那是 sub-3)。

## 改动

### src/tools/bash.ts
- inputSchema 加 `background: z.boolean().optional()`(参照 sub-4 移除前的形态,git 历史里有;[bash.ts:336](../../../src/tools/bash.ts#L336) 注释 "background:true was removed")
- execute:
  - `background:true` → `fns.runBackground(command)` → 返回 task_id(参照 `task-start.ts:91-117` 的 shell 分支)。立即返回,不等命令。
  - 否则 blocking(现状),timeout 默认改 300s:`const timeoutSec = inputTimeout ?? 300;`(不再读 `config.timeout`,[bash.ts:285](../../../src/tools/bash.ts#L285))
- 去 configSchema 的 timeout 项([bash.ts:262](../../../src/tools/bash.ts#L262))
- callerCtx 无 delegateFns(UI 预览)→ background 模式返 benign preview(参照其他工具的 G1 模式)

### timeout 默认值
- 固化 300s(execute 内硬编码默认,不从 config 读)
- LLM 仍可 input `timeout` 单次覆盖

## 不做(scope 边界)

- 超时转后台(sub-3)—— 本 sub 超时仍是 kill([bash.ts:372](../../../src/tools/bash.ts#L372) 现状)
- 删 TaskStart{shell}(sub-4)
- 改 prompt 互引(sub-5)
- 修 [bash.ts:244](../../../src/tools/bash.ts#L244) 过时文案(sub-5)

## 验证

见 [./acceptance-2.md](./acceptance-2.md)。
