import { readFileSync, statSync } from "node:fs";
import { extname, basename } from "node:path";
import type { KbDB } from "./kb-db.js";
import type { EmbeddingProvider } from "./kb-embeddings.js";

// ---------------------------------------------------------------------------
// Ingest pipeline — read file → split into chunks → embed → store
// ---------------------------------------------------------------------------

export interface IngestProgress {
	filePath: string;
	totalChunks: number;
	processedChunks: number;
	status: "reading" | "chunking" | "embedding" | "storing" | "done" | "error";
	error?: string;
}

const CHUNK_SIZE = 800; // tokens approximation: ~4 chars per token
const CHUNK_OVERLAP = 200;
const EMBED_BATCH_SIZE = 20;

export async function ingestFile(
	kbId: string,
	filePath: string,
	kbDb: KbDB,
	embedder: EmbeddingProvider,
	onProgress?: (progress: IngestProgress) => void,
): Promise<{ chunks: number; error?: string }> {
	try {
		// Read file content
		onProgress?.({ filePath, totalChunks: 0, processedChunks: 0, status: "reading" });

		const ext = extname(filePath).toLowerCase();
		let text: string;

		if (ext === ".pdf") {
			text = await extractPdfText(filePath);
		} else {
			text = readFileSync(filePath, "utf-8");
		}

		if (!text.trim()) {
			return { chunks: 0 };
		}

		// Chunk
		onProgress?.({ filePath, totalChunks: 0, processedChunks: 0, status: "chunking" });
		const chunks = splitIntoChunks(text, CHUNK_SIZE, CHUNK_OVERLAP);

		if (chunks.length === 0) {
			return { chunks: 0 };
		}

		// Delete old chunks for this file
		kbDb.deleteFileChunks(kbId, filePath);

		// Embed in batches
		onProgress?.({ filePath, totalChunks: chunks.length, processedChunks: 0, status: "embedding" });

		const allEmbeddings: (Float32Array | null)[] = [];
		for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
			const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
			try {
				const batchEmbeddings = await embedder.embed(batch);
				allEmbeddings.push(...batchEmbeddings);
			} catch (err) {
				// If embedding fails, store without embeddings (still searchable by keyword)
				for (let j = 0; j < batch.length; j++) {
					allEmbeddings.push(null);
				}
			}
			onProgress?.({
				filePath,
				totalChunks: chunks.length,
				processedChunks: Math.min(i + EMBED_BATCH_SIZE, chunks.length),
				status: "embedding",
			});
		}

		// Store chunks
		onProgress?.({ filePath, totalChunks: chunks.length, processedChunks: chunks.length, status: "storing" });

		const chunkData = chunks.map((content, idx) => ({
			kbId,
			filePath,
			chunkIndex: idx,
			content,
			embedding: allEmbeddings[idx] ?? null,
			tokenCount: Math.ceil(content.length / 4),
		}));

		kbDb.insertChunksBatch(chunkData);

		onProgress?.({ filePath, totalChunks: chunks.length, processedChunks: chunks.length, status: "done" });

		return { chunks: chunks.length };
	} catch (err) {
		onProgress?.({ filePath, totalChunks: 0, processedChunks: 0, status: "error", error: (err as Error).message });
		return { chunks: 0, error: (err as Error).message };
	}
}

export function removeFile(kbId: string, filePath: string, kbDb: KbDB): void {
	kbDb.deleteFileChunks(kbId, filePath);
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

async function extractPdfText(filePath: string): Promise<string> {
	try {
		const pdfMod: any = await import("pdf-parse");
		const buffer = readFileSync(filePath);
		if (pdfMod.default && typeof pdfMod.default === "function") {
			const data = await pdfMod.default(buffer);
			return data.text ?? String(data);
		}
		const parser = new pdfMod.PDFParse({ verbosity: 0 });
		const raw: any = await parser.getRawTextContent(buffer);
		return String(raw);
	} catch {
		return `[PDF text extraction failed for ${filePath}]`;
	}
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function splitIntoChunks(text: string, chunkSize: number, overlap: number): string[] {
	// Split by paragraphs first, then merge into chunks
	const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
	if (paragraphs.length === 0) return [];

	const chunks: string[] = [];
	let current = "";

	for (const para of paragraphs) {
		if ((current + "\n\n" + para).length > chunkSize && current.length > 0) {
			chunks.push(current.trim());
			// Keep overlap from end of current chunk
			const lastPart = current.slice(-overlap);
			current = lastPart + "\n\n" + para;
		} else {
			current = current ? current + "\n\n" + para : para;
		}
	}

	if (current.trim()) {
		chunks.push(current.trim());
	}

	// If a single paragraph is very long, split it further
	const result: string[] = [];
	for (const chunk of chunks) {
		if (chunk.length > chunkSize * 2) {
			const lines = chunk.split("\n");
			let sub = "";
			for (const line of lines) {
				if ((sub + "\n" + line).length > chunkSize && sub.length > 0) {
					result.push(sub.trim());
					sub = sub.slice(-overlap) + "\n" + line;
				} else {
					sub = sub ? sub + "\n" + line : line;
				}
			}
			if (sub.trim()) result.push(sub.trim());
		} else {
			result.push(chunk);
		}
	}

	return result;
}
