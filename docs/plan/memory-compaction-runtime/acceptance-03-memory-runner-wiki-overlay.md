# Acceptance 03：MemoryRunner 与 Wiki Overlay

对应 [Plan 03](plan-03-memory-runner-wiki-overlay.md)。

- [ ] 一个 CompactionRun 无论有多少 Compression pass，原工作模型逻辑 callId 恰好为 1；
  transient attempts 复用 request digest，不形成第二次 reasoning pass。
- [ ] MemoryRun 输入覆盖统一 `maintenanceCursor + 1 .. B`，不遗漏或读取 `seq > B`。
- [ ] MemoryView 只包含当前 Agent 的 `memory://`；project/global/其他 Agent/admin 不可见。
- [ ] MemoryRun 不注册 live Wiki tool、不执行 tool-result follow-up，不创建第二个逻辑 call。
- [ ] 所有 write/edit/delete 只改变内存 overlay，运行中 WikiDB revision/rows 不变。
- [ ] lazy snapshot 只读取需要节点，touched nodes 保存 base revision/hash。
- [ ] `written` 生成完整 WikiPatch；`no_change` 是显式成功。
- [ ] failure/cancel/timeout 后 overlay 清空，无部分 Wiki 副作用。
- [ ] patch 带 source range/digest 和确定性 operation material。
- [ ] foreground 同时追加 Steps 不改变 MemoryRun 输入。
- [ ] Archive adapter 使用 P4、一个原模型逻辑 call、不接触 maintenance cursor。
- [ ] 测试能证明未调用 live Wiki tool/真实 Wiki write service，而不只是断言最终行数。
