# Plan P4 — cron 重写 + 调度台

> **依赖**:P0(crons 三模式 schedule + 新列 + cron_runs 表)。可与 P5/P6 并行。
> **对应规范**:§9。**验收**:`acceptance-P4.md`。
> **文件**:`src/server/cron-analysis.ts`(CronAnalysisManager)、`src/server/cron-store.ts`、`src/renderer/components/settings/CronSettings.tsx`(→ 提到顶级页)、`src/renderer/store/cron-store.ts`。

**为什么独立**:cron 调度是自包含子系统,只依赖 P0 的 schedule 字段,不依赖 wiki/agent 运行时。可并行推进。

## 设计细节要求

### 调度器重写(§9.2)

1. `CronAnalysisManager`(`cron-analysis.ts`)按 mode 调度(替 `parseSchedule`+setInterval):
   - once → `setTimeout` 到 fireAt;触发后 enabled=false + 摘定时器。
   - alarm → 计算下一次满足 (time, days) 时刻 → setTimeout;触发后重算下一次(滚动)。
   - interval → setInterval(everyMs,min 60000)。
2. 启动恢复 `restoreSchedules`:遍历 enabled cron 按 mode 重建;**missed once 不补**(fireAt 已过 → enabled=false + 记 cron_runs missed);alarm/interval 只算下一次未来时刻。
3. 单次触发错误不取消调度(catch + log + 落 cron_runs failed)。
4. 每次触发落 `cron_runs`;回写 `last_run_at`/`last_status`/`next_run_at`。

### Cron 工具(§9.4)

5. `Cron` action 工具 create/update/delete/get/list/trigger(P3 已接 store,本阶段接调度器:refreshCron 重算 next_run)。list 支持 projectId/agentId/enabled 过滤。

### 调度台 UI(§9.5)

6. CronSettings 提到**顶级页**(调度台),移出 settings:
   - 顶部 24h 时间轴(今天 cron 按时刻标刻度,颜色按 agent,当前时刻游标)。
   - 主体闹钟卡片网格(下次时间/重复标签/启用 toggle/状态点/倒计时/立即运行/展开 history)。
   - 分组切换(by agent / by project)。
   - 新建闹钟式表单(选 mode → agent+scope → 时间/重复 → prompt)。

### 死代码(§8.6)

7. 删 project 域 dead 调度通道:`projects:pause/resume/updateInterval` IPC + project-handlers + REST(调的是 cron-analysis legacy no-op aliases)。

## 风险

- **setTimeout 长延迟不稳**:once 可能 setTimeout 几天,进程重启定时器丢 → 靠 restoreSchedules 重建;missed once 不补是明确策略。
- **alarm 跨日/跨周计算**:算下一次 (time, days) 要处理跨周;TZ 处理(alarm 存 IANA tz)。
- **时区**:once fireAt ISO 带偏移;alarm tz;UI 本地显示。TZ 算错会导致触发时间偏移。
- **UI 24h 时间轴**:今天多个 cron 时刻密集时刻度重叠;可视化要处理。

## 不在本阶段

- cron 表结构(三模式列)→ P0 已做。
- Cron action 工具 schema → P3 已做(本阶段接调度器)。
- cron-analysis legacy aliases 删除 → P9。
