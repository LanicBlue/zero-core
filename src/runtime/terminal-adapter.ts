import * as readline from "node:readline";
import type { StreamEvent, AskUserEvent } from "./types.js";
import { pendingResponses } from "./pending-responses.js";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max) + "...";
}

// ---------------------------------------------------------------------------
// TerminalAdapter — translates StreamEvents into terminal output
// ---------------------------------------------------------------------------

export class TerminalAdapter {
	private rl: readline.Interface;
	private lastLineWasTool = false;
	private lastText = "";
	private askUserQueue: Array<{ event: AskUserEvent; resolve: () => void }> = [];
	private processingAsk = false;

	constructor(rl: readline.Interface) {
		this.rl = rl;
	}

	handleEvent(event: StreamEvent): void {
		switch (event.type) {
			case "text_delta": {
				// Streaming text — write directly, replacing previous delta
				this.lastText = event.text;
				break;
			}
			case "thinking_delta": {
				// Don't stream thinking in terminal by default (too noisy)
				break;
			}
			case "tool_start": {
				this.flushText();
				const label = event.args
					? `${event.toolName}(${truncate(JSON.stringify(event.args), 80)})`
					: event.toolName;
				process.stdout.write(`  ${DIM}${label}${RESET} ...\n`);
				this.lastLineWasTool = true;
				break;
			}
			case "tool_end": {
				const icon = event.isError ? `${RED}fail${RESET}` : `${GREEN}done${RESET}`;
				const result = event.result
					? truncate(
							typeof event.result === "string" ? event.result : JSON.stringify(event.result),
							200,
						)
					: "";
				process.stdout.write(`  ${icon} ${DIM}${event.toolName}${RESET}`);
				if (result) process.stdout.write(` ${GRAY}${result.replace(/\n/g, " ")}${RESET}`);
				process.stdout.write("\n");
				break;
			}
			case "message_end": {
				this.flushText();
				process.stdout.write("\n");
				break;
			}
			case "agent_end": {
				this.flushText();
				break;
			}
			case "error": {
				this.flushText();
				process.stdout.write(`\n${RED}${BOLD}Error:${RESET} ${event.error}\n\n`);
				break;
			}
			case "retry_attempt": {
				process.stdout.write(
					`${YELLOW}Retry ${event.attempt}/${event.maxAttempts} (${event.errorClass}) — waiting ${event.delayMs}ms${RESET}\n`,
				);
				break;
			}
			case "ask_user": {
				this.handleAskUser(event as AskUserEvent);
				break;
			}
			case "todos_update": {
				this.flushText();
				for (const todo of event.todos) {
					const icon =
						todo.status === "completed"
							? `${GREEN}[x]${RESET}`
							: todo.status === "in_progress"
								? `${YELLOW}[~]${RESET}`
								: `${DIM}[ ]${RESET}`;
					process.stdout.write(`  ${icon} ${todo.content}\n`);
				}
				break;
			}
			case "subagent_dispatched": {
				this.flushText();
				process.stdout.write(`  ${CYAN}dispatched${RESET} ${truncate(event.task, 60)} (task: ${event.taskId})\n`);
				break;
			}
			case "subagent_progress": {
				process.stdout.write(
					`  ${DIM}step ${event.step}${event.toolName ? ` — ${event.toolName}` : ""}${RESET}\n`,
				);
				break;
			}
			case "subagent_completed": {
				const icon = event.status === "completed" ? `${GREEN}done${RESET}` : `${RED}fail${RESET}`;
				const result = event.result ? truncate(event.result, 100) : "";
				process.stdout.write(`  ${icon} task ${event.taskId}${result ? `: ${DIM}${result.replace(/\n/g, " ")}${RESET}` : ""}\n`);
				break;
			}
		}
	}

	private flushText(): void {
		if (this.lastText) {
			process.stdout.write(this.lastText);
			this.lastText = "";
		}
	}

	private handleAskUser(event: AskUserEvent): void {
		// Queue ask_user events — process one at a time (readline is single-threaded)
		const promise = new Promise<void>((resolve) => {
			this.askUserQueue.push({ event, resolve });
		});

		void this.processAskQueue();

		// Don't await — the event handler is synchronous
		// The queue will process asynchronously
	}

	private async processAskQueue(): Promise<void> {
		if (this.processingAsk) return;
		this.processingAsk = true;

		while (this.askUserQueue.length > 0) {
			const { event, resolve } = this.askUserQueue.shift()!;
			await this.doAskUser(event);
			resolve();
		}

		this.processingAsk = false;
	}

	private async doAskUser(event: AskUserEvent): Promise<void> {
		this.flushText();
		const answers: Record<string, string> = {};

		for (const q of event.questions) {
			process.stdout.write(`\n${BOLD}${q.header ? `[${q.header}] ` : ""}${q.question}${RESET}\n`);

			if (q.options?.length) {
				q.options.forEach((opt, i) => {
					process.stdout.write(`  ${i + 1}. ${opt.label}`);
					if (opt.description) process.stdout.write(` ${DIM}— ${opt.description}${RESET}`);
					process.stdout.write("\n");
				});
				process.stdout.write(`  0. Other (free text)\n`);

				const answer = await this.readlineQuestion("Select: ");

				if (answer === "0" || !answer) {
					const freeText = await this.readlineQuestion("Your answer: ");
					answers[q.question] = freeText;
				} else {
					const idx = parseInt(answer, 10) - 1;
					if (idx >= 0 && idx < q.options!.length) {
						answers[q.question] = q.options![idx].label;
					} else {
						answers[q.question] = answer;
					}
				}
			} else {
				const answer = await this.readlineQuestion("Your answer: ");
				answers[q.question] = answer;
			}
		}

		pendingResponses.resolveRequest(event.requestId, answers);
		process.stdout.write("\n");
	}

	private readlineQuestion(prompt: string): Promise<string> {
		return new Promise((resolve) => {
			this.rl.question(prompt, (answer) => {
				resolve(answer.trim());
			});
		});
	}

	close(): void {
		this.flushText();
	}
}
