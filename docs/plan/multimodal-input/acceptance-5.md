# acceptance-5:前端 UX + content 端点

对应 `./sub-5.md`。

## 功能验收
- [ ] 输入区:**+号**导入(图片/PDF/任意文件)、**拖拽**、**粘贴**三入口;待发送附件区有预览 + 删除。
- [ ] 待发送 image 预览用本地 `URL.createObjectURL(File)`(不经网络);发送后清空。
- [ ] `chatSend(text, attachments)`:允许仅附件无文本;只带 meta。
- [ ] `attachments:content` 端点:支持二进制(不像 file-router 拒二进制/500KB);按 id → diskPath 读盘返 image bytes。
- [ ] **路径安全**:content 端点限定 attachments 目录, traversal 拒绝。
- [ ] 历史消息附件缩略图经 content 端点正常显示。

## 单测
- [ ] `tests/unit/attachment-content.test.ts`:content 端点正常读 + 路径安全。
- [ ] (renderer 交互以 E2E sub-7 覆盖)

## 构建/测试
- [ ] 三层 tsc 无错;`npm run build:lib` 无错。
- [ ] `vitest run tests/unit/attachment-content.test.ts` 绿。
