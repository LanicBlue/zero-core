// 角色配置持久化存储
//
// # 文件说明书
//
// ## 核心功能
// 管理 AI 角色配置的文件系统持久化存储（JSON 文件）
//
// ## 输入
// PersonaRecord 数据（ID、名称、角色、特征、通信风格等）
//
// ## 输出
// 角色列表、CRUD 操作
//
// ## 定位
// src/server/ — 服务层，为 IPC 提供角色配置存储
//
// ## 依赖
// uuid、core/config.ts、Node.js fs/path
//
// ## 维护规则
// 角色字段变更需确保 JSON 迁移兼容
//
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { ZERO_CORE_DIR } from "../core/config.js";

export interface PersonaRecord {
	id: string;
	name: string;
	role: string;
	traits: string[];
	expertise: string[];
	communicationStyle: string;
	customInstructions?: string;
	createdAt: string;
	updatedAt: string;
}

interface PersonaStoreData {
	personas: PersonaRecord[];
}

const DEFAULT_PERSONA: Omit<PersonaRecord, "id" | "createdAt" | "updatedAt"> = {
	name: "Zero",
	role: "Expert coding assistant with deep system design knowledge",
	traits: ["concise", "thorough", "pragmatic"],
	expertise: ["TypeScript", "system-design", "DevOps"],
	communicationStyle: "professional",
};

export class PersonaStore {
	private filePath: string;
	private data: PersonaStoreData;

	constructor(filePath?: string) {
		this.filePath = filePath ?? join(ZERO_CORE_DIR, "personas.json");
		this.data = this.load();
	}

	private load(): PersonaStoreData {
		if (existsSync(this.filePath)) {
			try {
				return JSON.parse(readFileSync(this.filePath, "utf-8"));
			} catch {
				// fall through
			}
		}
		const defaultData: PersonaStoreData = {
			personas: [this.createRecord(DEFAULT_PERSONA)],
		};
		this.save(defaultData);
		return defaultData;
	}

	private save(data: PersonaStoreData): void {
		const dir = join(this.filePath, "..");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
	}

	private createRecord(
		input: Omit<PersonaRecord, "id" | "createdAt" | "updatedAt">,
	): PersonaRecord {
		const now = new Date().toISOString();
		return { id: uuidv4(), ...input, createdAt: now, updatedAt: now };
	}

	list(): PersonaRecord[] {
		return this.data.personas;
	}

	get(id: string): PersonaRecord | undefined {
		return this.data.personas.find((p) => p.id === id);
	}

	create(input: Omit<PersonaRecord, "id" | "createdAt" | "updatedAt">): PersonaRecord {
		const record = this.createRecord(input);
		this.data.personas.push(record);
		this.save(this.data);
		return record;
	}

	update(id: string, input: Partial<Omit<PersonaRecord, "id" | "createdAt">>): PersonaRecord {
		const index = this.data.personas.findIndex((p) => p.id === id);
		if (index === -1) throw new Error(`Persona not found: ${id}`);
		this.data.personas[index] = {
			...this.data.personas[index],
			...input,
			updatedAt: new Date().toISOString(),
		};
		this.save(this.data);
		return this.data.personas[index];
	}

	delete(id: string): void {
		this.data.personas = this.data.personas.filter((p) => p.id !== id);
		this.save(this.data);
	}
}
