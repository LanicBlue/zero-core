// HTTP 服务入口
//
// # 文件说明书
//
// ## 核心功能
// HTTP 服务入口，启动 API 服务器。
//
// ## 输入
// - 环境变量配置
//
// ## 输出
// - HTTP 服务
//
// ## 定位
// 服务入口，通过 zero-core serve 调用。
//
// ## 依赖
// - ./server/index - 服务模块
//
// ## 维护规则
// - 服务配置变更时需更新
// - 保持错误处理正确
//
#!/usr/bin/env node
import { startServer } from "./server/index.js";

startServer().catch((err) => {
	console.error("Failed to start server:", err);
	process.exit(1);
});
