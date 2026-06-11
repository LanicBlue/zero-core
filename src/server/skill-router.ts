import { Router } from "express";
import { scanSkills } from "./skill-scanner.js";

export function createSkillRouter(): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		try {
			const skills = scanSkills();
			res.json(skills);
		} catch (e) {
			res.status(500).json({ error: (e as Error).message });
		}
	});

	return router;
}
