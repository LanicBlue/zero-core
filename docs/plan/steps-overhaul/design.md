# Design:steps-overhaul

> 状态:**Draft,架构 + 压缩策略主干已定,wiki/归档细节待议**。
> 对应 issue:[`./issue.md`](./issue.md)(同目录,随文件夹流转)。
> **scope 扩大**:本 effort 含**压缩策略重整**(压缩与表结构强耦合,不可分)。

## 问题回顾(详见 ./issue.md)

session 的 step 存储 + 压缩 + 体积感知三件事各自不顺手,讨论中演进成**持久化层重整 + 压缩策略重做**:① 表名 `turns` 名不副实;② chat UI 缺 session 内容量确认;③ 压缩是反应式、破坏性、缺分层。

## 关键事实(审计 —— 对现状的纠正)

### 纠正 1:压缩钩子在 **StepEnd**,不是 PreLLMCall
`compression-hooks.ts:76` 注册在 **StepEnd**(非 PreLLMCall,issue 写错)。真实延迟:压缩阻塞**下一个 step 的首字**(StepEnd 在 step 结束后、下一步 LLM call 前)。仍反应式(>0.7 才压)、仍同步、仍**破坏性**(覆盖 turns+messages,原始消失)。

### 纠正 2:multimodal-input 已合并,`attachments` 列已存在
`turns` 表已有 `attachments TEXT`(`session-db.ts:158/306`)。不需协调加列。

### 当前存储模型(共享表 + 破坏性压缩)
SessionDB 自有表(`session-db.ts:120-307`),内容相关 4 张(现状物理名):

| 表 | 现状 | 压缩时 |
|----|------|--------|
| `sessions` | 1:1 主记录 + 路由 bundle(context_*)+ archived/kind | 聚合状态分散在 turn_state |
| `messages` | msg_json 缓存(= session.messages 落盘) | `saveTurn` 整表 DELETE+重插,压缩时覆盖 |
| `turns` | step 行(UI 真相源,名不副实) | `replaceStepsFromMessages` DELETE+重插,**原始销毁** |
| `turn_state` | per-(session,turn) 1:N 恢复状态 | 每 turn 一行 |

**核心问题**:无独立"原始"层,压缩覆盖 turns+messages,原始内容消失。全系统无任何一处保留压缩前原始 step。

### 共享表结构已就位
`messages`/`turns`/`turn_state` 都带 `session_id` 外键。**走共享表方案无需改 FK,只改语义**(见下)。LCM(lossless-claw)证明共享表 + conversation_id + 索引能承载多会话。

## 已定架构:共享表 + 双语义 + sessions 收状态

### 决策:共享表,不做 per-session 物理分表
共享表 + session_id FK(现状已有)。per-session 分表的好处(删/归档干净)由**归档出库机制**保证,不值得换"加列遍历 N 表 / statement 不能复用 / 动态表名安全"的代价。

### 两张表,语义拆清(2026-07-10 定 + 可行性验证修订)
命名:物理 `turns`→**`steps`**(原始);物理 `messages` **保留名**,但语义从"LLM 视图内容落盘"改为 **"summary 块 + 压缩游标"(不存 step 内容,引用 steps)**。

| 表 | 角色 | 写 / 压缩 |
|----|------|-----------|
| `steps`(原 `turns` 改名) | **原始:阶段1处理后的 step 级全量历史**(巨大 payload 外置,存指针),**未压缩、不可变** | 阶段1 经 recorder choke point 写入,StepEnd 后冻结;**压缩永不碰** |
| `messages`(保留名) | **summary 块 + 压缩游标**(`last_compressed_step_seq`);**不存 step 内容** | 阶段3 写 summary + 推进游标;阶段1/2 不写它 |

**LLM 视图(内存 `session.messages`)= 组装三区**:`[summary](messages 表)+ [steps(压缩游标..fresh-tail 边界):tool 结果 stub]+ [steps(fresh-tail 边界..当前):逐字+指针]`(steps 表)。assemble,非直接读表。中间区 stub = 阶段2(见下)。

**关键不变量(修订后)**:
- **两表不重复存内容**:steps 存全量 step(指针版);messages 只存 summary + 游标(引用 steps 范围)。
- **`steps` 不是"原始字节"**,是"阶段1处理过的 step 级未压缩历史";巨大字节在**外置文件**。
- **压缩 = 更新 messages 的 summary + 推进游标**(旧 step 自然落到游标之前,LLM view 组装时不再取它们,只在 summary 里);steps 不动。
- **消除 mid-turn 漂移**:messages 只是游标,steps 永远是 source → 不存在"steps 写了 messages 没写"的落后(上一轮冲突检查的风险点由此消解)。
- **"step" 概念不动**(比 ModelMessage 粗:一个 assistant step 折叠 assistant 消息 + tool_use + tool_result),避免撞名 `session.messages`。

### sessions 收状态(吸收 turn_state)
`sessions` 加 7 列(权威清单,2026-07-10 定):

| 列 | 类型 | 角色 |
|----|------|------|
| `phase` | TEXT NOT NULL DEFAULT `'completed'` | 当前 turn 阶段(pending/running/completed/failed/interrupted);recovery 扫 `phase NOT IN ('completed','failed')`。老行默认 `'completed'`(不触发恢复) |
| `last_completed_step_seq` | INTEGER | step 级 resume 游标(最后一个跑完 StepEnd 的 step seq;resume 从 +1 续) |
| `source` | TEXT NOT NULL DEFAULT `'background'` | turn 来源(chat/cron/delegated/background);**驱动归档触发**(sub-8:delegated 自动归档,cron/main 不) |
| `error` | TEXT | 最近错误(failed 阶段展示/排错) |
| `turn_count` | INTEGER NOT NULL DEFAULT 0 | turn 计数(体积 UI + `getTurnCount()` 经它分配 turn_seq) |
| `step_count` | INTEGER NOT NULL DEFAULT 0 | step 计数(体积 UI) |
| `token_usage` | TEXT(JSON) | 最近一次 API 返回的 usage(`{prompt_tokens,...}`);**以 API 返回为准、不本地重算**,触发判定 + UI 都读 |

**turn_state 列的归宿**(逐列):
- **保留进 sessions**:`phase`/`last_completed_step_seq`/`source`/`error`(→ 上表)。
- **`turn_seq` 不进 DB**:运行时真相是 in-memory `turn-seq-tracker.ts`(TurnStart 经 `db.getTurnCount()` 分配,防 turn+1 bug);DB 的 `turn_seq` 值由 `turn_count` 派生,折叠后无需单独列。
- **`checkpoint TEXT(JSON)` 丢弃**:legacy turn 级 checkpoint,被 `last_completed_step_seq` 取代;sub-1 核对无消费方(`advanceStepCheckpoint` 写、`:976` 读)后删。
- **per-turn `created_at`/`updated_at`**:sessions 自有时间戳,冗余丢弃。
- **`cleanOldTurnState` 整体退役**:其 GC 职责(清 stale turn_state 行)被 recovery 扫描吸收——启动时 `phase NOT IN ('completed','failed')` 的 session 即恢复候选,恢复不了的标 `'interrupted'`/`'failed'`,无 per-turn 行可 GC。

**`turn_state` 表退役**,职责折进 sessions,只保留**当前运行状态**(舍弃 per-turn 历史)。

### 归档(吸收 session-archive-memory issue,2026-07-10,已定)
归档 = **在压缩记忆之上加"导出文件 + 删库"**。

**归档管线**(任一触发后都走这套):
1. **最后一次 Extractor A 压缩**:把残留 step 的记忆抽进 wiki(阶段3 通路;归档也压缩)。
2. **导出 JSON**:该 session 自有数据 = `sessions` 行 + `steps` + `messages`(全量)→ 落盘 JSON。
3. **删库**:删该 session 的 `sessions` 行 + `steps` + `messages`(`WHERE session_id`)。
4. **wiki 记忆保留**:Extractor A 写的 wiki 节点**不删**(跨 session,留给后续)—— "学到东西留给后续"的落点。

**触发范围(2026-07-10 定)**:
- **delegated(子 agent)**:任务完成(`delegated_tasks → completed/failed`)→ **自动归档**(子 agent 跑完即沉,归档 + 提记忆)。
- **cron / main(父 agent)**:**不自动归档**(cron 一般是父 agent,持久,用户保留)。
- **chat(前台)**:**手动**,走现有 chat UI 的归档按钮(已有,无新增)。

**JSON 细节(已定)**:位置 `~/.zero-core/archives/<agentId>/<sessionId>.json`(按 agent 分目录,与 `~/.zero-core/wiki/` 同根);文件名 `<sessionId>.json`(唯一);**plain JSON**(v1,可读;真大了再加 gzip)。

**不做归档恢复**(2026-07-10 定):archive JSON 只作留档,不提供 restore 通路(无 UI/IPC/命令读回)。归档 = 单向"导出 + 删"。

**孤儿清理**(归档管线必做):删 session 自有内容时,**一并删引用该 session 的 `tool_executions`/`delegated_tasks` 行**(`WHERE session_id`),否则成孤儿;若归档的是**活跃 session**(chat 手动),先 teardown 运行时 session handle/registry,再删库。

**关键**:wiki 记忆跨 session,归档只导出 + 删 session **自有内容**(sessions/steps/messages 行 + tool_executions/delegated_tasks 孤儿),记忆节点留存。DB 只装 active session,表数量可控。

### 数据迁移:不保留,直接重建
现有 `sessions/messages/turns/turn_state` **DROP 重建**,不搬数据。**只动 session 内容/状态表;`agents/projects/wiki/tool 配置/provider_usage` 等不碰。** `tool_executions`/`delegated_tasks` 引用 session,session 清空后成孤儿,一并清(细节后定)。

### 中断重启恢复(确认可恢复)
```
启动 → 扫 sessions 找 phase != terminal(单 SELECT,不再扫 turn_state)
      → 组装 session.messages = messages 表的 summary + steps[压缩游标 .. sessions.last_completed_step_seq]
      → resume 从 last_completed_step_seq+1 继续
```
**两个游标区别**:`sessions.last_completed_step_seq`(resume 游标,agent-loop 续跑用)vs `messages.last_compressed_step_seq`(压缩游标,LLM view 组装时 summary/fresh-tail 分界)。两者独立。

**不变量(修订后)**:`steps` 表 per-step 持久化 + sessions resume 游标 + messages(summary+压缩游标)必须在 **StepEnd 同步落盘**(durable)。mid-step 中断时 resume 游标指向上一个完成 step,dangling tool block 由现有 Step 2E 合成 `[interrupted]`,从游标+1 重跑(同现状语义)。**无 mid-turn 漂移**:messages 只是 summary+游标,steps 是 source,组装永远一致(上一轮冲突检查的风险点由此消解)。

---

## 压缩策略(本 effort 核心)

### 三轴模型
context 管理不是单一"压缩",是三轴:
- **减法流水线**(阶段 1→2→3):tool 外置 → 廉价 tool-stub → LLM 摘要
- **横切不变量**:tool 配对完整 / 防抖 / 稳定性
- **正交轴**:寻回(压了能找回)/ fresh-tail 保护 / cache 冷热调度 / wiki 记忆抽取

### cache 经济学(前置原理)
prompt cache 是**带 TTL 的前缀哈希**。改前缀任何 token → 从该点向后全 miss。压缩本质是改前缀,故:
- **阶段 1(写入时外置/截)**:cache-safe(完整版从没进缓存)。
- **阶段 2/3(事后改前缀)**:**必然破 cache**(通用情况;Anthropic 的 `cache_edits` 是 provider 专属,不算)。→ 阶段2/3 应**合并到同一次 pass**,cache 只破一次,且**只在 cache 冷时跑**。

### 阶段 1:写入时外置(cache-safe,recorder choke point)
- **接缝(2026-07-10 可行性验证修订)**:**不用 PostToolUse hook 的 `modifiedResult`** —— 那是返回值,只 agent-loop 可见;持久化 handler(`turn-hooks`)读的是 `ctx.result`(原始)且先跑,会先写原始字节 → 窗口/崩溃破不变量。改在 **`TurnRecorder.updateToolResult` 这个唯一 choke point** 做:所有 tool result 落库(turn-hooks + agent-loop 两次调用)都过它。
- **就地动作**(在 recorder.updateToolResult 里):① 判断 result 体积 → ② >**16K bytes** 则外置文件 → ③ recorder 存**指针版**(不存原始字节)。第一次进 recorder 就是指针 → **steps 永远是指针,无原始窗口**。
- **finalize**:每个 tool_result 返回即外置+指针化;step 在 StepEnd 最终写库后冻结于 `steps`。
- **不变量**:
  - 完整字节**只在 recorder.updateToolResult 那一刻落盘**外置文件;steps 永远存指针;**不依赖 hook 顺序 / modifiedResult 传播**。
  - 压缩只读已 finalize 的旧 step(游标之前、fresh tail 之外),不碰正在流式组装的当前 step。
- **cache-safe**:完整版从没进过 cache(steps 存指针,messages 不存 step 内容)。

### 阶段 2:组装三区规则(无 LLM,常驻,不持久化)
LLM view 组装时天然分三区(2026-07-10 修订:messages 改引用模型后,阶段2 从"触发的写"变成"组装规则"):
```
[summary]                                       ← 压缩游标之前的 step(已摘要,在 messages 表)
[steps(压缩游标 .. fresh-tail 边界):tool 结果 stub] ← 中间区,阶段2 在这生效
[steps(fresh-tail 边界 .. 当前):逐字 + 指针]      ← fresh tail
```
- **阶段2 = 中间区的 tool 结果 stub**:组装时,压缩游标之后、fresh-tail 边界之前的 step,tool 结果(tool_use + result 指针)换成一行 stub。**常驻组装规则,不是触发的写**,无 LLM、不持久化、cheap。
- **与阶段1/3 区别**:阶段1 写入时单条外置(持久);阶段2 组装时中间区 stub(无常驻);阶段3 推进压缩游标(持久,LLM)。
- **"减慢积累"由常驻提供**:不用专门触发;高度压力时阶段2 的 stub 不够 → 触发阶段3(游标推进)。

### 阶段 3:Extractor A agent(多步,读写 wiki,messages 保留 ≤3 summary)
- **执行者**:**Extractor A** —— 多步 agent(独立 loop,**不在工作 session 里**),用 **settings/memory 配置的独立模型**,带 wiki 读写工具。call 不存储(不留痕于工作 session)。
- **触发**:冷 **且** (token>100K **或** >50% 窗口);StepEnd(可 mid-turn)或 new turn。
- **输入**:① 被压缩 agent 的现有 memory 子树(读)② fresh tail 之外、未压过的新 step(先经阶段2 trim)。
- **Extractor A 判断与产出**:
  - 新 step 内容 → 映射到**已有 wiki 节点**(补充)还是**新主题**(新建)。新 step 可能跨多主题 → **一次压缩可产多个 summary**。
  - 写回 wiki **不是 dumb append**:**去重 + 去伪(纠正过时/错误)+ 冲突无法判定则留标注**。
  - 多步以实现 wiki 读(看已有)→ 判定 → 写(合并)。
  - 结果**核对输出格式**(不符重试/兜底)。
- **产物**:① `messages` 表写 summary(≤3 FIFO)+ **推进 `last_compressed_step_seq` 游标**(被压的 step 落到游标前,LLM view 组装时不再取它们、只在 summary 里;`steps` 不动);② summary 作为**更新输入**喂 wiki 节点(Extractor A 合并写入)。
- **`messages` summary cap**:**保留最新 3 个 summary**(FIFO,新进旧出;每个 summary = 一次压缩产物)。更老 summary age-out 但已在 wiki 持久。
- **wiki recall 进 messages**:**本轮不做**(new turn 也只压缩 + cap 3,不 recall wiki doc)。

### 阶段3 summary / wiki 节点格式(2026-07-10 定)

summary 既是 `messages` 里的连续性载体,又是 wiki 节点的更新输入。节点用**结构化格式**(5 段,或按 topic 适配):

| 段 | 内容 | 静/动 |
|----|------|-------|
| **目的** | 做什么(任务目标) | 静态 |
| **计划** | 怎么做(方法/步骤) | 静态 |
| **状态** | 做到哪了 + 结果 + **下一步立即做什么** | 动态 |
| **关键产物/文件** | 哪些文件/产物 + 当前状态 | 动态 |
| **经验** | 遇到的问题 / 教训 / 关键决策 | 动态 |

- **结构化节点 + 承接过去记忆**:节点用上述结构;**承接过去靠 Extractor A 读已有节点 → 合并(去重/去伪/冲突标注)→ 写回,非覆盖** → 节点既结构化、又累积式承接历史。
- **compress once**:每段原始 step 被 summarize **一次**;summary 绝不 re-summarize(避免降质)。多次压缩产多个独立 summary(各覆盖不重叠 step 段),`messages` cap 3 FIFO。
- **无 user 消息也保方向**:目的/计划 承载任务目标(长 turn 里原始 user 在 100K 前,不进 fresh tail)。
- **状态段必含"下一步立即动作"**:mid-turn 压缩后恢复连贯性的桥。
- **寻回指针**:summary 带指向 `steps` 表原始 step 范围的锚点,agent 要细节从 `steps` 按需读回。

### wiki memory(Extractor A 维护,按主题划分)
- **wiki 节点按主题划分**,由 Extractor A 维护(去重/去伪/冲突标注的合并,非 dumb append)。
- **触发**:只在阶段3 压缩(+ 归档,归档也压缩)时跑 —— **取代 Extractor A 旧的阈值独立抽取**(修订决策 53:`extraction-hooks` `[0.2/0.45/0.7]` + `closeFlushSession` 退役,合并进压缩)。
- **summary ≠ wiki 节点**:summary 是**节点更新输入**;Extractor A 读 memory 子树 + 新 step → 判定新建/补充节点 → 合并写入。
- **模型**:settings/memory 配置的独立模型。
- **检索**:wiki anchor 选择性注入(本轮不做 recall 进 `messages`)。
- **现状为何没写入**:Extractor A 默认 `enabled:false`(`config.ts:236`)+ 旧压缩 L2 只在 >0.7 → 默认几乎不写。新设计绑更频繁的 mid-turn 冷压缩 + 不依赖 `extractors.A.enabled` → wiki 默认就会写。

### cache 冷热判定(provider 无关)
- **时间为主信号**:`now - lastLLMCall > cacheTTL(T1)` → 冷。最 portable(provider cache 统计不一定透传)。
- **必然冷**:session 首 call、刚跑过阶段2/3。
- **辅助信号**(可选):provider usage 的 cacheRead 骤降 → 印证冷。

### 触发路径(cache 冷热分级响应)
**冷路径(免费压缩,StepEnd 触发,可 mid-turn)**:
- **StepEnd + 冷 + 超阈值**:每步结束后评估;冷 + 超 100K/50% → 阶段3(LLM 摘要);冷 + 低于 100K/50% → 阶段2(廉价 tool-stub)。**可在 turn 内部触发**(长 turn 增量压缩当前 turn 更早的 step)。
- **Q2.1 WAIT 窗口(接点已定位,2026-07-10)**:WAIT = pending "Wait" tool call(deadline 在 `until`/`startedAt`)。长 WAIT(>cacheTTL)→ 冷。不单独做 WAIT 触发,折叠成 **`AgentLoop.resume()`(`agent-loop.ts:631`,与 `detectAndResumePendingWait` `:672` 同址)的 resume-time 冷 preflight**:resume → 冷 + 超阈值 → 压缩 `messages` → 组装 → 首个 LLM call 前完成。WAIT/崩溃恢复同走此 preflight。

**热路径(尊重 cache,不强制破)**:
- **Q3.1 mid-turn + 热**:**不打断**(defer 到 turn 边界)。
- **Q3.2 新 turn + 热 + 超 soft 阈值**:**注入压缩提醒**(PreLLMCall memoryContext 式,或暴露 compact 工具),**LLM 自判**是否压。
- **Q3.3 hard 阈值(T6)无视 cache**:**强制压缩**(PreLLMCall preflight:先压再发)。

**reactive 兜底**:`OnLLMError` 收到 `prompt_too_long` → 强制压缩 + retry。

**新 turn 边界合流**:冷+超阈值 → 走完整压缩(Q2);热+超 soft → 注入提醒(Q3.2);无论冷热+超 hard → 强制(Q3.3)。

### fresh tail 保护(硬约束)
- **必须有**。压缩只作用于 fresh tail 边界**之前**。
- **粒度 = step**(非 turn_group;zero-core 长 turn 常态 100K+,turn 不能当单元)。fresh tail = 最近若干 step,token 预算 = **min(32K token, 20% 窗口)**,**tool-pair 安全**(不切断 tool_use/result 对),含任何在途 tool 调用。
- **task 连续性**靠 `messages` 里最新的 **≤3 个 summary**(阶段3 产物,目的/计划 段保方向),**不靠**保护原始 user 消息(长 turn 里它在 100K 前,塞进 tail = 保护整 turn)。原始 user 在 `steps` 表可寻回。

### 横切不变量(每阶段都守)
- **tool_use ↔ tool_result 配对完整**(砍 result 留 use 会 API 报错)。
- **防抖**:连续两次压缩省 <10% 就停(hermes)。
- **稳定性**:同输入压缩结果稳,否则每轮 cache prefix 抖(LCM orphanStrippingOrdinal)。

### 阈值(2026-07-10 用户重写,stage-keyed)

表达:每档 = 绝对 token **或** 窗口%(谁先到触发);阶段1 用绝对 bytes。

| 路径 | 触发条件 | 动作 |
|------|---------|------|
| **阶段1**(写入,recorder choke point) | tool 结果 > **16K bytes** | 外置文件 + `steps` 存指针;cache-safe(`messages` 不存 step 内容) |
| **阶段2**(组装规则,常驻) | always(组装时) | 中间区(压缩游标..fresh-tail 边界)tool 结果 stub;无 LLM、不持久化 |
| **阶段3.1**(cold) | 冷 **且** (token>100K **或** >50% 窗口) | LLM 摘要,只动 `messages` 表(内部先 trim) |
| **阶段3.2 提醒**(hot) | 热 **且** (token>200K **或** >70% 窗口),**新 turn** | 注入提醒,LLM 自判 |
| **阶段3.2 强制**(hot) | 热 **且** (token>400K **或** >90% 窗口),**新 turn** | 强制压缩 |

- **阶段2 语义(修订)**:常驻组装规则(中间区 tool 结果 stub),**非触发写**;"中度压力"不再是独立动作,而是"阶段2 stub 够用、不触发阶段3";高度压力(超 100K/50%)才触发阶段3 游标推进。
- **窗口行为**:200K 窗口 → 阶段3.1@100K/提醒@140K/强制@180K;1M 窗口 → 阶段3.1@100K/提醒@200K/强制@400K(绝对值兜住,不撑到 900K);50K 窗口 → 走百分比。
- **fresh tail 保护**:**step 粒度**(非 turn_group —— zero-core 长 turn 常态 100K+,turn 不能当单元)= 最近若干 step,token 预算 = **min(32K token, 20% 窗口)**(单条 tool 结果已被阶段1 限到 ~4K token,但数量多),**tool-pair 安全**(不切断 tool_use/result 对),含任何在途 tool 调用。一个 100K 长 turn:最近 ~20K step 保护,**同 turn 更早的 step 可压缩**。
- **mid-turn 压缩(长 turn 必然)**:cache 冷路径在 **StepEnd 触发**(每步、可在 turn 内部),压当前 turn 更早的 step(fresh tail 之外);cache 热路径仍**新 turn 触发**(mid-turn 不打断)。
- **task 连续性**靠 `messages` 里 **≤3 个 summary**(阶段3 产物,compress once,目的/计划 段保方向),**不**靠保护原始 user 消息 —— 长 turn 里原始 user 在 100K 前,塞进 tail = 保护整 turn。去掉"最后 user 消息在 tail"规则;原始 user 在 `steps` 表可寻回。
- **无 T5 地板**:fresh tail 对短会话天然兜底(中间区空 + 阶段3 不触发 → 实质 no-op),不需额外地板。
- **reactive 兜底**:`OnLLMError` 收 `prompt_too_long` → 强制压缩 + retry。

**T1 cacheTTL(已定)**:**per-provider**,默认 **6 min**,落在 `Provider.cacheTtlMs?`(`shared/types.ts:102` 的 `Provider` 接口新增可选字段,默认 360000;懂自己 provider 的用户改:Anthropic 5min、Google 1hr 等)。
**`lastLLMCall` 存储(2026-07-10 定)**:**内存 only,不持久化**——重启进程必死 cache、必冷(=必然冷"首 call"),持久化无意义。运行时(SessionDB/agent-loop)维护 in-memory 时间戳。冷热判定 = `now - lastLLMCall(in-memory) > cacheTTL`。

### 可行性已验证(2026-07-10,对照现有代码)
4 个 subagent 分区查了冲突,**无不可调和冲突,设计可建**。两条接缝已按查证结果修订(见上):
- ✅ **阶段1 接缝**:`modifiedResult` 到不了持久化 handler → 改 **recorder `updateToolResult` choke point**(已写进阶段1)。
- ✅ **mid-turn 一致性**:messages 改 **summary+游标引用模型**(不存 step 内容)→ 消除漂移 + 内容重复(已写进两张表/恢复)。

其余两区干净可建,次要点(不阻塞):
- **turn_state 折叠**:所有消费点都只依赖"一个 session 至多 1 in-flight turn"(1:1 等价),无硬冲突。已定(2026-07-10):`cleanOldTurnState` **退役**(职责被 recovery 扫描吸收,非语义替代);老 sessions 行 `phase` 默认 `'completed'`;`turn_seq`/`checkpoint` 不进 DB;折叠后 7 列进 sessions(SqliteStore 管辖)→ 同步 `db-migration.ts` `*_COLUMNS`。
- **wiki topic+merge**:WikiNode 已有 `flags`(冲突标注)+ `detail`(合并正文);根机制是"按 X 分根"泛化(agent→topic 平移)。缺口(可补):Wiki 工具 `create` 不支持 memory type(扩工具或 Extractor A 直调 store)、Extractor A 无 callerCtx(注入 global-anchor)、无 version/history 列(用 `detail` "## 历史"段绕过)、`deriveTypeFromPosition` path 前缀耦合(改 topic path 同步改)。

---

## 待决策(进 plan 前需定)

**已定(2026-07-10)**:
1. ✅ **表命名**:物理 `turns`→**`steps`**(原始,行=step);物理 `messages` **保留名**,语义 = **summary 块 + 压缩游标**(**不存 step 内容**,引用 steps)。LLM view 组装三区:summary + 中间区(tool stub)+ fresh tail。
2. ✅ **T1 cacheTTL**:per-provider(`Provider.cacheTtlMs?`,默认 360000),provider 配置可调;`lastLLMCall` 内存 only 不持久化。其余阈值见阈值表。
3. ✅ **sessions 列(权威清单见上)**:`phase`/`last_completed_step_seq`/`source`/`error`/`turn_count`/`step_count`/`token_usage(JSON)`;`turn_seq`/`checkpoint`/per-turn 时间戳不进 DB,`cleanOldTurnState` 退役(被 recovery 扫描吸收)。
4. ✅ **阶段1 finalize(接缝修订)**:**recorder `updateToolResult` choke point**(非 PostToolUse modifiedResult —— 那到不了持久化 handler);>16K bytes 外置文件 + steps 存指针;StepEnd 后冻结;不依赖 hook 顺序。
5. ✅ **内容量 UI**:展示**最近 max(100 step, 5 turn)的内容**(取多的),数据源 `steps` 表。
6. ✅ **阶段2 语义(修订)**:**常驻组装规则**(中间区 tool 结果 stub),非触发写;messages 引用模型下的三区组装(summary/中间区 stub/fresh tail)。
7. ✅ **wiki 抽取(Extractor A 多步 agent)**:阶段3 = Extractor A 独立多步 agent(settings/memory 模型,wiki 读写工具),读 memory 子树 + 新 step → 判定新建/补充 topic 节点 → 去重/去伪/冲突标注合并写入;一次压缩可产多个 summary;`messages` cap 3 summary FIFO;wiki recall 进 messages 本轮不做。取代旧阈值独立抽取(决策 53 修订)。summary = wiki 节点更新输入(非节点本身)。
8. ✅ **归档(吸收 session-archive-memory,已定)**:管线 = 末次 Extractor A 压缩 → 导出 JSON → 删库(含 tool_executions/delegated_tasks 孤儿)+ 活跃 session runtime teardown → wiki 记忆留存。触发:delegated 子 agent 完成自动归档;cron/main 父 agent 不自动;chat 走现有 UI 按钮。JSON = `~/.zero-core/archives/<agentId>/<sessionId>.json`,plain JSON。**不做归档恢复**(单向)。
9. ✅ **范围切分**:10 sub(见 sub-*.md)。

## 下一步

**design fully 定稿 + 已对照代码验证可建,plan 已拆 10 sub(见 `sub-1.md`~`sub-10.md` + `acceptance-1.md`~`acceptance-10.md`,1:1 配对)。** 验证策略见 [`./verify-strategy.md`](./verify-strategy.md):**每 sub 实施后跑 3 个并行 verify agent**(Lens A 不变量守恒 / Lens B 运行时接线·下游真消费 / Lens C 构建·回归·数据),三全 pass 才 commit。依赖链:sub-1(表地基)→ sub-2(阶段1 choke point)→ sub-3(messages 引用模型+三区组装)→ sub-4(阶段3 核心+拆旧引擎)→ sub-5(触发+fresh tail)→ sub-6(wiki topic,可与 sub-4/5 并行)→ sub-7(Extractor A 多步)→ sub-8(归档)→ sub-9(UI)→ sub-10(e2e+回归)。`/effort next` 从 sub-1 起。
