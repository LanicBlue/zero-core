// AskUser 交互卡片组件
//
// # 文件说明书
//
// ## 核心功能
// 显示 Agent 提问并提供选项供用户回复的交互卡片。即使 Agent 只给了固定选项,
// 也永远附带一个 "Other" 入口,用户可输入任意自定义文本作为回答。
//
// ## 输入
// AskUserQuestion（问题、选项、描述）
//
// ## 输出
// 用户选择结果通过 IPC 返回给 Agent
//
// ## 定位
// src/renderer/components/chat/ — 聊天组件，处理 Agent-用户交互
//
// ## 依赖
// React、store/interaction-store.ts
//
// ## 维护规则
// 交互选项格式变更需同步 interaction-store
//

import React, { useState } from "react";
import type { AskUserQuestion } from "../../store/interaction-store.js";

const api = () => (window as any).api;

interface Props {
	requestId: string;
	questions: AskUserQuestion[];
	onDone: () => void;
}

// Sentinel marking "Other" selection (real answer lives in customInput).
const OTHER = "__other__";

export default function AskUserCard({ requestId, questions, onDone }: Props) {
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [customInput, setCustomInput] = useState<Record<string, string>>({});

	const answerFor = (qi: number) => answers[`q${qi}`];

	const handleSelect = (qIdx: number, label: string) => {
		setAnswers((prev) => ({ ...prev, [`q${qIdx}`]: label }));
	};

	const handleOtherSubmit = (qIdx: number) => {
		const val = customInput[qIdx.toString()]?.trim();
		if (!val) return;
		// Store the real custom value (not the sentinel) as the answer.
		setAnswers((prev) => ({ ...prev, [`q${qIdx}`]: val }));
	};

	const handleSubmit = async () => {
		if (Object.keys(answers).length < questions.length) return;
		await api().askUserRespond(requestId, answers);
		onDone();
	};

	const allAnswered = Object.keys(answers).length >= questions.length;

	return (
		<div className="ask-user-card">
			<div className="ask-user-header">Agent is asking a question</div>
			{questions.map((q, qi) => {
				const ans = answerFor(qi);
				const isOtherSelected = ans !== undefined && ans !== OTHER && q.options?.some((o) => o.label === ans) === false;
				return (
				<div key={qi} className="ask-user-question">
					{q.header && <span className="ask-user-chip">{q.header}</span>}
					<p className="ask-user-q-text">{q.question}</p>
					{q.options ? (
						<div className="ask-user-options">
							{q.options.map((opt, oi) => (
								<button
									key={oi}
									className={`ask-user-option ${ans === opt.label ? "selected" : ""}`}
									onClick={() => handleSelect(qi, opt.label)}
								>
									<span className="ask-user-opt-label">{opt.label}</span>
									{opt.description && <span className="ask-user-opt-desc">{opt.description}</span>}
								</button>
							))}
							{/* Always-present "Other" escape hatch — user can type any answer. */}
							<button
								className={`ask-user-option other ${isOtherSelected ? "selected" : ""}`}
								onClick={() => handleSelect(qi, OTHER)}
							>
								<span className="ask-user-opt-label">Other…</span>
							</button>
							{ans === OTHER && (
								<div className="ask-user-other-input">
									<input
										type="text"
										placeholder="Type your answer..."
										value={customInput[qi.toString()] ?? ""}
										autoFocus
										onChange={(e) =>
											setCustomInput((prev) => ({ ...prev, [qi.toString()]: e.target.value }))
										}
										onKeyDown={(e) => {
											if (e.key === "Enter") handleOtherSubmit(qi);
										}}
									/>
									<button onClick={() => handleOtherSubmit(qi)}>Submit</button>
								</div>
							)}
						</div>
					) : (
						<div className="ask-user-free-input">
							<input
								type="text"
								placeholder="Type your answer..."
								value={customInput[qi.toString()] ?? ""}
								onChange={(e) =>
									setCustomInput((prev) => ({ ...prev, [qi.toString()]: e.target.value }))
								}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleOtherSubmit(qi);
								}}
							/>
							<button onClick={() => handleOtherSubmit(qi)}>Submit</button>
						</div>
					)}
				</div>
				);
			})}
			<button
				className={`ask-user-submit ${allAnswered ? "ready" : ""}`}
				onClick={handleSubmit}
				disabled={!allAnswered}
			>
				Send Response
			</button>
		</div>
	);
}
