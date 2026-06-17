# Acceptance M4 — PM 产品管线 + discuss + 覆盖判断

> **前置**: `plan-overview.md` A0 通用前置(本文件不重复)。

- [ ] PM service 被 cron 驱动(周期扫描 → 调 analyzer → 发现 → 创建需求文档 → 入 discuss)
- [ ] PM cron 只建新需求、不改已有需求文档;wiki/代码 read-only
- [ ] PM 读 archivist wiki 写需求
- [ ] discuss 入口:看板需求卡「讨论」→ 跳 `{PM, projectId} → session`;PM session 页面 = 持久对话 + 文档/目录面板
- [ ] `RequirementRecord` 字段齐全(projectId / docPath / createdByAgentId / assignedAgentId / reviewerAgentId / status)
- [ ] 需求文档放 `{workspace}/.zero/requirements/{projectId}/`,跨设备可恢复
- [ ] 需求文档是 wiki 树意图叶子节点(archivist 建节点,PM 写内容)
- [ ] 用户直接创建的需求也生成需求文档并归该 project
- [ ] 验收覆盖判断视图:PM 看 manifest 判「改动+测试是否覆盖原需求意图」,不碰技术
- [ ] `reviewerAgentId` 语义 = 覆盖判断方;未引入 productionReady 多门禁聚合
- [ ] 看板按 Project 分组

### 端到端验证
- [ ] **PM 发现 → 建需求文档 → discuss → ready → lead build → PM 覆盖判断** 全链路通
- [ ] 跨 cron 触发、跨日期的 PM 讨论落在同一 `{PM, project}` session
