# acceptance-2:三通道内容重构

对应 `sub-2.md`。

## 用例

1. **内容各归各位**:
   - system 含:role、guidelines、OS/cwd、Wiki Anchors(根+一层)、Project、Requirement。
   - context(持久)仅含:Recalled Memories(本次可空)。
   - workbench 含:todos(+ sub-4/5 的 task/wait)。
2. **system 按需重建**:连续 turn 无 config/wiki 变更 → system prompt 命中缓存(不重算);hot config 变更 → invalidate 后重建。
3. **Current Task 不再出现**:resolveCurrentTask 删除后,`## Current Task` 段消失。
4. **context 持久 + 去重**:recall 事件 addMessage 进历史;同一 recall 不重复追加(去重)。
5. **work-context hook 拆解**:Project/Requirement 在 system;Steps Progress 在 workbench;memoryContext 不再装工作信息。
6. **Wiki Anchors 合并**:根+一层 summary 在 system;信息无丢失(vs 合并前两套锚点)。

## 验证手段

- 单测:buildContextMessage 输出不含 todos/current-task;system 段含 Project/Requirement。
- 单测:连续两 turn,system prompt 缓存命中(组装计数不增)。
- 手测:跑 work session,日志确认各段在正确通道。
