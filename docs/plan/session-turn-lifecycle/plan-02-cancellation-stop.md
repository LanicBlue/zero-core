# Plan 02：Cancellation Tree 与 Stop

## 目标

让 Stop 可靠取消当前前台 Turn，暂停普通队列，并贯穿所有阻塞等待；显式后台任务继续。

## 工作

1. 建立 Session dispose、Turn 和 background task 分离的 cancellation scopes。
2. signal 贯穿 provider stream/concurrency acquire、tool limiter、Wait、AskUser、blocking child。
3. 工具调用上下文暴露 signal 和 cooperative cancellation helper。
4. Stop 进入 cancelling，禁止新 model/tool step 和 post-run queue drain。
5. AskUser 在 Stop/supersede/dispose 时以结构化原因 settle，清理 UI pending state。
6. compression 使用 stage-aware stopRequested；commit settle 后再完成取消。
7. UI 等 backend snapshot 确认，不先乐观 finish streaming。
8. 为 queued provider/tool、Wait、AskUser、blocking child、已提交副作用写 race tests。

## 约束

- Stop 不等于 task cancel。
- 不声称回滚已发生的外部副作用。
- 不保留“abort 返回后自动 drain”兼容路径。

## 完成

[Acceptance 02](acceptance-02-cancellation-stop.md) 通过并创建 `result-02.md`。

