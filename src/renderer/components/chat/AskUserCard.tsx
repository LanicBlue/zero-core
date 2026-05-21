import React, { useState } from "react";
import type { AskUserQuestion } from "../../store/interaction-store.js";

const api = () => (window as any).api;

interface Props {
	requestId: string;
	questions: AskUserQuestion[];
	onDone: () => void;
}

export default function AskUserCard({ requestId, questions, onDone }: Props) {
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [customInput, setCustomInput] = useState<Record<string, string>>({});

	const handleSelect = (qIdx: number, label: string) => {
		setAnswers((prev) => ({ ...prev, [`q${qIdx}`]: label }));
	};

	const handleCustomSubmit = (qIdx: number) => {
		const val = customInput[qIdx.toString()]?.trim();
		if (!val) return;
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
			{questions.map((q, qi) => (
				<div key={qi} className="ask-user-question">
					{q.header && <span className="ask-user-chip">{q.header}</span>}
					<p className="ask-user-q-text">{q.question}</p>
					{q.options ? (
						<div className="ask-user-options">
							{q.options.map((opt, oi) => (
								<button
									key={oi}
									className={`ask-user-option ${answers[`q${qi}`] === opt.label ? "selected" : ""}`}
									onClick={() => handleSelect(qi, opt.label)}
								>
									<span className="ask-user-opt-label">{opt.label}</span>
									{opt.description && <span className="ask-user-opt-desc">{opt.description}</span>}
								</button>
							))}
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
									if (e.key === "Enter") handleCustomSubmit(qi);
								}}
							/>
							<button onClick={() => handleCustomSubmit(qi)}>Submit</button>
						</div>
					)}
				</div>
			))}
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
