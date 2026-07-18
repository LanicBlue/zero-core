# Plan 03：MemoryRunner 与 Wiki Overlay

## 目标

实现每个 CompactionRun 恰好一个逻辑 call 的原模型 MemoryRun，以及只在内存修改的 Wiki
copy-on-write view。

## 工作

1. 构造 MemoryRunner 输入：完整 Snapshot coverage、bounded continuity、foreground
   agent identity/model，以及 host 预编译的 bounded `memory://` MemoryView。
2. 每个 CompactionRun 只创建一个原工作模型逻辑 Provider call；Compression segment/pass
   数不能增加 Memory call 数。Provider Runtime 的 transient attempts 复用同一
   `callId/requestDigest`，不形成第二次 reasoning pass。
3. MemoryRun 不提供 live Wiki tool、不执行 tool-result follow-up，也不运行多 step AgentLoop。
   MemoryView 在调用前包含允许模型判断所需的 path/summary/selected content/base revision；
   无 project/global/其他 Agent/admin 内容。
4. 单次调用直接返回结构化 `MemoryDecision`：`no_change` 或 patch operations。host 校验并把
   create/update/delete 应用到内存 overlay，不调用真实 Wiki write service。
5. Wiki view 使用 lazy base read + touched node base revision/hash + overlay，不复制完整 Wiki。
6. 输出结构化 `WikiPatch` 或 `no_change`；模型没有要写内容时必须显式完成，不以空解析失败
   冒充成功。
7. patch operation 包含 stable path、expected revision、content/metadata change、source
   range/digest 和 deterministic operation material；此阶段仍不写 WikiDB。
8. Memory prompt 明确长期记忆选择、避免重复、优先更新 MemoryView 中的现有节点，并禁止
   把滚动 summary 当长期事实原样复制。
9. failure/cancel/timeout 丢弃完整 overlay；没有部分 Wiki 副作用。
10. 提供 Archive MemoryRun adapter：复用 runner/overlay、P4、单个原模型逻辑 call，但不读取或
   推进 compaction cursor；真正 archive 接线留到 Plan 06。
11. 使用 fake Provider/Wiki snapshot 验证 scope、一次调用、no_change、patch 和 interruption。

## 完成

[Acceptance 03](acceptance-03-memory-runner-wiki-overlay.md)通过并创建 `result-03.md`。
