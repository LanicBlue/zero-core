/**
 * System prompt section-based assembly with caching.
 *
 * Inspired by claude-code's `systemPromptSection` pattern:
 * - Stable sections are computed once and cached across turns
 * - Dynamic sections (cacheBreak: true) are recomputed every turn
 * - Supports targeted invalidation for future dynamic config changes
 */

export interface PromptSection {
	name: string;
	compute: () => string | Promise<string>;
	/** true = recompute every turn; false = cache until invalidate() */
	cacheBreak: boolean;
}

export interface ResolvedSection {
	text: string;
	cacheBreak: boolean;
}

export class SystemPromptAssembler {
	private cache = new Map<string, string | null>();

	constructor(private sections: PromptSection[]) {}

	async assemble(): Promise<ResolvedSection[]> {
		const results: ResolvedSection[] = [];
		for (const section of this.sections) {
			if (!section.cacheBreak && this.cache.has(section.name)) {
				const cached = this.cache.get(section.name)!;
				if (cached) results.push({ text: cached, cacheBreak: false });
				continue;
			}
			const value = await section.compute();
			this.cache.set(section.name, value || null);
			if (value) results.push({ text: value, cacheBreak: section.cacheBreak });
		}
		return results;
	}

	invalidate(name?: string): void {
		if (name) {
			this.cache.delete(name);
		} else {
			this.cache.clear();
		}
	}
}
