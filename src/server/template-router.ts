import { Router } from "express";
import type { TemplateStore } from "./template-store.js";

export function createTemplateRouter(templateStore: TemplateStore): Router {
	const router = Router();

	// templates:list — list all templates
	router.get("/", (_req, res) => {
		try {
			res.json(templateStore.list());
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// templates:get — get a single template
	router.get("/:id", (req, res) => {
		try {
			const template = templateStore.get(req.params.id);
			if (!template) {
				res.status(404).json({ error: "Template not found" });
				return;
			}
			res.json(template);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	// templates:create — create a new template
	router.post("/", (req, res) => {
		try {
			const template = templateStore.create(req.body);
			res.status(201).json(template);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// templates:update — update an existing template
	router.put("/:id", (req, res) => {
		try {
			const template = templateStore.update(req.params.id, req.body);
			res.json(template);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// templates:delete — delete a template
	router.delete("/:id", (req, res) => {
		try {
			templateStore.delete(req.params.id);
			res.json({ ok: true });
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// templates:export — export a template as JSON string
	router.post("/:id/export", (req, res) => {
		try {
			const json = templateStore.exportTemplate(req.params.id);
			res.json({ json });
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	// templates:import — import a template from JSON string
	router.post("/import", (req, res) => {
		try {
			const { json } = req.body;
			if (!json || typeof json !== "string") {
				res.status(400).json({ error: "Request body must include a 'json' string field" });
				return;
			}
			const template = templateStore.importTemplate(json);
			res.status(201).json(template);
		} catch (e) {
			res.status(400).json({ error: (e as Error).message });
		}
	});

	return router;
}
