# acceptance-2:阶段1 recorder choke point

## 验收清单
- [ ] tool result >16K bytes:外置文件落盘(`~/.zero-core/tool-outputs/...`);`steps` 表存指针(摘要+文件路径),不存完整字节。
- [ ] tool result ≤16K bytes:原样存 steps。
- [ ] `turn-hooks` persist 路径 + `agent-loop` updateToolResult 都过 recorder → 都指针化(无原始字节窗口)。
- [ ] mid-step 崩溃:steps 表仍是指针(不是原始字节)。
- [ ] 流式多 tool:每个 tool result 独立外置+指针化,不互相覆盖回字节。
- [ ] 完整字节可从外置文件寻回。
- [ ] **不用 PostToolUse modifiedResult**(验证没走那条路)。
- [ ] 三层 tsc + vitest。

## 怎么验
构造 >16K 的 tool result(大文件读取/命令输出),readonly 查 steps 表内容 + 检查外置文件存在。
