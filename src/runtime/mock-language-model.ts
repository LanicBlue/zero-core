import { readFileSync } from "node:fs";
import type { LanguageModelV2, LanguageModelV2StreamPart, LanguageModelV2CallOptions } from "@ai-sdk/provider";

// ---------------------------------------------------------------------------
// Mock language model — replays a fixture-defined event sequence
// Intended for E2E tests. Activated via provider type "mock" in provider-factory.
// ---------------------------------------------------------------------------

export interface MockFixture {
	chunks: Array<
		| { type: "thinking"; text: string }
		| { type: "text"; text: string }
		| { type: "finish"; finishReason?: "stop" | "length" | "tool-calls" | "error" }
	>;
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

function toStreamPart(chunk: MockFixture["chunks"][number]): LanguageModelV2StreamPart[] {
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
		case "finish": {
			return [{
				type: "finish",
				finishReason: chunk.finishReason ?? "stop",
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					totalTokens: 0,
				},
			}];
		}
	}
}

export function createMockLanguageModel(fixturePath: string, modelId = "mock-model"): LanguageModelV2 {
	const fixture = loadFixture(fixturePath);
	const delayMs = fixture.delayMs ?? 5;

	return {
		specificationVersion: "v2",
		provider: "mock",
		modelId,
		supportedUrls: {},

		async doGenerate(_options: LanguageModelV2CallOptions) {
			const textParts = fixture.chunks
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
			const stream = new ReadableStream<LanguageModelV2StreamPart>({
				async start(controller) {
					controller.enqueue({ type: "stream-start", warnings: [] });
					for (const chunk of fixture.chunks) {
						for (const part of toStreamPart(chunk)) {
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
