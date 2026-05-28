import { SqliteStore, type ColumnDef } from "./sqlite-store.js";
import type { SessionDB } from "./session-db.js";
import type { KnowledgeBase, KbFileInfo } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef[] = [
	{ key: "name" },
	{ key: "description" },
	{ key: "embeddingProvider", column: "embedding_provider" },
	{ key: "embeddingModel", column: "embedding_model" },
	{ key: "agentIds", column: "agent_ids", json: true },
	{ key: "files", json: true },
	{ key: "createdAt", column: "created_at" },
	{ key: "updatedAt", column: "updated_at" },
];

// ---------------------------------------------------------------------------
// KbStore
// ---------------------------------------------------------------------------

export class KbStore {
	private store: SqliteStore<KnowledgeBase>;

	constructor(sessionDB: SessionDB) {
		this.store = new SqliteStore<KnowledgeBase>(sessionDB.getDb(), "kb_entries", COLUMNS);
	}

	list(): KnowledgeBase[] {
		return this.store.list();
	}

	get(id: string): KnowledgeBase | undefined {
		return this.store.get(id);
	}

	create(input: Omit<KnowledgeBase, "id" | "createdAt" | "updatedAt">): KnowledgeBase {
		return this.store.create(input as any);
	}

	update(id: string, input: Partial<Omit<KnowledgeBase, "id" | "createdAt">>): KnowledgeBase {
		return this.store.update(id, input as any);
	}

	delete(id: string): void {
		this.store.delete(id);
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
		this.store.update(kbId, { files: kb.files } as any);
	}

	removeFile(kbId: string, filePath: string): void {
		const kb = this.get(kbId);
		if (!kb) return;
		kb.files = kb.files.filter((f) => f.path !== filePath);
		this.store.update(kbId, { files: kb.files } as any);
	}
}
