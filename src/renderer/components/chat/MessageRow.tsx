// Read-only chat message row.
//
// # 文件说明书
//
// ## 核心功能
// 渲染单条 ChatMessage(头像 + 内容:user 文本 / assistant blocks),只读 —— 无
// 编辑/删除操作。供 TaskDetailView 的"子代理对话"下栏复用主聊天的视觉。
// ChatPanel 自己仍走带编辑操作的内联渲染(行为不变)。
//
// ## 定位
// src/renderer/components/chat/ — 被 TaskDetailView 使用。
//
import React from "react";
import { renderBlocks } from "./message-blocks.js";
import type { ChatMessage } from "../../store/chat-store.js";

interface Props {
	message: ChatMessage;
	/** Avatar letter for the assistant side (sub-agent's identity). */
	avatarLetter?: string;
}

export default function MessageRow({ message, avatarLetter = "Z" }: Props) {
	const renderContent = () => {
		if (message.role === "user") return message.text;
		const blocks = message.blocks;
		if (!blocks || blocks.length === 0) {
			if (message.streaming) {
				return (
					<>
						<span className="thinking-dots">Thinking</span>
						<span className="cursor-blink">|</span>
					</>
				);
			}
			return message.text || "";
		}
		return (
			<>
				{renderBlocks(blocks, !!message.streaming)}
				{message.streaming && <span className="cursor-blink">|</span>}
			</>
		);
	};

	return (
		<div className={`message message-${message.role}`}>
			<div className="message-avatar">{message.role === "user" ? "U" : avatarLetter}</div>
			<div className="message-content-wrapper">
				<div className="message-content">{renderContent()}</div>
			</div>
		</div>
	);
}
