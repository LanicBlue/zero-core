# Step 2A · Spike AI SDK 单步循环(GATE · accept)

> sub2 客观判定。本步判定**不是 green/red**,而是 **GO / NO-GO**(决定 Phase 2 走还是回退)。

## 验收项

### A1. RESULT.md 完整
读 `docs/design/hook-redesign/steps/2A-spike-ai-sdk/RESULT.md`,确认 4 个问题各有明确结论 + 证据:
1. 单步 tool-call 续跑
2. abort 干净
3. 单步重试只重跑该步
4. finish-step + usage 仍 emit

### A2. spike 实际跑过
sub2 自己跑一遍 spike(命令见 RESULT.md 里记录的运行方式),核对输出与 RESULT.md 一致(不是 sub1 空写结论)。

## 判定
- **4 个全通** → **GO**:Phase 2 继续(2B 起)。报 PASS,进 2B。
- **任一不通** → **NO-GO**:
  1. 在 `docs/design/hook-step-redesign.md` §10 #3 记录"不通"结论 + 哪条不通 + 证据。
  2. 在本 steps 目录建 `PHASE2-FALLBACK.md`,说明回退方案(OnLLMError 仅观测;step 外置/重试/resume 列后续;依赖 StepEnd 外置的 P3 操作标"暂跳过")。
  3. **PushNotification 报用户决策点**,等人工指示是否继续 P3/P4/P5(跳过 P2 依赖项)。
  4. **不要硬干 2B-2E**。

## FAIL/NO-GO 反馈格式
```
GO · Step 2A —— 4/4 通,进 2B
  或
NO-GO · Step 2A
- 不通项: <问题N> 
- 证据: <spike 输出关键>
- 已写: hook-step-redesign.md §10 #3 + PHASE2-FALLBACK.md
- 已 PushNotification 用户,等指示
```
