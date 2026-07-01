// Input queue strip (above the chat input bar, Phase C2).
//
// Shows inputs the user submitted while the session was running. Each item:
// queued (waits for run end → next turn) or insert_now (injects at next step).
// Actions: promote queued → insert_now, delete. Hidden when empty.
//
import React from "react";
import { useChatStore, selectIsStreaming } from "../../store/chat-store.js";
import { useInputQueueStore } from "../../store/input-queue-store.js";

export default function InputQueueStrip() {
	const activeSessionId = useChatStore((s) => s.activeSessionId);
	const isStreaming = useChatStore(selectIsStreaming);
	const { itemsBySession, promote, remove } = useInputQueueStore();

	const items = activeSessionId ? (itemsBySession[activeSessionId] ?? []) : [];
	if (items.length === 0) return null;

	return (
		<div className="input-queue-strip">
			<div className="input-queue-header">
				<span>队列等待 · {items.length}</span>
				{!isStreaming && <span className="input-queue-hint">(会话空闲,下一项将立即发送)</span>}
			</div>
			{items.map((it) => (
				<div key={it.id} className={`input-queue-item mode-${it.mode}`}>
					<span className="input-queue-mode">{it.mode === "insert_now" ? "⇡插入" : "⏳等待"}</span>
					<span className="input-queue-content">{it.content}</span>
					<div className="input-queue-actions">
						{it.mode === "queued" && (
							<button type="button" className="input-queue-btn" onClick={() => promote(it.id)} title="立即插入到下一个 agent loop">立即插入</button>
						)}
						<button type="button" className="input-queue-btn input-queue-remove" onClick={() => remove(it.id)} title="删除">×</button>
					</div>
				</div>
			))}
		</div>
	);
}
