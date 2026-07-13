# sub-1:Wiki 注入默认根调整(前置,独立)

> 所属 effort:compression-archive-simplify(详见 [./design.md](./design.md))。
> 依赖:无(独立前置)。

## 范围

改 wiki 注入的**默认根** + 加**冻结快照**;**保留 free wikiAnchors**。详见 design「零、Wiki 注入默认根调整」。

## 改动

- **默认根进 system + 冻结**:
  - `resolveAnchors`:memory-root 的 `inject` 从 `context` 改 **`system`**;zero(无 project)的 global-root 从 `scope-only`(inject:off)改**注入 system**(doc+一层 summary,受 cap)。
  - SystemPromptAssembler 的 wiki-anchors section 加**冻结快照**语义:session 开始时定格,只在**压缩后**刷新;mid-session wiki 写**不触发**该 section 重渲染 → prefix cache 稳定。
- **保留**:`renderContextAnchors`、`AgentRecord.wikiAnchors`、agent-registry 的 wikiAnchors action、settings UI 锚点配置。free 锚点 inject:system 也享冻结快照;inject:context 仍走 `renderContextAnchors` 每轮重算(用户显式选择,接受其 cache 行为)。
- `renderAnchorOutline` 渲染格式不变(doc + 一层 summary)。

## 不做(scope 边界)

- 不删 free wikiAnchors / renderContextAnchors / agent-registry 字段。
- 不改压缩/归档(sub-3/4)/ ExtractorA(sub-5)。
- 不动 "Recalled Memories" 占位 channel(与本调整无关,留 sub-5 或不动)。

## 验证

见 [./acceptance-1.md](./acceptance-1.md)。
