// 知识库向量搜索
//
// # 文件说明书
//
// ## 核心功能
// 将查询文本向量化后与知识库中的分块进行余弦相似度搜索
//
// ## 输入
// 查询文本、KbDB、EmbeddingProvider、top-K 参数
//
// ## 输出
// SearchResult 数组（包含分块 ID、文件路径、相似度分数）
//
// ## 定位
// src/server/ — 服务层，为 kb-router 提供语义搜索能力
//
// ## 依赖
// kb-db.ts、kb-embeddings.ts
//
// ## 维护规则
// 搜索算法变更需确保排序一致性
//
import type { KbDB } from "./kb-db.js";
import type { EmbeddingProvider } from "./kb-embeddings.js";

// ---------------------------------------------------------------------------
// Search — embed query → cosine similarity → top-K results
// ---------------------------------------------------------------------------

export interface SearchResult {
	chunkId: number;
	filePath: string;
	content: string;
	score: number;
}

export async function search(
	kbIds: string[],
	query: string,
	embedder: EmbeddingProvider,
	kbDb: KbDB,
	topK: number = 5,
): Promise<SearchResult[]> {
	if (!query.trim() || kbIds.length === 0) return [];

	// Embed the query
	const [queryEmbedding] = await embedder.embed([query]);
	if (!queryEmbedding) return [];

	const allResults: SearchResult[] = [];

	for (const kbId of kbIds) {
		const chunks = kbDb.getAllChunksForSearch(kbId);

		for (const chunk of chunks) {
			if (!chunk.embedding) continue;

			const emb = new Float32Array(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength / 4);
			const score = cosineSimilarity(queryEmbedding, emb);

			allResults.push({
				chunkId: chunk.id,
				filePath: chunk.file_path,
				content: chunk.content,
				score,
			});
		}
	}

	// Sort by score descending, take top K
	allResults.sort((a, b) => b.score - a.score);
	return allResults.slice(0, topK);
}

export function formatSearchResults(results: SearchResult[]): string {
	if (results.length === 0) return "";

	const lines: string[] = ["## Retrieved Knowledge", ""];

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const fileName = r.filePath.split(/[/\\]/).pop() ?? r.filePath;
		lines.push(`[${i + 1}] Source: ${fileName} (relevance: ${(r.score * 100).toFixed(0)}%)`);
		lines.push(r.content);
		lines.push("");
	}

	lines.push("When referencing this knowledge, cite sources using [N] notation.");
	return lines.join("\n");
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) return 0;

	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}
