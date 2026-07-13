# sub-2:ephemeral turn 基建(前驱)

> 所属 effort:compression-archive-simplify(详见 [./design.md](./design.md))。
> 依赖:无(基建,sub-3/4 的前驱)。

## 范围

加 **ephemeral turn** 机制:跑一个 LLM turn(允许 wiki 工具)但**该 turn 的 step 不落盘**,只留 wiki 副作用。详见 design「一、Ephemeral turn 机制」。

## 改动

- AgentLoop 加"跑一个 ephemeral memory turn"入口:注入提示(由调用方给)→ 跑 LLM(streamText,stepCountIs(1))→ 允许 wiki 工具(docWrite/docEdit 等)→ **不持久化该 step**。
- **`persist:false` flag** 穿过持久化 hook:`turn-hooks` 的 TurnStart `appendStep` / StepEnd `seal` 检查该 flag,跳过写 `steps` 表。LLM 调用、工具执行、emit 照常。
- 验证 wiki 写在 ephemeral turn 里生效(wikiStoreGlobal 共享,in-process 即时;若 delegated 跨进程,确认同步)。
- 中断语义:ephemeral turn 中断 → 无 step 落盘 → 无脏状态;wiki 写是独立操作(部分=少几条,可接受)。

## 不做(scope 边界)

- **不实现具体触发**:压缩触发(sub-3)、归档触发(sub-4)。本 sub 只提供"能跑一个不落盘 turn"的基建。
- 不改正常 `run()`/`resume()` 的持久化(它们仍落盘)。
- 不接 memory 提示文案(由 sub-3/4 调用方注入)。

## 验证

见 [./acceptance-2.md](./acceptance-2.md)。
