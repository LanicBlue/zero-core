# acceptance-3:app 级工具批迁

对应 `sub-3.md`。

## 用例

1. **Wiki 工具新签名**:expand/search/docRead 等返 JSON + format;直读 wikiStore 单例(不经 ctx)。
2. **Wiki scope**:Wiki 从 callerCtx.scope 限定 project 子树;无 scope(内部 chat)按 session context 解析(不回归)。
3. **OS 工具 workingDir**:Read/Grep/Bash/Edit/Write 从 callerCtx.workingDir 取(不经 ctx)。
4. **Bash 流式 emit**:Bash 经 callerCtx.emit 吐 stdout 增量;终态返 JSON(`{text, exitCode}` 之类)。
5. **OS 工具 format**:Read/Bash 返 `{text}` 壳,format 返 r.text(G6)。
6. **Cron/管理 list**:新签名 + JSON+format。
7. **ctx 服务字段对这些工具清零**:Wiki/OS/Cron 工具不再读 ctx.wikiStore/ctx.workingDir/ctx.emit(grep 确认)。
8. **不回归**:Wiki expand/docRead、Read、Grep、Bash、Edit 行为同今天(返值形态变 JSON,但功能等价)。

## 验证手段

- 单测:每类代表工具(Wiki expand / Read / Bash)新签名 + JSON+format。
- 单测:Wiki scope 限定 + Bash emit 流式。
- grep:这批工具不读旧 ctx 服务字段。
- typecheck 三层 + vitest(主 cwd)全套。
