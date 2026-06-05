// 消息文件存储
//
// # 文件说明书
//
// ## 核心功能
// 基于文件系统的消息存储，每条消息以 JSON 文件形式保存
//
// ## 输入
// StoredMessage 数据（角色、文本、时间戳、工具调用状态）
//
// ## 输出
// 消息读写操作、消息列表查询
//
// ## 定位
// src/server/ — 服务层，为会话历史提供文件级消息存储
//
// ## 依赖
// core/config.ts、Node.js fs/path
//
// ## 维护规则
// 消息格式变更需确保可读取历史消息
//
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ZERO_CORE_DIR } from "../core/config.js";

export interface StoredMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	timestamp: number;
	toolCalls?: { name: string; status: "running" | "done" | "error" }[];
}

const MSG_DIR = join(ZERO_CORE_DIR, "messages");

if (!existsSync(MSG_DIR)) mkdirSync(MSG_DIR, { recursive: true });

function filePath(personaId: string): string {
	return join(MSG_DIR, `${personaId}.json`);
}

function readFile(personaId: string): StoredMessage[] {
	const fp = filePath(personaId);
	if (!existsSync(fp)) return [];
	try {
		return JSON.parse(readFileSync(fp, "utf-8"));
	} catch {
		return [];
	}
}

function writeFile(personaId: string, messages: StoredMessage[]): void {
	writeFileSync(filePath(personaId), JSON.stringify(messages, null, 2));
}

let nextId = Date.now();

export function createMessageStore() {
	return {
		list(personaId: string): StoredMessage[] {
			return readFile(personaId);
		},

		addUserMessage(personaId: string, text: string): StoredMessage {
			const messages = readFile(personaId);
			const msg: StoredMessage = {
				id: String(nextId++),
				role: "user",
				text,
				timestamp: Date.now(),
			};
			messages.push(msg);
			writeFile(personaId, messages);
			return msg;
		},

		addAssistantMessage(personaId: string, text: string, toolCalls?: StoredMessage["toolCalls"]): StoredMessage {
			const messages = readFile(personaId);
			const msg: StoredMessage = {
				id: String(nextId++),
				role: "assistant",
				text,
				timestamp: Date.now(),
				toolCalls,
			};
			messages.push(msg);
			writeFile(personaId, messages);
			return msg;
		},

		clear(personaId: string): void {
			writeFile(personaId, []);
		},
	};
}
