# Step 1C · 原子重命名 + Session 级所有权归位(accept)

> sub2 客观判定。本步是 Phase 1 收尾的重头,验证要细。

## 范围核对
```
git diff --name-only HEAD
```
确认没有越界到 step 外置(P2)、turn 表(P4)、操作搬移(P3)。

## 验收项

### A1. 编译 + 测试 green
```
npx tsc -p tsconfig.cli.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
npx tsc -p tsconfig.node.json --noEmit
npm run build:lib
npx vitest run
```
全 0。

### A2. grep 旧事件名(代码引用)
对 src 跑(排除注释):
```
grep -rn '"Stop"\|"StopFailure"\|"PostStep"\|"PrepareStep"\|"SessionEnd"\|"UserPromptSubmit"' src
```
→ 0。`"SessionStart"` 命中应只在:agent-service(fire)、hook-types(定义)、metrics-hooks(register)。`"PostTurnComplete"` 仍存在(本步保留,P3 删)—— 不算红。

### A3. Session 级所有权(读源码核对)
- agent-service:loop 创建两处后 trigger `SessionStart`;销毁四处(abort/agent删/session删/关停)前 trigger `SessionClose`。
- 关停路径 SessionClose 在 `sessionManager.dispose()` 之前。
- agent-loop **不再** fire `SessionStart`/`SessionEnd`(per-run 的已改名 TurnStart,空的 SessionEnd 已删)。

### A4. metrics 语义修对(读源码)
metrics-hooks:`trackSessionStreaming` 挂 SessionStart(现 agent-service fire = loop 建时,语义对);`trackSessionIdle` 挂 SessionClose;`trackSessionError` 挂 TurnError;原 Stop 上的 recordTokenEstimate 挂 TurnEnd。

### A5. 行为不变(手动或既有 e2e)
启动 → 新建会话 → 跑一轮带工具的对话 → turn 持久化正常(turns/steps 写入)、UI 正常、无异常。这是 Phase 1 的硬指标:行为与 Phase 1 前一致。

## 通过判定
A1 + A2 + A3 + A4 + A5 全过 → PASS → commit Phase 1(若 1A/1B/1C 分别 commit 则本步 commit 1C)。

## FAIL 反馈格式
```
FAIL · Step 1C
- 失败项: <A1-A5 + 具体>
- 命令/证据: <...>
- 残留旧名(若有): <文件:行>
- 越界(若有): <做了 P2/P3/P4 的事>
```
