# sub-10:e2e + 回归

## 范围
端到端验证 + 全量回归,确保整套(steps/messages/sessions/压缩/wiki/归档/UI)协同正确。

## 依赖
sub-1 ~ sub-9 全部。

## 改动点
- e2e(Playwright Electron,`ZERO_CORE_TEST_FIXTURE`):
  - 长 turn mid-turn 压缩:模拟 100K+ turn,验证 cache 冷时 StepEnd 触发压缩、summary 进 messages、游标推进、fresh tail 不被压、LLM view 三区组装正确。
  - 恢复:mid-turn 崩溃 → 重启组装 LLM view(summary + steps[游标..])→ resume 续跑,无 mid-turn 漂移。
  - 归档:delegated 子 agent 完成 → 自动归档(JSON 落盘、DB 删 session 数据、wiki 记忆留存);chat UI 归档按钮。
  - wiki:压缩后 topic 节点合并(去重/去伪/冲突标注)。
  - 内容量 UI:展示最近 max(100 step,5 turn)。
- 回归:三层 tsc(cli/web/node)+ build:lib(electron-vite build 不做 TS 检查,必须额外跑)+ vitest 全量。
- **Extractor A 在 e2e 的处理**:e2e 走 `ZERO_CORE_TEST_FIXTURE` mock provider,不保证吐合法 5 段 summary。两条:(a) e2e 注入 **stub Extractor A**(直接写预置 summary 块),只验"触发→summary 进 messages→游标推进→三区组装→fresh tail 不被压"的**管线接线**;(b) summary **内容质量**(5 段结构/去重/去伪/冲突标注)放 **vitest** 用真 LLM 或受控 fixture 验。e2e 不依赖 LLM 产出的具体文本。
- readonly 查 sessions.db 验证(⚠️ memory:backend 占用时绝不 checkpoint)。

## 关键不变量
- 验证运行时接线(不只验生产者隔离):下游真消费(messages 组装、恢复重建、UI 显示)。

## 参考
design.md「可行性已验证」;memory `feedback-verify-runtime-wiring`/`feedback-build-verification`/`feedback-sessions-db-readonly`。
