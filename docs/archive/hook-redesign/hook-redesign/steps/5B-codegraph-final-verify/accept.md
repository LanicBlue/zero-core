# Step 5B · code-graph 重生成 + 总验证(accept)

> sub2 客观判定。**整个重做的总出口**。

## 验收项

### A1. 全量 green
```
npx tsc -p tsconfig.cli.json --noEmit && npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.node.json --noEmit
npm run build:lib
npm run build   # electron-vite build
npx vitest run
```
全 0 退出。

### A2. 旧事件名 / legacy API 全清
```
grep -rn '"Stop"\|"StopFailure"\|"PostTurnComplete"\|"PrepareStep"\|"PostStep"\|"SessionEnd"\|"UserPromptSubmit"' src
grep -rn 'appendTurn\|getTurns\|updateTurnContent\|hasStepSchema' src
```
→ 0。`"SessionStart"` 仅 agent-service fire + types + metrics;`"SessionClose"` 仅 agent-service + types + metrics。

### A3. code-graph 已重生
`docs/visualization/code-graph-data.json` 含本次新增/改名的模块(hook-redesign 相关、新 step 循环函数等);`code-graph.html` 可开。build:codegraph 跑过无报错。

### A4. 手动端到端(spec §11 #5)
启动 app(或既有 e2e):
1. 主会话多 step turn(模型调工具→拿结果→再调)→ step 级落库、压缩(超阈值时)、注入都正常。
2. delegate 一个 1-turn subagent session → 委派任务正常,父 step 含 Agent tool-call。
3. step 重试:mock 某 step 失败 → 只重跑该 step。
4. 崩溃 resume:kill 中途 → 重启 → step 级 resume 续跑。
5. 旧 DB 升级 → 历史会话可重建。

### A5. 完工通知
PushNotification 报完工总结:各 unit commit hash、Phase 2 spike 结论(GO/NO-GO + 走法)、跳过的步骤(若有)、总验证结果。

## 通过判定
A1 + A2 + A3 + A4 全过 → PASS → commit Phase 5(code-graph)→ 整个重做完工。

## FAIL 反馈格式
```
FAIL · Step 5B
- 失败项: <A1-A4 + 具体>
- 证据: <命令输出 / grep 残留 / e2e 失败点>
- 建议: 回到哪个 phase 的 sub1 修
```
