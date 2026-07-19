import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const MINIMUM_NODE = "24.14.0";

function versionTuple(value: string): [number, number, number] {
	const match = value.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) throw new Error(`Invalid Node version: ${value}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number {
	const a = versionTuple(left);
	const b = versionTuple(right);
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

describe("Node runtime baseline", () => {
	test("the running Node version satisfies the supported minimum", () => {
		expect(
			compareVersions(process.versions.node, MINIMUM_NODE),
			`Node ${MINIMUM_NODE}+ is required; running ${process.versions.node}`,
		).toBeGreaterThanOrEqual(0);
	});

	test("package engines and .nvmrc use the same minimum", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		const nvmrc = readFileSync(join(ROOT, ".nvmrc"), "utf8").trim();

		expect(pkg.engines?.node).toBe(`>=${MINIMUM_NODE}`);
		expect(nvmrc).toBe(MINIMUM_NODE);
	});
});
