# Step 5A · arch 文档同步(accept)

> sub2 客观判定。纯文档验收。

## 验收项

### A1. 编译不变(文档不影响代码)
```
npx tsc -p tsconfig.cli.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.node.json --noEmit
```
仍 green(防误改代码)。

### A2. 旧名清理
grep `PostTurnComplete|PrepareStep|PostStep|"Stop"|"StopFailure"|"SessionEnd"|"UserPromptSubmit"` 在 docs/arch → 仅 09 的 ADR 历史记录可保留,其他命中 → 0。

### A3. ADR-025 完整(读源码核对)
`docs/arch/09-extension-points-and-adrs.md` 含 ADR-025,覆盖:
- 14 hook 清单(Session/Turn/Step/LLMCall/Tool 五层)+ 所有权(session 级在 agent-service)
- per-loop registry(去单例)
- step 循环外置 + step 级重试/resume + 恢复分界(finish-step)
- 去 turn 表 + 迁移 + turn=属性
- §5.5 原则(session hook 只载 session 生命周期)+ requirement-hooks 退役
- ADR-024 技术债标"已解决"

### A4. 03/05 一致
- 03-runtime-engine.md 的 hook 生命周期表/时序图与新代码一致(14 hook、外置循环、所有权)。
- 05-persistence.md 反映 step 唯一存储 + turn_group + 迁移 + lastCompletedStepSeq。

## 通过判定
A1 + A2 + A3 + A4 全过 → PASS。

## FAIL 反馈格式
```
FAIL · Step 5A
- 失败项: <A1-A4 + 具体>
- 证据: <旧名残留位置 / ADR-025 缺项 / 文档与代码不一致点>
```
