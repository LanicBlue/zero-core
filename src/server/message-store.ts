import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface StoredMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	timestamp: number;
	toolCalls?: { name: string; status: "running" | "done" | "error" }[];
}

const MSG_DIR = join(homedir(), ".zero-core", "messages");

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
