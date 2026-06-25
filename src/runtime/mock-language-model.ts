// Mock 语言模型，基于 fixture 重放事件序列
//
// # 文件说明书
//
// ## 核心功能
// 提供 AI SDK LanguageModelV2 接口的 mock 实现，通过 JSON fixture 文件定义流式响应序列，用于 E2E 测试
//
// ## 输入
// fixture 文件路径（JSON 格式的 MockFixture）、可选的 modelId
//
// ## 输出
// 符合 LanguageModelV2 接口的 mock 模型实例，支持 doGenerate 和 doStream
//
// ## 定位
// src/runtime/ — 运行时测试基础设施，被 provider-factory 在 type=mock 时调用
//
// ## 依赖
// @ai-sdk/provider（LanguageModelV2 类型）、node:fs
//
// ## 维护规则
// fixture 格式变更需同步更新 MockFixture 接口和 E2E fixture 文件
// 新增 chunk 类型需在 toStreamPart 中添加转换逻辑
//
import { readFileSync } from "node:fs";
import type { LanguageModelV2, LanguageModelV2StreamPart, LanguageModelV2CallOptions } from "@ai-sdk/provider";

// ---------------------------------------------------------------------------
// Mock language model — replays a fixture-defined event sequence
// Intended for E2E tests. Activated via provider type "mock" in provider-factory.
// ---------------------------------------------------------------------------

export type MockChunk =
	| { type: "thinking"; text: string }
	| { type: "text"; text: string }
	| {
			type: "tool-call";
			toolName: string;
			/** Tool input as a plain object; stringified for the AI SDK stream. */
			input: object;
			toolCallId?: string;
	  }
	| { type: "finish"; finishReason?: "stop" | "length" | "tool-calls" | "error" };

export interface MockFixture {
	error?: { message: string };
	/** Back-compat single response, replayed for every model call. */
	chunks?: MockChunk[];
	/** Optional per-model-call responses for multi-step tool-call tests. */
	steps?: MockChunk[][];
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
	};
	delayMs?: number;
}
export function loadFixture(path: string): MockFixture {
	return JSON.parse(readFileSync(path, "utf8"));
}

let idCounter = 0;
const nextId = () => `mock-${++idCounter}`;

function toStreamPart(
	chunk: MockChunk,
	fixtureUsage?: MockFixture["usage"],
): LanguageModelV2StreamPart[] {
	switch (chunk.type) {
		case "thinking": {
			const id = nextId();
			return [
				{ type: "reasoning-start", id },
				{ type: "reasoning-delta", id, delta: chunk.text },
				{ type: "reasoning-end", id },
			];
		}
		case "text": {
			const id = nextId();
			return [
				{ type: "text-start", id },
				{ type: "text-delta", id, delta: chunk.text },
				{ type: "text-end", id },
			];
		}
		case "tool-call": {
			// AI SDK v2 tool-call stream: a 4-part sequence. `tool-call.input`
			// MUST be a stringified JSON object — the SDK parses + schema-
			// validates it, then runs the tool's execute and injects a
			// `tool-result` into fullStream. The tool-input-* parts feed the
			// UI's progressive tool-input rendering.
			const id = chunk.toolCallId ?? nextId();
			const inputStr = JSON.stringify(chunk.input);
			return [
				{ type: "tool-input-start", id, toolName: chunk.toolName },
				{ type: "tool-input-delta", id, delta: inputStr },
				{ type: "tool-input-end", id },
				{ type: "tool-call", toolCallId: id, toolName: chunk.toolName, input: inputStr },
			];
		}
		case "finish": {
			// Honor the fixture's usage block so downstream context-usage UI
			// (ChatPanel contextInfo) renders non-zero token counts in E2E.
			// Previously this hardcoded all-zero usage, which caused the
			// context-usage indicator to render "0 in · 0 out" and let tests
			// that assert on token counts fail.
			const inputTokens = fixtureUsage?.inputTokens ?? 0;
			const outputTokens = fixtureUsage?.outputTokens ?? 0;
			const fixtureTotal = fixtureUsage?.totalTokens;
			return [{
				type: "finish",
				finishReason: chunk.finishReason ?? "stop",
				usage: {
					inputTokens,
					outputTokens,
					totalTokens: fixtureTotal ?? inputTokens + outputTokens,
				},
			}];
		}
	}
}

export function createMockLanguageModel(fixturePath: string, modelId = "mock-model"): LanguageModelV2 {
	const fixture = loadFixture(fixturePath);
	const delayMs = fixture.delayMs ?? 5;
	let streamCallCount = 0;
	const chunksForStreamCall = (): MockChunk[] => {
		if (fixture.steps?.length) {
			const index = Math.min(streamCallCount++, fixture.steps.length - 1);
			return fixture.steps[index] ?? [];
		}
		return fixture.chunks ?? [];
	};
	const allFixtureChunks = (): MockChunk[] => fixture.steps?.flat() ?? fixture.chunks ?? [];

	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId,
		supportedUrls: {},

		async doGenerate(_options: LanguageModelV2CallOptions) {
			if (fixture.error) throw new Error(fixture.error.message);
			const textParts = allFixtureChunks()
				.filter((c) => c.type === "text")
				.map((c) => (c as { text: string }).text)
				.join("");
			return {
				content: textParts ? [{ type: "text", text: textParts }] : [],
				finishReason: "stop",
				usage: {
					inputTokens: fixture.usage?.inputTokens ?? 0,
					outputTokens: fixture.usage?.outputTokens ?? 0,
					totalTokens: fixture.usage?.totalTokens ?? 0,
				},
				warnings: [],
			};
		},

		async doStream(_options: LanguageModelV2CallOptions) {
			if (fixture.error) throw new Error(fixture.error.message);
			const stream = new ReadableStream<LanguageModelV2StreamPart>({
				async start(controller) {
					controller.enqueue({ type: "stream-start", warnings: [] });
					for (const chunk of chunksForStreamCall()) {
						for (const part of toStreamPart(chunk, fixture.usage)) {
							controller.enqueue(part);
							if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
						}
					}
					controller.close();
				},
			});
			return { stream };
		},
	};
}
