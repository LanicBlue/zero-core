// compression-archive-simplify D2/O7 adversarial wiring test.
//
// # File 说明书
//
// ## 核心功能
// 独立验证 `buildCompressOpts` 的 precedence chain(compression-archive-simplify
// 的 D2/O7 gap — sub-5 verifier flagged)。该 fix 把 LLM 模型选择从
// `extractors.A.*` 改成显式三级 fallback:
//
//   compression.provider/model  (UI 写的 — MemorySettings → memoryConfigUpdate)
//     ?? extractors.A.provider/model  (legacy back-compat — 任何残留 config)
//       ?? config.providerName/modelId  (session 工作模型)
//
// 4 个断言:
//   #1 仅 compression.*  → compression wins.
//   #2 仅 extractors.A.* → ext wins (legacy back-compat preserved — 旧 config 不破).
//   #3 都没有            → session working model (providerName/modelId).
//   #4 compression + extractors.A 都设 → compression wins (precedence).
//
// ## 对抗性核查
//   - 直接调 buildCompressOpts(纯函数;不打 LLM)。
//   - 不 mock compressSession,因为这条 wiring 早已被 sub3b/sub4/sub5 覆盖到
//     consumption 点(see compression-core.ts:401 resolveModel(opts.providers,
//     opts.providerName, opts.modelId))。这里只验 opts 生成正确。
//
// ## 约束
// - vi.mock provider-factory.getContextWindow → 固定 200000,避免真 provider 解析。

import { describe, test, expect, vi } from "vitest";
import type { SessionConfig, RuntimeProviderConfig } from "../../src/runtime/types.js";

vi.mock("../../src/runtime/provider-factory.js", () => ({
	getContextWindow: () => 200000,
}));

import { buildCompressOpts } from "../../src/runtime/hooks/compression-trigger-hooks.js";

const PROVIDERS: RuntimeProviderConfig[] = [
	{
		name: "stub", type: "mock", apiKey: "k", baseUrl: "u",
		models: [{ id: "stub", name: "stub", contextWindow: 200000, maxTokens: 8000 }],
		enabled: true,
	},
];

/** Minimal SessionConfig skeleton — only the fields buildCompressOpts reads. */
function mkConfig(patch: Record<string, any>): SessionConfig {
	const base: any = {
		agentId: "a",
		workspaceDir: ".",
		systemPrompt: "s",
		providerName: "P_SESSION",
		modelId: "M_SESSION",
		toolPolicy: {},
	};
	return { ...base, ...patch } as SessionConfig;
}

describe("buildCompressOpts — compression model wiring (D2/O7)", () => {
	test("#1 config.compression.* set → compression wins", async () => {
		const config = mkConfig({
			compression: { provider: "P_COMP", model: "M_COMP" },
		});
		const opts = await buildCompressOpts(config, PROVIDERS);
		expect(opts.providerName).toBe("P_COMP");
		expect(opts.modelId).toBe("M_COMP");
	});

	test("#2 only extractors.A.* → ext wins (legacy back-compat)", async () => {
		const config = mkConfig({
			extractors: { A: { provider: "P_EXT", model: "M_EXT" } },
		});
		const opts = await buildCompressOpts(config, PROVIDERS);
		expect(opts.providerName).toBe("P_EXT");
		expect(opts.modelId).toBe("M_EXT");
	});

	test("#3 neither → session working model (providerName/modelId)", async () => {
		const config = mkConfig({});
		const opts = await buildCompressOpts(config, PROVIDERS);
		expect(opts.providerName).toBe("P_SESSION");
		expect(opts.modelId).toBe("M_SESSION");
	});

	test("#4 compression.* AND extractors.A.* → compression wins (precedence)", async () => {
		const config = mkConfig({
			compression: { provider: "P_COMP", model: "M_COMP" },
			extractors: { A: { provider: "P_EXT", model: "M_EXT" } },
		});
		const opts = await buildCompressOpts(config, PROVIDERS);
		expect(opts.providerName).toBe("P_COMP");
		expect(opts.modelId).toBe("M_COMP");
		// Adversarial: extractors.A must NOT leak through when compression is set.
		expect(opts.providerName).not.toBe("P_EXT");
		expect(opts.modelId).not.toBe("M_EXT");
	});
});
