# Plan 04：Multi-pass CompressionPipeline

## 目标

实现专用模型的顺序多 pass rolling summary，修复 transcript/coverage 缺陷，并在不保留完整
Turn 的前提下把 Snapshot 压到目标预算。

## 工作

1. 以 Plan 01 CompactionAtom 为唯一 segmentation 输入；删除重复 fresh-tail/boundary 逻辑。
2. 根据 Compression 模型 context/output reserve，把完整 Snapshot coverage 切成一个或多个
   有序 segment；一个 atom 不能跨 pass。
3. pass 1 输入 existing summary + segment 1；后续 pass 输入上一个内存 rolling summary +
   当前 segment；所有中间状态只在内存。
4. 每个 pass 必须实际注入完整 transcript，修复 `{transcript}` 未替换问题。
5. 禁止固定字符上限截断后仍推进 segment/cursor；不能放入的 atom 必须缩小 boundary 或
   fail closed。
6. structured output 验证 sections/schema、coverage、source digest、pass index/count、
   prompt/model/policy version 和 token usage。
7. summary cap 使用 `min(10%W,12K)`；候选总上下文尽量落入 `min(30%W,60K)`。
8. preferred reduction 小于压缩前上下文的 `20%` 返回 `insufficient_reduction`，不伪装
   成功；不得使用会让小窗口无法达到的固定 10K 下限。
9. 任一 pass 失败/取消/schema/coverage 不合法，pipeline 整体失败并丢弃 rolling summary。
10. 专用模型比 foreground 小时以多 pass 继续；单个 atom 本身超限返回稳定
    `atom_too_large/config_required`，不静默截断。
11. 本阶段只返回内存 SummaryCandidate，不写 core.db/cursor。

## 完成

[Acceptance 04](acceptance-04-multipass-compression.md)通过并创建 `result-04.md`。
