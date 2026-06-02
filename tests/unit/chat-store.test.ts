import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { useChatStore, nextMsgId } from "../../src/renderer/store/chat-store.js";
import type { ChatMessage } from "../../src/renderer/store/chat-store.js";

const initialState = {
	messagesBySession: {},
	activeAgentId: null,
	activeSessionId: null,
	streamingSessions: new Set<string>(),
	messages: [] as ChatMessage[],
	isStreaming: false,
	sessionsByAgent: {},
};

function reset() {
	useChatStore.setState({ ...initialState, streamingSessions: new Set() });
}

function expectDualStateInvariant() {
	const s = useChatStore.getState();
	if (s.activeSessionId !== null) {
		expect(s.messages).toEqual(s.messagesBySession[s.activeSessionId] ?? []);
	}
}

function userMsg(text: string): ChatMessage {
	return { id: nextMsgId(), role: "user", text, timestamp: Date.now() };
}

function assistantMsg(text: string): ChatMessage {
	return {
		id: nextMsgId(),
		role: "assistant",
		text,
		blocks: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

describe("chat-store", () => {
	beforeEach(reset);
	afterEach(expectDualStateInvariant);

	describe("initial state", () => {
		test("starts empty", () => {
			const s = useChatStore.getState();
			expect(s.messagesBySession).toEqual({});
			expect(s.messages).toEqual([]);
			expect(s.activeSessionId).toBeNull();
			expect(s.activeAgentId).toBeNull();
			expect(s.isStreaming).toBe(false);
			expect(s.streamingSessions.size).toBe(0);
		});
	});

	describe("addMessage", () => {
		test("appends to inactive session — messages stays empty", () => {
			const { addMessage } = useChatStore.getState();
			addMessage("sess-a", userMsg("hi"));
			const s = useChatStore.getState();
			expect(s.messagesBySession["sess-a"]).toHaveLength(1);
			expect(s.messages).toEqual([]);
		});

		test("appends to active session — messages mirrors", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage } = useChatStore.getState();
			addMessage("sess-a", userMsg("hi"));
			const s = useChatStore.getState();
			expect(s.messages).toHaveLength(1);
			expect(s.messages[0].text).toBe("hi");
		});

		test("multiple addMessage append rather than replace", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage } = useChatStore.getState();
			addMessage("sess-a", userMsg("first"));
			addMessage("sess-a", userMsg("second"));
			const s = useChatStore.getState();
			expect(s.messages).toHaveLength(2);
			expect(s.messages[0].text).toBe("first");
			expect(s.messages[1].text).toBe("second");
		});
	});

	describe("updateAssistantText", () => {
		test("noop when no assistant message exists", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			useChatStore.getState().updateAssistantText("sess-a", "hello");
			expect(useChatStore.getState().messages).toEqual([]);
		});

		test("replaces text when last block is text", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage, updateAssistantText } = useChatStore.getState();
			addMessage("sess-a", assistantMsg("hello"));
			updateAssistantText("sess-a", "hello world");
			const s = useChatStore.getState();
			const last = s.messages[0];
			expect(last.blocks).toEqual([{ type: "text", text: "hello world" }]);
			expect(last.streaming).toBe(true);
		});

		test("appends new text block when last block is thinking", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage, updateAssistantText } = useChatStore.getState();
			addMessage("sess-a", {
				id: nextMsgId(),
				role: "assistant",
				text: "",
				blocks: [{ type: "thinking", text: "hmm" }],
				timestamp: Date.now(),
			});
			updateAssistantText("sess-a", "answer");
			const s = useChatStore.getState();
			expect(s.messages[0].blocks).toEqual([
				{ type: "thinking", text: "hmm" },
				{ type: "text", text: "answer" },
			]);
		});

		test("update on inactive session does not touch active messages", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage, updateAssistantText } = useChatStore.getState();
			addMessage("sess-b", assistantMsg("from-b"));
			updateAssistantText("sess-b", "from-b updated");
			expect(useChatStore.getState().messages).toEqual([]);
			const bMsg = useChatStore.getState().messagesBySession["sess-b"][0];
			expect(bMsg.blocks).toEqual([{ type: "text", text: "from-b updated" }]);
		});
	});

	describe("updateThinking", () => {
		test("appends thinking block to existing assistant message", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage, updateThinking } = useChatStore.getState();
			addMessage("sess-a", assistantMsg(""));
			updateThinking("sess-a", "pondering");
			const blocks = useChatStore.getState().messages[0].blocks!;
			expect(blocks[blocks.length - 1]).toEqual({ type: "thinking", text: "pondering" });
		});
	});

	describe("addToolCall / updateToolCall", () => {
		test("addToolCall appends a running tool block", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage, addToolCall } = useChatStore.getState();
			addMessage("sess-a", assistantMsg(""));
			addToolCall("sess-a", "bash", "ls");
			const blocks = useChatStore.getState().messages[0].blocks!;
			expect(blocks[blocks.length - 1]).toEqual({
				type: "tool",
				name: "bash",
				status: "running",
				args: "ls",
			});
		});

		test("updateToolCall only updates the most recent running tool with that name", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage, addToolCall, updateToolCall } = useChatStore.getState();
			addMessage("sess-a", assistantMsg(""));
			addToolCall("sess-a", "bash", "first");
			addToolCall("sess-a", "bash", "second");
			updateToolCall("sess-a", "bash", "done", "ok");
			const blocks = useChatStore.getState().messages[0].blocks!;
			const tools = blocks.filter((b) => b.type === "tool");
			expect(tools[0]).toMatchObject({ args: "first", status: "running" });
			expect(tools[1]).toMatchObject({ args: "second", status: "done", result: "ok" });
		});
	});

	describe("setIsStreaming / finishStreaming", () => {
		test("setIsStreaming(true) adds session, (false) removes", () => {
			const { setIsStreaming } = useChatStore.getState();
			setIsStreaming("sess-a", true);
			expect(useChatStore.getState().streamingSessions.has("sess-a")).toBe(true);
			setIsStreaming("sess-a", false);
			expect(useChatStore.getState().streamingSessions.has("sess-a")).toBe(false);
		});

		test("isStreaming is true only when active session is streaming", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			useChatStore.getState().setIsStreaming("sess-b", true);
			expect(useChatStore.getState().isStreaming).toBe(false);
			useChatStore.getState().setIsStreaming("sess-a", true);
			expect(useChatStore.getState().isStreaming).toBe(true);
		});

		test("finishStreaming clears streaming flag on all messages in session", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage, updateAssistantText, finishStreaming } = useChatStore.getState();
			addMessage("sess-a", assistantMsg(""));
			updateAssistantText("sess-a", "hi");
			expect(useChatStore.getState().messages[0].streaming).toBe(true);
			finishStreaming("sess-a");
			expect(useChatStore.getState().messages[0].streaming).toBe(false);
		});
	});

	describe("setActiveAgent / setActiveSessionId", () => {
		test("setActiveSessionId swaps messages to the new session's history", () => {
			const { addMessage, setActiveSessionId } = useChatStore.getState();
			addMessage("sess-a", userMsg("a-1"));
			addMessage("sess-b", userMsg("b-1"));
			setActiveSessionId("sess-a");
			expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(["a-1"]);
			setActiveSessionId("sess-b");
			expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(["b-1"]);
		});

		test("setActiveAgent commits current messages back before switching", () => {
			const { addMessage, setActiveAgent, setActiveSessionId } = useChatStore.getState();
			setActiveAgent("agent-1", "sess-a");
			addMessage("sess-a", userMsg("hello"));
			setActiveAgent("agent-2", "sess-b");
			expect(useChatStore.getState().messagesBySession["sess-a"]).toHaveLength(1);
		});
	});

	describe("initSession", () => {
		test("seeds messages and detects streaming flag", () => {
			const streamingMsg: ChatMessage = {
				id: nextMsgId(),
				role: "assistant",
				text: "thinking...",
				streaming: true,
				timestamp: Date.now(),
			};
			useChatStore.getState().setActiveSessionId("sess-a");
			useChatStore.getState().initSession("sess-a", { messages: [streamingMsg] });
			const s = useChatStore.getState();
			expect(s.messages).toHaveLength(1);
			expect(s.streamingSessions.has("sess-a")).toBe(true);
			expect(s.isStreaming).toBe(true);
		});

		test("non-streaming payload removes session from streamingSessions", () => {
			useChatStore.getState().setIsStreaming("sess-a", true);
			useChatStore.getState().initSession("sess-a", {
				messages: [{ id: "x", role: "user", text: "hi", timestamp: 0 }],
			});
			expect(useChatStore.getState().streamingSessions.has("sess-a")).toBe(false);
		});
	});

	describe("clearMessages / editMessage / deleteMessage", () => {
		test("clearMessages empties the session", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage, clearMessages } = useChatStore.getState();
			addMessage("sess-a", userMsg("hi"));
			clearMessages("sess-a");
			expect(useChatStore.getState().messages).toEqual([]);
		});

		test("editMessage rewrites text and replaces blocks", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const m = assistantMsg("old");
			const { addMessage, editMessage } = useChatStore.getState();
			addMessage("sess-a", m);
			editMessage("sess-a", m.id, "new text");
			const got = useChatStore.getState().messages[0];
			expect(got.text).toBe("new text");
			expect(got.blocks).toEqual([{ type: "text", text: "new text" }]);
		});

		test("deleteMessage removes by id", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const m1 = userMsg("first");
			const m2 = userMsg("second");
			const { addMessage, deleteMessage } = useChatStore.getState();
			addMessage("sess-a", m1);
			addMessage("sess-a", m2);
			deleteMessage("sess-a", m1.id);
			expect(useChatStore.getState().messages.map((m) => m.text)).toEqual(["second"]);
		});
	});

	describe("setSessions", () => {
		test("stores sessions keyed by agentId", () => {
			useChatStore.getState().setSessions("agent-1", [
				{ id: "s1", agentId: "agent-1", createdAt: 0, updatedAt: 0 } as any,
			]);
			expect(useChatStore.getState().sessionsByAgent["agent-1"]).toHaveLength(1);
		});
	});

	describe("dual-state invariant", () => {
		test("after every action, messages === messagesBySession[activeSessionId]", () => {
			const { setActiveSessionId, addMessage, updateAssistantText, finishStreaming } =
				useChatStore.getState();
			setActiveSessionId("sess-a");
			addMessage("sess-a", assistantMsg(""));
			updateAssistantText("sess-a", "hello");
			finishStreaming("sess-a");
			const s = useChatStore.getState();
			expect(s.messages).toBe(s.messagesBySession["sess-a"]);
		});
	});
});
