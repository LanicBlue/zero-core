# Plan 05：Compacting 与统一 UI/API

## 目标

把 compression 变成显式 Session 状态，并让 UI、HTTP initial snapshot 与 WS 增量共同消费
统一 lifecycle DTO。

## 工作

1. compression coordinator 发布 memory/rewrite/commit phase。
2. memory/rewrite cooperative cancel；commit 最小临界段 settle 后处理 Stop。
3. compacting 期间普通 invocation 入 inbox，task event 入 event inbox。
4. commit 后严格按 Stop → handoff/queue → 原 Turn completion 顺序归并。
5. UI 展示 running、waiting reason、needs_input、compacting phase、cancelling、queue paused/count、
   background counts。
6. 重连先应用新 revision snapshot，再接收增量。
7. 增加组件测试、WS reconnect 和 compact/Stop/input/task 四方 race。

## 完成

[Acceptance 05](acceptance-05-compacting-ui.md) 通过并创建 `result-05.md`。

