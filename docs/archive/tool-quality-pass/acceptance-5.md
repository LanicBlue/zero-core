# acceptance-5 外部化路径(#9)

> 独立验收清单。对应 [`./sub-5.md`](./sub-5.md)。重点验 **Read 真消费**虚拟前缀(feedback-verify-runtime-wiring:不能只验 externalizer 产出新串,要验 Read 工具真能用它读到文件)。

## 指针产出

1. **新前缀格式**:超阈值 result 经 maybeExternalizeToolResult → 指针串形如 `[externalized: [tool-outputs]/<hash>.txt (N bytes)] <summary>`(前缀是 `[tool-outputs]/`,不再是 `.zero-core/`)。

## Read 解析(核心!)

2. **Read 能读虚拟路径**:产出指针后,Read 工具 path = `[tool-outputs]/<hash>.txt` → 读到外置文件的真实内容(与原始 result 一致)。这是核心断言——证明 Read 真解析了新前缀,不只 externalizer 改了串。
3. **沙箱拒越界**:Read path = `[tool-outputs]/../../etc/passwd`(或 `..` 逃逸)→ 拒绝(返权限/越界错误,不读到 ZERO_CORE_DIR 外文件)。
4. **不存在文件清晰错误**:`[tool-outputs]/deadbeef.txt`(不存在)→ Read 返合理错误(not found),不崩。

## 向后兼容

5. **旧指针仍能解析**:既有 steps 里的 `.zero-core/tool-outputs/<hash>.txt` 旧形态 → resolvePointerRelPath 仍能还原绝对路径(不破历史数据)。
6. **新指针也能还原**:resolvePointerRelPath 解析新 `[tool-outputs]/` 前缀 → 正确绝对路径。

## 不泄露

7. **不显绝对路径**:指针串里不含 `C:/Users/...` 绝对路径(虚拟前缀,home 不泄露)。

## 通用

8. **typecheck 绿**。
9. **既有 externalizer 测试不回归**(指针格式测试若 hardcode 了旧 `.zero-core/` 前缀,需同步更新——这是预期改动,不算回归)。
10. **既有 file-read `[skills]/` 解析不回归**:skill 虚拟路径读取仍正常(新通道是旁路,不动旧通道)。
