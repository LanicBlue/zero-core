import React, { useState } from "react";
import { usePersona, type PersonaRecord } from "../../store/persona-store.js";

interface Props {
	personaId: string | null;
	personas: PersonaRecord[];
	onClose: () => void;
}

const EMPTY = { name: "", role: "", traits: [] as string[], expertise: [] as string[], communicationStyle: "professional", customInstructions: "" };

export default function PersonaEditor({ personaId, personas, onClose }: Props) {
	const { create, update } = usePersona();
	const existing = personaId ? personas.find((p) => p.id === personaId) : null;
	const [form, setForm] = useState(existing ?? EMPTY);
	const [traitsText, setTraitsText] = useState((existing?.traits ?? []).join(", "));
	const [expertiseText, setExpertiseText] = useState((existing?.expertise ?? []).join(", "));

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		const data = {
			...form,
			traits: traitsText.split(",").map((s) => s.trim()).filter(Boolean),
			expertise: expertiseText.split(",").map((s) => s.trim()).filter(Boolean),
		};

		if (existing) {
			await update(existing.id, data);
		} else {
			await create(data as Omit<PersonaRecord, "id" | "createdAt" | "updatedAt">);
		}
		onClose();
	};

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal" onClick={(e) => e.stopPropagation()}>
				<h2>{existing ? "Edit Persona" : "New Persona"}</h2>
				<form onSubmit={submit}>
					<label>
						Name
						<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
					</label>
					<label>
						Role
						<input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="e.g. Expert coding assistant" required />
					</label>
					<label>
						Traits (comma-separated)
						<input value={traitsText} onChange={(e) => setTraitsText(e.target.value)} placeholder="e.g. concise, thorough, pragmatic" />
					</label>
					<label>
						Expertise (comma-separated)
						<input value={expertiseText} onChange={(e) => setExpertiseText(e.target.value)} placeholder="e.g. TypeScript, system-design" />
					</label>
					<label>
						Communication Style
						<select value={form.communicationStyle} onChange={(e) => setForm({ ...form, communicationStyle: e.target.value })}>
							<option value="professional">Professional</option>
							<option value="casual">Casual</option>
							<option value="technical">Technical</option>
							<option value="friendly">Friendly</option>
						</select>
					</label>
					<label>
						Custom Instructions
						<textarea value={form.customInstructions ?? ""} onChange={(e) => setForm({ ...form, customInstructions: e.target.value })} rows={3} placeholder="Additional behavior instructions..." />
					</label>
					<div className="modal-actions">
						<button type="button" onClick={onClose}>Cancel</button>
						<button type="submit" className="btn-primary">{existing ? "Save" : "Create"}</button>
					</div>
				</form>
			</div>
		</div>
	);
}
