// 顺序思维链工具
//
// # 文件说明书
//
// ## 核心功能
// 提供逐步推理的思维链工具，支持动态反思和复杂问题分解
//
// ## 输入
// 思维内容、当前步骤编号、总步骤数、状态标记
//
// ## 输出
// 思维链记录，包含每步推理内容和状态
//
// ## 定位
// src/runtime/mcp-tools/ — 内置 MCP 工具，增强 agent 推理能力
//
// ## 依赖
// zod、tools/tool-factory.ts
//
// ## 维护规则
// 思维链格式变更需确保向后兼容
//
import { z } from "zod";
import { buildTool } from "../tools/tool-factory.js";

const thoughtHistories = new Map<string, { thought: string; thoughtNumber: number; totalThoughts: number; status: string }[]>();

export const sequentialThinkingTool = buildTool({
	name: "SequentialThinking",
	description: "Step-by-step reasoning through sequential thought chains.",
	prompt:
		"A detailed tool for dynamic and reflective problem-solving through sequential thinking. " +
		"Use this tool to think through complex problems step by step, showing your reasoning process. " +
		"Each call appends a thought to the chain. Use thoughtNumber and totalThoughts to track progress. " +
		"Set nextThoughtNeeded to false when the reasoning is complete.",
	meta: { category: "thinking", isReadOnly: true },
	inputSchema: z.object({
		thought: z.string().describe("Your current thinking step"),
		nextThoughtNeeded: z.boolean().describe("Whether another thought step is needed"),
		thoughtNumber: z.number().int().min(1).describe("Current thought number (1-indexed)"),
		totalThoughts: z.number().int().min(1).describe("Estimated total thoughts needed"),
		key: z.string().optional().describe("Optional key to group thoughts by problem/topic"),
	}),
	execute: async ({ thought, nextThoughtNeeded, thoughtNumber, totalThoughts, key }) => {
		const groupKey = key ?? "default";
		let history = thoughtHistories.get(groupKey);
		if (!history) {
			history = [];
			thoughtHistories.set(groupKey, history);
		}

		const entry = {
			thought,
			thoughtNumber,
			totalThoughts,
			status: nextThoughtNeeded ? "in_progress" : "complete" as const,
		};
		history.push(entry);

		const lines: string[] = [
			`Thought ${thoughtNumber}/${totalThoughts}:`,
			thought,
			"",
		];

		if (nextThoughtNeeded) {
			lines.push(`Next: Continue reasoning (step ${thoughtNumber + 1})`);
		} else {
			lines.push("Reasoning complete.");
			thoughtHistories.delete(groupKey);
		}

		return lines.join("\n");
	},
});
