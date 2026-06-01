import { ConcurrencyQueue } from "./concurrency-queue.js";
import { log } from "../core/logger.js";

export interface ConcurrencyConfig {
	enableConcurrencyLimit: boolean;
	maxConcurrency: number;
}

export class ProviderConcurrencyManager {
	private queues = new Map<string, ConcurrencyQueue>();

	getQueue(providerName: string): ConcurrencyQueue | undefined {
		return this.queues.get(normalize(providerName));
	}

	reconfigure(configs: Array<{ name: string; enableConcurrencyLimit?: boolean; maxConcurrency?: number }>): void {
		const enabledKeys = new Set<string>();

		for (const cfg of configs) {
			const key = normalize(cfg.name);
			if (cfg.enableConcurrencyLimit) {
				enabledKeys.add(key);
				const maxConcurrency = clampConcurrency(cfg.maxConcurrency);
				const queue = this.queues.get(key);
				if (queue) {
					queue.setMax(maxConcurrency);
				} else {
					this.queues.set(key, new ConcurrencyQueue(maxConcurrency));
					log.debug("concurrency", `Created queue for ${key}, max=${maxConcurrency}`);
				}
			}
		}

		for (const [key] of this.queues) {
			if (!enabledKeys.has(key)) {
				this.queues.delete(key);
			}
		}
	}

	clear(): void {
		this.queues.clear();
	}
}

function normalize(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function clampConcurrency(n?: number): number {
	if (typeof n !== "number" || n < 1) return 1;
	if (n > 10) return 10;
	return n;
}
