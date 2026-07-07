# acceptance-7:work-context hook 拆解到三通道

对应 `sub-7.md`(补完 sub-2)。

## 用例

1. **Project / Requirement / Wiki Baseline 在 system**:work session 的 system prompt 含这些段(不再在 context 块的 "Recalled Memories")。非 work session 不含。
2. **Steps Progress 在 workbench**:work session 的 `<workbench>` 块含 Steps Progress(每 step 新鲜);不在 system/context。
3. **Wiki Anchors 合并**:renderSystemAnchors + renderContextAnchors 合一进 system(根 + 一层 summary);context 块不再单独有 Wiki Anchors 段。
4. **context 通道只剩 Recalled Memories**:context 块不再装 Project/Requirement/Wiki Baseline/Steps Progress;`memoryContext` 不再被工作信息占用(只留作 recall 专用,本次空)。
5. **DI 不跨层**:runtime(agent-loop/workbench/prompt-sections)不 import server stores;经 SessionConfig 闭包/接口注入。grep 确认。
6. **system 按需**:work-context system 段在 activeRequirement 刘换/hot config 时刷新(invalidate),不每 step 重算。
7. **回归**:非 work session 的 system/context/workbench 不受影响(无 workContextSystemSection 时段为空)。
8. **旧路径删除**:workflow-context-hook 的 memoryContext 注入路径移除(或 hook 删除,改由 config 闭包渲染)。

## 验证手段

- 单测:mock work session,断言 system prompt 含 Project/Requirement;workbench 含 Steps Progress;context 块不含这些。
- 单测:非 work session,work-context 段为空。
- 单测:runtime 文件 grep 无 server import。
- typecheck 三层 + vitest(sibling cwd,baseline ~875-937,~4 无关 fail)。
