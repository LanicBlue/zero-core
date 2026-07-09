# acceptance-2:session 存储 + turns.attachments 列

对应 `./sub-2.md`。

## 功能验收
- [ ] step `content` 保持纯字符串;新增 `attachments: AttachmentMeta[]` 字段。
- [ ] `appendStep/upsertStep/replaceStepsFromMessages` 签名带 `attachments?`;turns 表 INSERT/UPDATE 写入 attachments 列。
- [ ] turns 表新增 `attachments TEXT` 列;`initSchema` 有 `safeAddColumn(db,"turns","attachments","TEXT")`。
- [ ] **fresh DB**(无该列)启动后列存在 → 不崩(验证 safeAddColumn 生效,非 COLUMNS 数组路径)。
- [ ] **重启恢复**:`rebuildFromTurns`/`getSteps` 读回 attachments → 内存 step 附件不丢。

## 单测
- [ ] `tests/unit/session-store.test.ts`:appendStep 带 attachments → turns 表落盘 → getSteps 读回一致。
- [ ] rebuildFromTurns 加载 attachments。

## 构建/测试
- [ ] 三层 tsc 无错;`npm run build:lib` 无错。
- [ ] `vitest run` 相关单测绿。
