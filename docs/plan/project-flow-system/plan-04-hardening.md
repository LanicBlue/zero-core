# Plan 04：Project Flow System 加固

## 目标

完成控制仓库、Flow transaction、关系索引、工具切换和规模查询的恢复与故障验证。

## 依赖

Acceptance 00–03 通过。

## 实施范围

- 恢复 manifest/inner Git/pending transition/outbox/index；
- 重建 definition binding、dependency reverse index、related index 和 composition lineage；
- 故障注入 repo lock、disk/Git failure、duplicate event、并发 relation 和 forged scope；
- 测量多 Project ensure、1,000 FlowInstance 查询、关系图 rebuild 和 inner Git commit；
- 删除本 effort 的 adapter/fallback，保持旧 Requirement 独立且不删除用户数据；
- 验收通过后更新当前架构文档。

## 完成定义

[Acceptance 04](acceptance-04-hardening.md) 通过并生成 `result-04.md`，随后执行
[Final Acceptance](acceptance-final.md)。
