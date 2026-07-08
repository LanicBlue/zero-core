# acceptance-11:vitest 主 cwd 修复

对应 `sub-11.md`。

## 用例

1. **主 cwd 绿**:`npm run test:unit` 在**项目根 cwd** 跑,不再全 FAIL(`Cannot read properties of undefined`),正常出 `Test Files` / `Tests` 结果。
2. **测试数对齐**:主 cwd 跑的 pass 数与 sibling baseline(~875-937,取决于已加测试)一致(允许已知 ~4 个 cwd/jsdom 无关 fail)。
3. **@exodus/bytes 不复发**:换的 pool/配置不触发 `@exodus/bytes` CJS-interop 问题(无相关报错)。
4. **sibling 仍绿**:sibling 目录跑法不回归(双跑都绿)。
5. **不动 src/**:改动只在 vitest.config.ts / package.json / 测试基建,src/ 零改动(grep diff 确认)。
6. **可复现**:修法有注释说明根因 + 取舍(写在 vitest.config.ts 或 commit message)。

## 验证手段

- 主 cwd 跑 `npm run test:unit`(贴末尾 Test Files/Tests)。
- sibling 目录跑同套(确认双绿)。
- 改动 diff 审查:src/ 零动。
