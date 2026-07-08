# sub-3:app 级工具批迁(Wiki / Cron / OS 类)

> 决策 1/2/3 批量落地。app 级数据工具 + OS 类工具一次性迁新模型。依赖 sub-2(模式已验证)。

## 任务

一次性迁以下工具到新签名(execute(input, callerCtx) → JSON + format):

1. **Wiki 工具**(`src/tools/wiki/`):expand/search/create/update/delete/docRead/docWrite/docEdit —— 直读 wikiStore 单例;**scope 从 callerCtx 取**(限定 project 子树,G5)。
2. **Cron / 管理 list 类**:经 management 单例 + callerCtx。
3. **OS 类工具**(Read / Grep / Bash / Edit / Write / Glob):workingDir + emit 从 callerCtx 取;Bash 流式经 `callerCtx.emit`。返 `{text}` + 元数据(G6:`format = r.text`)。
4. **info/logs/config/providers**(若 sub-2 未含):同 Platform 模式。

## 范围

- **类别内一次性**(G3):这批工具一起迁,不留双签名。
- buildTool wrapper 继续支持新签名工具(sub-2 已铺)。
- callerCtx 注入 workingDir / emit / scope。

## 风险

- 数量多(10+ 工具)→ 工作量大,但模式统一(sub-2 验证过)。
- Wiki scope 改动:现 wiki-anchor 解析靠 session context;改 callerCtx.scope 后要保证 project 子树隔离不回归。
- Bash 流式 emit 从 ctx.emit 挪到 callerCtx.emit。

## 验收

见 `acceptance-3.md`。
