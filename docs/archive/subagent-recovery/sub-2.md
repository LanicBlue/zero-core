# sub-2:三通道内容重构

> 依赖:**sub-1**(workbench 通道)。对应 design §1.1 分配表、§1.2/§1.3。

## 目标

把现有 `<context>` 块的 6 段 + work-context hook 产出,按变化频率重新分配到 system / context / workbench 三通道。

## 范围 / 改动

- **system(按需)**:
  - `assembleSystemPrompt()` 确保仅按需重建(依赖 invalidate,非每 turn 重算 —— 现 base/wiki-system-anchors 均 cacheBreak:false,核对无回归)。
  - 新增 system 段:Project、Requirement、OS/cwd、Wiki Anchors(根 summary + 一层)。
  - Wiki Anchors 合并:`renderSystemAnchors` + `renderContextAnchors` 合一(根+一层),默认不更新,特殊时机(session 重建/compress)才刷新。
- **context(持久)**:
  - 从"每 turn 重建块"改成"recall 事件 `addMessage` 进历史的持久日志"。
  - 去重:已 recall 过的不重加。
  - recall 源 = wiki memory 子树(per-agent `memory/<agentId>/`)—— **本次留空接口,不接入**(记忆写入未完善)。
- **work-context hook([workflow-context-hook.ts](../../../src/server/workflow-context-hook.ts))拆解**:
  - Project / Requirement / Wiki Baseline → system 段渲染器(on-demand)。
  - Steps Progress → workbench 段渲染器(sub-1 通道)。
  - `memoryContext` 误标修正(它装的不是 memory)。
- **删 `resolveCurrentTask`**([agent-loop.ts:869](../../../src/runtime/agent-loop.ts#L869) + context-message 调用)—— 被 work-context hook 的 Requirement 覆盖。

## 不在本 sub

- workbench 通道基础设施(sub-1)。
- recall 实际接入(后续单独开,记忆写入就绪后)。

## 风险

- context 持久化后历史会涨:靠"只追加新 recall + 去重"缓解。
- Wiki Anchors 合并要保留两套锚点的信息(system-anchors + context-anchors 内容不同,合并勿丢)。
- work-context hook 拆解后,memoryContext 槽空出,确认无其他代码依赖它装工作信息。

## 验收

见 `acceptance-2.md`。
