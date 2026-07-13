# acceptance-3c:双机制 Force/Remind + memory turn 协调

> 对应 [./sub-3c.md](./sub-3c.md)。

## 功能验收

1. **Force 档**:hook 检测 cold / hot+hard 阈值 → AgentLoop 协调跑 memory ephemeral turn(sub-2)→ `compressSession`。
2. **Remind 档**:hot+soft 注入 appendMessage 提示;agent 可自写 memory。
3. **memory turn step 不落盘**:Force 档跑的 memory turn 不写 steps(回归 sub-2 acceptance #1)。

## 不破坏验收

4. prompt_too_long 恢复路径过(单机制)。

## build

5. **typecheck 过**(`build:lib`)。
