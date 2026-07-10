// 临时调试脚本：dump Architect session 的最近 turns。
//
// # 文件说明书
//
// ## 核心功能
// 直连 ~/.zero-core/sessions.db，按硬编码的 Architect sessionId 取最近 20 条
// turn，打印 seq / role / content 预览，并尝试解析 assistant 内容中的 tool 块
// （name / toolCallId / status），用于排查工具调用 ID 写入问题。
//
// ## 输入
// - 无 CLI 参数；sessionId 在脚本顶部硬编码
// - 直读磁盘上的 ~/.zero-core/sessions.db
//
// ## 输出
// - 控制台文本：最近 turns 摘要 + tool 调用块信息
//
// ## 定位
// scripts/ 下的一次性调试脚本，不属于正式测试套件；随时可删除或修改。
//
// ## 依赖
// - better-sqlite3（CommonJS require）
// - os / path
//
// ## 维护规则
// - 仅用于本地排障，不要接入 CI
// - 改 sessionId 后即可复用到其他会话
// - 如果 sessions.db 路径变更需同步修改
const Database = require("better-sqlite3");
const os = require("os");
const path = require("path");

const db = new Database(path.join(os.homedir(), ".zero-core/sessions.db"));
const architectSessionId = "7cdbc653-358c-4314-9a28-30f138bdab42";

const turns = db.prepare("SELECT seq, role, substr(content, 1, 300) as content_preview FROM steps WHERE session_id = ? ORDER BY seq DESC LIMIT 20").all(architectSessionId);
console.log("=== Architect turns (last 20) ===");
turns.forEach(t => console.log(`seq=${t.seq} role=${t.role} content=${t.content_preview}`));

// Check for tool call IDs
console.log("\n=== Looking for toolCallId patterns ===");
const allTurns = db.prepare("SELECT seq, role, content FROM steps WHERE session_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 5").all(architectSessionId);
for (const t of allTurns) {
	try {
		const blocks = JSON.parse(t.content);
		for (const b of blocks) {
			if (b.type === "tool") {
				console.log(`seq=${t.seq} tool=${b.name} toolCallId=${b.toolCallId} status=${b.status}`);
			}
		}
	} catch {}
}

db.close();
