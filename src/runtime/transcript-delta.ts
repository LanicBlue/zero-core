// Transcript delta 切片器 (v0.8 M5)
//
// # 文件说明书
//
// ## 核心功能
// 从 session 的 step 表(原始 turn 持久化,机制 1)读出自上次提取 cursor 之后
// 的 delta,渲染成 markdown 文本喂给 extractor A/B。是机制 2「只处理 cursor 之后
// 的 delta,不重新过整段 transcript」(决策 53)的物理实现。
//
// 不依赖任何 LLM、不写 DB —— 纯切片器。compression-archive-simplify sub-5:
// 主 caller hooks/extraction-hooks.ts 已随 ExtractorA 退役一并删除;现在仅被
// 切片相关测试覆盖(sub-5 不删本文件 —— 不在设计.md「四、死代码清理」清单内;
// 未来挂回 B 触发器时可复用)。
//
// ## 输入
// - CoreDatabase(via db.getSteps)
// - sessionId
// - fromSeq(inclusive)/ toSeq(exclusive)
//
// ## 输出
// - { transcript: string, realToSeq: number } — realToSeq 是切片实际终止的 seq
//   (用于回写 cursor),与请求的 toSeq 可能不同(空切片、越界等)
//
// ## 定位
// runtime 层纯函数模块。
//
// ## 依赖
// - server/session-store-interface(ISessionStore.getSteps 类型)
//
// ## 维护规则
// - 渲染格式改动后,验证 extractor A/B 的 prompt 仍然能解析(它们读
//   "User: ... / Assistant: ..." 行)
// - 单个 delta 切片不要超过 ~12k 字符(extractor 截断 12k);超长由调用方分批
//

import type { ISessionStore, StepRow } from "./session-store-interface.js";

export interface TranscriptSlice {
	transcript: string;
	/** Actual seq the slice ended at (exclusive). May be < requested toSeq. */
	realToSeq: number;
	/** Number of steps included. */
	stepCount: number;
}

/**
 * Render steps in [fromSeq, toSeq) as markdown transcript text.
 *
 * Each step becomes a line: `User: <content>` or `Assistant: <content>` (or a
 * compact form for tool blocks). Returns { transcript: "", realToSeq, stepCount: 0 }
 * if no steps in range.
 *
 * `maxChars` caps the rendered text (extractors truncate anyway, but capping
 * here avoids loading giant steps into memory).
 */
export function sliceTranscriptDelta(
	db: ISessionStore,
	sessionId: string,
	fromSeq: number,
	toSeq: number,
	maxChars: number = 12000,
): TranscriptSlice {
	const allSteps = db.getSteps(sessionId);
	const inRange = allSteps.filter(s => s.seq >= fromSeq && s.seq < toSeq);
	if (inRange.length === 0) {
		return { transcript: "", realToSeq: fromSeq, stepCount: 0 };
	}
	const lines: string[] = [];
	let used = 0;
	let realToSeq = fromSeq;
	for (const step of inRange) {
		const text = renderStep(step);
		if (!text) {
			realToSeq = step.seq + 1;
			continue;
		}
		if (used + text.length + 2 > maxChars) break;
		lines.push(text);
		used += text.length + 2;
		realToSeq = step.seq + 1;
	}
	return {
		transcript: lines.join("\n\n"),
		realToSeq,
		stepCount: lines.length,
	};
}

function renderStep(step: StepRow): string {
	const role = step.role === "user" ? "User" : "Assistant";
	if (step.role === "user") {
		const text = (step.content ?? "").trim();
		return text ? `${role}: ${text.slice(0, 1500)}` : "";
	}
	// Assistant step: content is a JSON array of blocks.
	let blocks: any[] = [];
	try { blocks = JSON.parse(step.content ?? "[]"); } catch { blocks = []; }
	const parts: string[] = [];
	for (const b of blocks) {
		if (b.type === "text" && b.text) {
			parts.push(`text: ${String(b.text).slice(0, 1500)}`);
		} else if (b.type === "tool") {
			const status = b.status ?? "done";
			const argsStr = typeof b.args === "string" ? b.args : JSON.stringify(b.args ?? {});
			const resultStr = typeof b.result === "string" ? b.result : JSON.stringify(b.result ?? "");
			parts.push(`tool[${b.name}, ${status}]: args=${argsStr.slice(0, 600)} | result=${resultStr.slice(0, 400)}`);
		}
	}
	if (parts.length === 0) return "";
	return `${role}: ${parts.join(" | ")}`;
}
