# sub-6:force-Wait hook

> 依赖:**sub-4**(后台 task 检测)、**sub-5**(Wait 工具)。对应 design §2.1。

## 目标

turn 想结束时若仍有 running 后台 task,注入 system step "还有 task 在跑,请 Wait" 再跑一步。保证后台子结构上不可能越过父 turn。

## 范围 / 改动

- **新 hook**(`src/runtime/hooks/`,注册到 PostTurnComplete 或 finish-step):
  - turn 即将结束时,检查 TaskRegistry 是否有 running/finishing task。
  - 若有 → 注入 system 消息 "仍有后台 task 运行,请用 Wait 等待" → 跑一个 step(不结束 turn)。
  - nudge **一次/turn-end 尝试**(用一个 "已 nudge" 标记,避免无限循环);Wait timeout 兜底。
- 落点符合"功能走 hook"红线(不内联 AgentLoop)。

## 不在本 sub

- Wait 工具本身(sub-5)。
- TaskRegistry 检测能力(sub-4 已有 list/hasRunning)。

## 风险

- 死循环:nudge 后 agent 仍不调 Wait、又结束 turn → 再 nudge。靠"已 nudge"标记 + Wait timeout 兜底。
- nudge 消息干扰:agent 正常想结束(已无后台 task)时不应触发 —— 严格 gate 在"有 running task"。
- 与 Wait user-input-turn+1 的交互:Wait 中 turn 已挂起,不触发 turn-end nudge。

## 验收

见 `acceptance-6.md`。
