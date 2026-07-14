# acceptance-2:ephemeral turn 基建

> 对应 [./sub-2.md](./sub-2.md)。

## 功能验收

1. **step 不落盘**:ephemeral turn 跑完后,`steps` 表无新增行(`persist:false` 生效,TurnStart/StepEnd hook 跳过)。
2. **wiki 写生效**:ephemeral turn 内的 wiki 工具调用(docWrite 等)成功,wiki store 出现新节点。
3. **中断安全**:ephemeral turn 中途中断(abort/异常)→ 无半截 step 落盘,无脏状态,可重试。
4. **LLM 正常跑**:ephemeral turn 的 LLM 调用 + 工具执行 + emit 与正常 turn 一致(仅持久化被跳过)。

## 不破坏验收

5. 正常 `run()`/`resume()` 的 step 持久化不受影响(回归:普通 turn 仍写 steps)。

## build

6. **typecheck 过**。
