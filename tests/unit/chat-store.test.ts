import { describe, test, expect, beforeEach } from "vitest";
import {
	useChatStore,
	nextMsgId,
	selectActiveMessages,
	selectIsStreaming,
} from "../../src/renderer/store/chat-store.js";
import type { ChatMessage } from "../../src/renderer/store/chat-store.js";

const initialState = {
	messagesBySession: {},
	activeAgentId: null as string | null,
	activeSessionId: null as string | null,
	streamingSessions: new Set<string>(),
	sessionsByAgent: {},
};

function reset() {
	useChatStore.setState({ ...initialState, streamingSessions: new Set() });
}

function activeMessages(): ChatMessage[] {
	return selectActiveMessages(useChatStore.getState());
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

	describe("initial state", () => {
		test("starts empty", () => {
			const s = useChatStore.getState();
			expect(s.messagesBySession).toEqual({});
			expect(s.activeSessionId).toBeNull();
			expect(s.activeAgentId).toBeNull();
			expect(s.streamingSessions.size).toBe(0);
			expect(activeMessages()).toEqual([]);
			expect(selectIsStreaming(s)).toBe(false);
		});
	});

	describe("addMessage", () => {
		test("appends to inactive session — activeMessages stays empty", () => {
			const { addMessage } = useChatStore.getState();
			addMessage("sess-a", userMsg("hi"));
			expect(useChatStore.getState().messagesBySession["sess-a"]).toHaveLength(1);
			expect(activeMessages()).toEqual([]);
		});

		test("appends to active session — activeMessages mirrors", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage } = useChatStore.getState();
			addMessage("sess-a", userMsg("hi"));
			expect(activeMessages()).toHaveLength(1);
			expect(activeMessages()[0].text).toBe("hi");
		});

		test("multiple addMessage append rather than replace", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage } = useChatStore.getState();
			addMessage("sess-a", userMsg("first"));
			addMessage("sess-a", userMsg("second"));
			expect(activeMessages().map((m) => m.text)).toEqual(["first", "second"]);
		});
	});

	describe("updateAssistantText", () => {
		test("noop when no assistant message exists", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			useChatStore.getState().updateAssistantText("sess-a", "hello");
			expect(activeMessages()).toEqual([]);
		});

		test("replaces text when last block is text", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage, updateAssistantText } = useChatStore.getState();
			addMessage("sess-a", assistantMsg("hello"));
			updateAssistantText("sess-a", "hello world");
			const last = activeMessages()[0];
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
			expect(activeMessages()[0].blocks).toEqual([
				{ type: "thinking", text: "hmm" },
				{ type: "text", text: "answer" },
			]);
		});

		test("update on inactive session does not touch active messages", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage, updateAssistantText } = useChatStore.getState();
			addMessage("sess-b", assistantMsg("from-b"));
			updateAssistantText("sess-b", "from-b updated");
			expect(activeMessages()).toEqual([]);
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
			const blocks = activeMessages()[0].blocks!;
			expect(blocks[blocks.length - 1]).toEqual({ type: "thinking", text: "pondering" });
		});
	});

	describe("addToolCall / updateToolCall", () => {
		test("addToolCall appends a running tool block", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage, addToolCall } = useChatStore.getState();
			addMessage("sess-a", assistantMsg(""));
			addToolCall("sess-a", "bash", "ls");
			const blocks = activeMessages()[0].blocks!;
			expect(blocks[blocks.length - 1]).toMatchObject({
				type: "tool",
				name: "bash",
				status: "running",
				args: "ls",
				startedAt: expect.any(Number),
			});
		});

		test("updateToolCall only updates the most recent running tool with that name", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage, addToolCall, updateToolCall } = useChatStore.getState();
			addMessage("sess-a", assistantMsg(""));
			addToolCall("sess-a", "bash", "first");
			addToolCall("sess-a", "bash", "second");
			updateToolCall("sess-a", "bash", "done", "ok");
			const blocks = activeMessages()[0].blocks!;
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
			expect(selectIsStreaming(useChatStore.getState())).toBe(false);
			useChatStore.getState().setIsStreaming("sess-a", true);
			expect(selectIsStreaming(useChatStore.getState())).toBe(true);
		});

		test("finishStreaming clears streaming flag on all messages in session", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const { addMessage, updateAssistantText, finishStreaming } = useChatStore.getState();
			addMessage("sess-a", assistantMsg(""));
			updateAssistantText("sess-a", "hi");
			expect(activeMessages()[0].streaming).toBe(true);
			finishStreaming("sess-a");
			expect(activeMessages()[0].streaming).toBe(false);
		});
	});

	describe("setActiveAgent / setActiveSessionId", () => {
		test("setActiveSessionId swaps messages to the new session's history", () => {
			const { addMessage, setActiveSessionId } = useChatStore.getState();
			addMessage("sess-a", userMsg("a-1"));
			addMessage("sess-b", userMsg("b-1"));
			setActiveSessionId("sess-a");
			expect(activeMessages().map((m) => m.text)).toEqual(["a-1"]);
			setActiveSessionId("sess-b");
			expect(activeMessages().map((m) => m.text)).toEqual(["b-1"]);
		});

		test("setActiveAgent switches activeAgentId and activeSessionId", () => {
			useChatStore.getState().setActiveAgent("agent-1", "sess-a");
			expect(useChatStore.getState().activeAgentId).toBe("agent-1");
			expect(useChatStore.getState().activeSessionId).toBe("sess-a");
			useChatStore.getState().setActiveAgent("agent-2", "sess-b");
			expect(useChatStore.getState().activeAgentId).toBe("agent-2");
			expect(useChatStore.getState().activeSessionId).toBe("sess-b");
		});

		test("setActiveAgent preserves messagesBySession across switches", () => {
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
			expect(activeMessages()).toHaveLength(1);
			expect(s.streamingSessions.has("sess-a")).toBe(true);
			expect(selectIsStreaming(s)).toBe(true);
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
			expect(activeMessages()).toEqual([]);
		});

		test("editMessage rewrites text and replaces blocks", () => {
			useChatStore.getState().setActiveSessionId("sess-a");
			const m = assistantMsg("old");
			const { addMessage, editMessage } = useChatStore.getState();
			addMessage("sess-a", m);
			editMessage("sess-a", m.id, "new text");
			const got = activeMessages()[0];
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
			expect(activeMessages().map((m) => m.text)).toEqual(["second"]);
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

	describe("single-source invariant", () => {
		test("activeMessages() always equals messagesBySession[activeSessionId]", () => {
			const { setActiveSessionId, addMessage, updateAssistantText, finishStreaming } =
				useChatStore.getState();
			setActiveSessionId("sess-a");
			addMessage("sess-a", assistantMsg(""));
			updateAssistantText("sess-a", "hello");
			finishStreaming("sess-a");
			const s = useChatStore.getState();
			expect(activeMessages()).toBe(s.messagesBySession["sess-a"]);
		});

		test("no session active → activeMessages() returns []", () => {
			const { addMessage } = useChatStore.getState();
			addMessage("sess-a", userMsg("hi"));
			expect(activeMessages()).toEqual([]);
		});
	});
});
