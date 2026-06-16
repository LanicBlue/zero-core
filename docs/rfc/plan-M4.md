# Plan M4 — PM 产品管线 + discuss + 覆盖判断

> **依赖**: M1(PM cron 驱动)+ M3(verify manifest)+ M2(读 wiki)。
> **对应 RFC**: §2.5 / §2.10 / §2.17b / §4.5。
> **验收**: `acceptance-M4.md`(前置见 `plan-overview.md` A0)。

## 设计细节要求

1. PM service 重构(M0 已有预设,这里给行为):被**自身 cron(M1)驱动** —— 周期扫描 workspace → 调 analyzer 专项分析 → 发现问题 → 创建需求文档(新)→ 入 discuss(决策 7)。
2. **PM cron 只发现/创建新需求,不改已有需求文档;对 wiki 和代码 read-only**(决策 7)。
3. PM 读 archivist 的 wiki 获取项目上下文写需求(决策 7)。
4. **discuss 文档为中心**:
   - 入口:看板需求卡「讨论」→ 跳 `{PM, projectId} → session`(M0 路由)。
   - PM session 页面 = 跟 PM 的持久对话 + 文档/目录面板(复用现有 chat 页面渲染),展示该 project 所有需求文档。跨 cron 触发、跨日期都在这一处(决策 13/14)。
   - 需求 = `RequirementRecord`(DB,喂看板:`projectId` / `docPath` / `createdByAgentId` / `assignedAgentId` / `reviewerAgentId` / status / 属性 + 摘要)+ 需求文档(markdown 文件,完整内容 + 讨论沉淀)。`docPath` 指向 repo 内文档(决策 12)。
   - 需求文档放 `{workspace}/.zero/requirements/{projectId}/`,跟 repo 走、跨设备可恢复(决策 12)。
   - 需求文档是 wiki 树的一个**意图叶子节点**(M2 archivist 建节点 + 关系,PM 写内容)(决策 14)。
   - **无 session 隔离**:状态在文档里,PM 用文件工具现读(决策 13)。
5. **PM session 入口 = `{角色=PM, projectId} → session`**,不是「一个 PM agent」(PM agent 全局唯一,决策 14)。
6. **验收覆盖判断视图**:PM 看 M3 Orchestrate 产出的 manifest(改动文件 + 测试清单 + 审查结果),只判**改动+测试是否覆盖原需求意图**(产品颗粒度,不碰技术)。`reviewerAgentId` 语义 = 覆盖判断方(默认 createdByAgentId 的 PM)(决策 34)。**不引入 productionReady 多门禁聚合**(决策 34)。
7. 看板按 Project 分组;plan 门待确认提醒入口。
8. 用户直接创建的需求也生成需求文档,归该 project(由该 project 的 PM session 认领建档)。

## 风险

- PM session 页面复用现有 chat 页面渲染 —— 确认文档/目录面板的可复用性,别另起 UI。
