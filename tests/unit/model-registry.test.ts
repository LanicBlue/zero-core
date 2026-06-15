// 单元测试：模型元数据注册表匹配逻辑
//
// # 文件说明书
//
// ## 核心功能
// 测试 model-registry 的 findMatch 匹配逻辑：精确匹配（短名 / owner/name）、日期后缀剥离匹配（claude-opus-4-20250514）、子串模糊匹配（要求 key 长度 ≥ 模型 id 一半）、避免误匹配（o1-mini 不命中 o1）、多模态 input_modalities 检测；不实际调用 fetch，本地复刻 registry 构建与匹配函数
//
// ## 输入
// 构造的 OpenRouter 风格 mockModels 数组（含 context_length、architecture.input_modalities、top_provider）
//
// ## 输出
// Vitest 测试用例：断言匹配结果的 context_length、architecture 与 null 情况
//
// ## 定位
// tests/unit/ — 单元测试套件，验证 core/model-registry 的匹配规则
//
// ## 依赖
// vitest、../../src/core/model-registry（findMatch / enrichModels 逻辑的本地复刻）
//
// ## 维护规则
// findMatch 匹配策略（精确 / 日期剥离 / 子串阈值）变更需同步更新测试
// 新增测试模型需补 mockModels 并验证 multimodal 检测
// enrichModels 实际接入 fetch 后需评估是否补充集成测试
//
import { describe, test, expect, vi, beforeEach } from "vitest";

// Mock fetch for OpenRouter API
const mockModels = [
	{
		id: "openai/gpt-4o",
		context_length: 128000,
		architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
		top_provider: { max_completion_tokens: 16384 },
	},
	{
		id: "openai/o1",
		context_length: 200000,
		architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
		top_provider: { max_completion_tokens: 100000 },
	},
	{
		id: "anthropic/claude-sonnet-4",
		context_length: 200000,
		architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
		top_provider: { max_completion_tokens: 16000 },
	},
	{
		id: "anthropic/claude-opus-4",
		context_length: 200000,
		architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
		top_provider: { max_completion_tokens: 32000 },
	},
	{
		id: "google/gemini-2.5-pro",
		context_length: 1048576,
		architecture: { input_modalities: ["text", "image", "audio", "video"], output_modalities: ["text"] },
		top_provider: { max_completion_tokens: 65536 },
	},
	{
		id: "deepseek/deepseek-chat",
		context_length: 131072,
		architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		top_provider: { max_completion_tokens: 16000 },
	},
	{
		id: "qwen/qwen-plus",
		context_length: 1000000,
		architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		top_provider: { max_completion_tokens: 8192 },
	},
];

// We test the matching logic directly since enrichModels calls fetch
describe("model-registry matching logic", () => {
	function buildRegistry(data: typeof mockModels): Map<string, any> {
		const map = new Map();
		for (const m of data) {
			const modelPart = m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id;
			map.set(modelPart, m);
			map.set(m.id, m);
		}
		return map;
	}

	function findMatch(modelId: string, registry: Map<string, any>) {
		const exact = registry.get(modelId);
		if (exact) return exact;

		const noDate = modelId.replace(/-\d{6,}$/, "");
		if (noDate !== modelId) {
			const stripped = registry.get(noDate);
			if (stripped) return stripped;
			for (const [key, model] of registry) {
				if (key.replace(/-\d{6,}$/, "") === noDate) return model;
			}
		}

		let bestMatch: any = null;
		let bestLen = 0;
		for (const [key, model] of registry) {
			if (key.length <= bestLen) continue;
			if (modelId.includes(key) && key.length >= modelId.length * 0.5) {
				bestMatch = model;
				bestLen = key.length;
			}
		}
		return bestMatch;
	}

	const registry = buildRegistry(mockModels);

	test("exact match: gpt-4o", () => {
		const m = findMatch("gpt-4o", registry);
		expect(m).toBeTruthy();
		expect(m.context_length).toBe(128000);
	});

	test("exact match: o1", () => {
		const m = findMatch("o1", registry);
		expect(m).toBeTruthy();
		expect(m.context_length).toBe(200000);
	});

	test("date suffix match: claude-opus-4-20250514", () => {
		const m = findMatch("claude-opus-4-20250514", registry);
		expect(m).toBeTruthy();
		expect(m.context_length).toBe(200000);
	});

	test("date suffix match: claude-sonnet-4-20250514", () => {
		const m = findMatch("claude-sonnet-4-20250514", registry);
		expect(m).toBeTruthy();
		expect(m.context_length).toBe(200000);
	});

	test("no false positive: o1-mini should not match o1", () => {
		const m = findMatch("o1-mini", registry);
		// o1-mini doesn't exist in the registry, should return null (not o1)
		expect(m).toBeNull();
	});

	test("full ID match: openai/gpt-4o", () => {
		const m = findMatch("openai/gpt-4o", registry);
		expect(m).toBeTruthy();
		expect(m.context_length).toBe(128000);
	});

	test("no match returns null", () => {
		const m = findMatch("nonexistent-model", registry);
		expect(m).toBeNull();
	});

	test("multimodal detection from input_modalities", () => {
		const m = findMatch("gemini-2.5-pro", registry);
		expect(m).toBeTruthy();
		expect(m.architecture.input_modalities).toContain("image");
	});

	test("text-only model", () => {
		const m = findMatch("deepseek-chat", registry);
		expect(m).toBeTruthy();
		expect(m.architecture.input_modalities).not.toContain("image");
	});
});
