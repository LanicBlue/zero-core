import { describe, test, expect, beforeEach } from "vitest";
import {
	resolveModel,
	getContextWindow,
	clearProviderCache,
} from "../../src/runtime/provider-factory.js";
import type { RuntimeProviderConfig } from "../../src/runtime/types.js";

const MOCK_FIXTURE = "tests/e2e/fixtures/simple-response.json";

function makeProvider(overrides: Partial<RuntimeProviderConfig> = {}): RuntimeProviderConfig {
	return {
		name: "TestProvider",
		type: "mock",
		apiKey: "test-key",
		baseUrl: MOCK_FIXTURE,
		enabled: true,
		models: [{ id: "test-model", name: "Test", contextWindow: 64000 }],
		...overrides,
	} as RuntimeProviderConfig;
}

describe("provider-factory.getContextWindow", () => {
	test("returns model contextWindow when model exists", () => {
		const providers = [makeProvider()];
		expect(getContextWindow(providers, "TestProvider", "test-model")).toBe(64000);
	});

	test("falls back to 128000 when model not found in provider", () => {
		const providers = [makeProvider()];
		expect(getContextWindow(providers, "TestProvider", "missing-model")).toBe(128000);
	});

	test("falls back to 128000 when provider not found", () => {
		const providers = [makeProvider()];
		expect(getContextWindow(providers, "OtherProvider", "any")).toBe(128000);
	});

	test("falls back to 128000 when provider list is empty", () => {
		expect(getContextWindow([], "Any", "any")).toBe(128000);
	});

	test("normalizes provider name (case-insensitive)", () => {
		const providers = [makeProvider()];
		expect(getContextWindow(providers, "testprovider", "test-model")).toBe(64000);
		expect(getContextWindow(providers, "TESTPROVIDER", "test-model")).toBe(64000);
	});

	test("normalizes provider name (special chars to hyphens)", () => {
		const providers = [makeProvider({ name: "My Provider 1" })];
		expect(getContextWindow(providers, "my-provider-1", "test-model")).toBe(64000);
		expect(getContextWindow(providers, "My Provider 1", "test-model")).toBe(64000);
	});
});

describe("provider-factory.resolveModel errors", () => {
	beforeEach(clearProviderCache);

	test("throws when provider not found", () => {
		expect(() => resolveModel([], "Missing", "any")).toThrow(/Provider not found or not enabled/);
	});

	test("throws when provider disabled", () => {
		const providers = [makeProvider({ enabled: false })];
		expect(() => resolveModel(providers, "TestProvider", "test-model")).toThrow(/Provider not found or not enabled/);
	});

	test("throws when provider has no apiKey", () => {
		const providers = [makeProvider({ apiKey: "" })];
		expect(() => resolveModel(providers, "TestProvider", "test-model")).toThrow(/Provider not found or not enabled/);
	});
});

describe("provider-factory.resolveModel mock", () => {
	beforeEach(clearProviderCache);

	test("returns a language model for mock provider", () => {
		const providers = [makeProvider()];
		const model = resolveModel(providers, "TestProvider", "test-model");
		expect(model).toBeDefined();
		expect(typeof model).toBe("object");
	});

	test("caches provider factory by config fingerprint", () => {
		const providers = [makeProvider()];
		// Two resolutions with same config should not throw — second call hits cache
		const m1 = resolveModel(providers, "TestProvider", "test-model");
		const m2 = resolveModel(providers, "TestProvider", "test-model");
		expect(m1).toBeDefined();
		expect(m2).toBeDefined();
	});

	test("different model IDs on same provider both resolve", () => {
		const providers = [makeProvider({
			models: [
				{ id: "model-a", name: "A", contextWindow: 32000 },
				{ id: "model-b", name: "B", contextWindow: 64000 },
			],
		})];
		expect(resolveModel(providers, "TestProvider", "model-a")).toBeDefined();
		expect(resolveModel(providers, "TestProvider", "model-b")).toBeDefined();
	});
});

describe("provider-factory.clearProviderCache", () => {
	test("does not throw when cache is empty", () => {
		expect(() => clearProviderCache()).not.toThrow();
	});

	test("does not throw after cache populated", () => {
		resolveModel([makeProvider()], "TestProvider", "test-model");
		expect(() => clearProviderCache()).not.toThrow();
	});
});
