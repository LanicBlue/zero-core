// tool-decoupling sub-3 测试辅助:
//
// 迁移后的工具 execute(input, callerCtx) 返 ToolResult(JSON),文本形态经
// format(ToolResult) 取。测试断言两边:execute 拿 JSON 验结构,format 拿文本
// 验 agent 视角(同 sub-3 前的 string 返值)。
//
// 这些 helper 让测试少写样板 —— `runTool(tool, input, ctx)` 一次返回
// { json: ToolResult, text: string },断言两边都顺手。

import { getToolExecute, getToolFormat } from "../../../src/tools/tool-factory.js";

/**
 * 调一个迁移后的工具:execute → JSON,format(JSON) → 文本。返回两边让测试
 * 同时断言。callerCtx 即旧 ctx(测试里仍是 ToolExecutionContext 形状,但迁移
// 工具只读身份/workingDir/scope/transitional 字段)。
 *
 * 注:这不走 buildTool wrapper(无 hook / rate-limit / 截断),等同 sub-3 前
 * getToolExecute 直调的语义 —— 只是返值从 string 变 JSON+text。
 */
export async function runTool(
	tool: any,
	input: any,
	ctx: any,
): Promise<{ json: any; text: string }> {
	const exec = getToolExecute(tool)!;
	const fmt = getToolFormat(tool);
	const json = await exec(input, ctx);
	// 旧(legacy)工具无 format → json 就是 string,直接当 text。
	const text = fmt ? fmt(json as any) : (json as unknown as string);
	return { json, text };
}
