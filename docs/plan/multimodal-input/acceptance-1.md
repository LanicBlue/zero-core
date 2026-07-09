# acceptance-1:content shape + 落盘 + upload 端点

对应 `./sub-1.md`。

## 功能验收
- [ ] `AttachmentMeta`/`UserContent`/`AttachmentKind` 类型定义;kind 按 mimeType 推(image/pdf/file)。
- [ ] `attachments:upload` 端点:base64 → 落盘 `ZERO_CORE_DIR/attachments/<sessionId>/<id>-<name>` → 返含 diskPath 的 `AttachmentMeta`。
- [ ] session 删除 → 对应附件目录清理。
- [ ] **路径安全**:fileName 含 `../` / 绝对路径 / 空字节 → sanitize 为 basename,且解析结果限定在 `<sessionId>/` 目录内(单测覆盖 traversal 攻击用例)。

## 单测
- [ ] `tests/unit/attachment-store.test.ts`:落盘 + 读 + 清理;kind 判定;路径安全(traversal 拒绝/归一化)。
- [ ] upload 端点:正常落盘 + 返 meta;超大 base64 不崩(限大小或接受,记)。

## 构建/测试
- [ ] 三层 tsc(cli/web/node config)无错;`npm run build:lib` 无错。
- [ ] `vitest run tests/unit/attachment-store.test.ts` 绿。
