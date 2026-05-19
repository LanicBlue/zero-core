import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Knowledge Base Record
// ---------------------------------------------------------------------------

export interface KnowledgeBase {
	id: string;
	name: string;
	description: string;
	/** Embedding provider: "openai" | "ollama" */
	embeddingProvider: string;
	/** Model name for embeddings */
	embeddingModel: string;
	/** Associated agent IDs (empty = available to all) */
	agentIds: string[];
	/** Files tracked by this knowledge base */
	files: KbFileInfo[];
	createdAt: string;
	updatedAt: string;
}

export interface KbFileInfo {
	path: string;
	name: string;
	size: number;
	chunks: number;
	ingestedAt: string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

interface KbStoreData {
	knowledgeBases: KnowledgeBase[];
}

export class KbStore {
	private filePath: string;
	private data: KbStoreData;

	constructor(filePath?: string) {
		this.filePath = filePath ?? join(homedir(), ".zero-core", "knowledge-bases.json");
		this.data = this.load();
	}

	private load(): KbStoreData {
		if (existsSync(this.filePath)) {
			try {
				return JSON.parse(readFileSync(this.filePath, "utf-8"));
			} catch {
				// fall through
			}
		}
		const data: KbStoreData = { knowledgeBases: [] };
		this.save(data);
		return data;
	}

	private save(data: KbStoreData): void {
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
	}

	list(): KnowledgeBase[] {
		return this.data.knowledgeBases;
	}

	get(id: string): KnowledgeBase | undefined {
		return this.data.knowledgeBases.find((kb) => kb.id === id);
	}

	create(input: Omit<KnowledgeBase, "id" | "createdAt" | "updatedAt">): KnowledgeBase {
		const now = new Date().toISOString();
		const record: KnowledgeBase = {
			id: uuidv4(),
			...input,
			createdAt: now,
			updatedAt: now,
		};
		this.data.knowledgeBases.push(record);
		this.save(this.data);
		return record;
	}

	update(id: string, input: Partial<Omit<KnowledgeBase, "id" | "createdAt">>): KnowledgeBase {
		const index = this.data.knowledgeBases.findIndex((kb) => kb.id === id);
		if (index === -1) throw new Error(`Knowledge base not found: ${id}`);
		this.data.knowledgeBases[index] = {
			...this.data.knowledgeBases[index],
			...input,
			updatedAt: new Date().toISOString(),
		};
		this.save(this.data);
		return this.data.knowledgeBases[index];
	}

	delete(id: string): void {
		this.data.knowledgeBases = this.data.knowledgeBases.filter((kb) => kb.id !== id);
		this.save(this.data);
	}

	updateFile(kbId: string, fileInfo: KbFileInfo): void {
		const kb = this.get(kbId);
		if (!kb) return;
		const idx = kb.files.findIndex((f) => f.path === fileInfo.path);
		if (idx >= 0) {
			kb.files[idx] = fileInfo;
		} else {
			kb.files.push(fileInfo);
		}
		kb.updatedAt = new Date().toISOString();
		this.save(this.data);
	}

	removeFile(kbId: string, filePath: string): void {
		const kb = this.get(kbId);
		if (!kb) return;
		kb.files = kb.files.filter((f) => f.path !== filePath);
		kb.updatedAt = new Date().toISOString();
		this.save(this.data);
	}
}
