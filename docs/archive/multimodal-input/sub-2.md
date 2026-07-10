# sub-2:session 存储升级 + `turns.attachments` 列(含 rebuildFromTurns)

- **effort**:multimodal-input
- **依赖**:sub-1(shape)
- **关联**:组件 3(session step)/ 组件 5(turns);原则 A(只存 meta)

## 范围

session step 加 `attachments` 字段(`content` **保持纯字符串**);`session-store-interface` 的 `appendStep/upsertStep/replaceStepsFromMessages` 签名同步加 `attachments?`;turns 表新增 `attachments TEXT` 列(存 `AttachmentMeta[]` JSON);迁移走 `initSchema` 的 `safeAddColumn`(turns 无 `*_COLUMNS` 数组);**`rebuildFromTurns`/`getSteps` 读 attachments 列填进内存 step**(重启恢复不丢附件)。

## 交付物

- `src/runtime/session-store-interface.ts`:`Step`/appendStep/upsertStep/replaceStepsFromMessages 加 `attachments?: AttachmentMeta[]`。
- `src/runtime/session.ts`:step content 仍 string,加 attachments 字段;`rebuildFromTurns` 加载 attachments。
- `src/server/session-db.ts`:turns 表加 `attachments TEXT`;INSERT/UPDATE/SELECT 带 attachments;`initSchema` 加 `safeAddColumn(db,"turns","attachments","TEXT")`。
- 单测。

## 不做

getMessages 构造(sub-3)、run 签名(sub-4)、显示通路(sub-4)。

## 验收

见 `./acceptance-2.md`。
