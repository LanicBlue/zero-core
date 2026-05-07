#!/usr/bin/env node
import { startServer } from "./server/index.js";

startServer().catch((err) => {
	console.error("Failed to start server:", err);
	process.exit(1);
});
