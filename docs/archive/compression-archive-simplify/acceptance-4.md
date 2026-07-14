# acceptance-4:归档(Q5b + re-activate + 原子 export + DB 锁)

> 对应 [./sub-4.md](./sub-4.md)。

## 功能验收

1. **归档流程**:memory ephemeral turn → mark(archived=1)→ 原子 export(JSON 文件)→ 删行。
2. **原子性**:export 失败(tmp 写失败 / JSON 校验不过 / rename 失败)→ **不删行**;DB 行仍在,可重试。
3. **可恢复**:mark→export 间模拟中断(进程杀)→ 重启扫 `archived=1 且仍有行` 的 session → 重跑 export 成功。
4. **子 agent re-activate(GAP2)**:从没压缩过的短 session,`fireOnTaskTerminal` 后 re-activate 跑一轮 memory turn → export;压缩过的长 session 直接 export(不 re-activate)。
5. **memory turn step 不落盘**:归档的 memory ephemeral turn 不写 steps(回归 sub-2)。
6. **archive-service 不再调 ExtractorA**:grep archive-service `ExtractorA`/`mergeSummaryIntoWiki` 零命中。
7. **无 final compression**:归档不跑 `compressSession`(grep 归档路径零命中)。
8. **DB 锁**:并发归档同一 session(手动 + 自动同时)→ 锁防竞态,不产生重复 JSON / 双删。

## 不破坏验收

9. 现有归档测试(手动归档 / 子 agent termination 自动归档)过。

## build

10. **typecheck 过**。

## optional(deferred 须标注)

11. restore 通路(IPC 读 JSON 重建)/ archives 轮转 —— 若 deferred,在 sub-4.md 明确标注并开 follow-up。
