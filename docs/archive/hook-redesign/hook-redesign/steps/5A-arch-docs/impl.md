# Step 5A · arch 文档同步(impl)

> sub1 只读本文档。前置:Phase 1-4 全完成。纯文档,不碰代码。

## 背景
代码已全改完,文档要对齐新架构。

## 目标
更新以下文档,与最终代码一致(新 hook 骨架 / 所有权 / step 中心 / step 唯一存储 / 恢复):
1. `docs/arch/03-runtime-engine.md`:§3.3 hook 三层生命周期表 + §Hook 系统(事件→触发点→handler 表 + 时序图)全部按新 14 hook + 所有权(agent-service session 级)+ step 中心 + 外置循环重写。
2. `docs/arch/05-persistence.md`:step 唯一存储 + turn_group 属性 + 迁移 + step 级恢复(lastCompletedStepSeq)。
3. `docs/arch/08-cross-cutting.md`:旧 hook 名引用替换。
4. `docs/arch/09-extension-points-and-adrs.md`:ADR-024 技术债标"已解决";新增 **ADR-025**(per-loop registry + step 中心 + 去 turn 表 + step 外置重试/resume + 所有权归位 + §5.5 session-hook 原则 + requirement-hooks 退役)。

## 要改的文件
- `docs/arch/03-runtime-engine.md`、`05-persistence.md`、`08-cross-cutting.md`、`09-extension-points-and-adrs.md`

## 边界
- ❌ 不改代码(纯文档)。
- ❌ 不动 `docs/rfc/*`(spec 历史保留)。
- ❌ 不手改 code-graph.html(5B 重生成)。
- 注释/文档可中文(与既有 arch 文档一致;代码注释才强制英文)。

## 自检
- grep 旧事件名 `PostTurnComplete|PrepareStep|PostStep|"Stop"|"StopFailure"` 在 docs/arch → 仅 ADR 历史记录可保留,其他 → 0。
- ADR-025 含:14 hook 清单、per-loop registry、step 外置 + 重试/resume、去 turn 表 + 迁移、§5.5 原则、requirement 退役。
