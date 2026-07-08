// 文件读取辅助工具
//
// # 文件说明书
//
// ## 核心功能
// 提供文件读取的通用辅助函数：二进制检测、大小限制、目录遍历
//
// ## 输入
// 文件路径、扩展名
//
// ## 输出
// 文件大小限制常量、二进制文件检测结果、文件过滤逻辑
//
// ## 定位
// src/runtime/tools/ — 工具层，为 file-read 等工具提供共享辅助
//
// ## 依赖
// Node.js fs/path 模块
//
// ## 维护规则
// 新增二进制扩展名需在 BINARY_EXTENSIONS 集合中添加
//
import { readdir } from "node:fs/promises";
import { resolve, basename, extname, dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_FILE_SIZE = 256 * 1024; // 256 KB

const BINARY_EXTENSIONS = new Set([
	".exe", ".dll", ".so", ".dylib", ".bin", ".obj", ".o", ".a", ".lib",
	".pyc", ".pyo", ".class", ".jar", ".war", ".ear",
	".woff", ".woff2", ".ttf", ".eot", ".otf",
	".ico", ".cur",
	".sqlite", ".db", ".mdb",
	".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
	".mp3", ".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv",
	".iso", ".dmg", ".img",
	".node", ".wasm",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);

const NOTEBOOK_EXTENSIONS = new Set([".ipynb"]);

const PDF_EXTENSIONS = new Set([".pdf"]);

export type FileType = "block" | "image" | "pdf" | "notebook" | "text";

// ---------------------------------------------------------------------------
// File type detection
// ---------------------------------------------------------------------------

export function detectFileType(filePath: string): FileType {
	const ext = extname(filePath).toLowerCase();
	if (BINARY_EXTENSIONS.has(ext)) return "block";
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	if (PDF_EXTENSIONS.has(ext)) return "pdf";
	if (NOTEBOOK_EXTENSIONS.has(ext)) return "notebook";
	return "text";
}

// ---------------------------------------------------------------------------
// Encoding detection & decoding
// ---------------------------------------------------------------------------

export function decodeBuffer(buffer: Buffer): string {
	if (buffer.length === 0) return "";

	// UTF-16LE BOM: FF FE
	if (buffer[0] === 0xff && buffer[1] === 0xfe) {
		const text = new (globalThis as any).TextDecoder("utf-16le").decode(buffer.slice(2));
		return normalizeLineEndings(text);
	}
	// UTF-16BE BOM: FE FF
	if (buffer[0] === 0xfe && buffer[1] === 0xff) {
		const text = new (globalThis as any).TextDecoder("utf-16be").decode(buffer.slice(2));
		return normalizeLineEndings(text);
	}
	// UTF-8 BOM: EF BB BF — skip it
	const start = (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) ? 3 : 0;
	const text = buffer.toString("utf-8", start);
	return normalizeLineEndings(text);
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

// ---------------------------------------------------------------------------
// Image description
// ---------------------------------------------------------------------------

export function formatImageInfo(filePath: string, size: number): string {
	const ext = extname(filePath).toLowerCase().slice(1);
	const mediaType = ext === "jpg" ? "jpeg" : ext;
	const name = basename(filePath);
	return `[Image: ${name} (${formatBytes(size)}, image/${mediaType})]\nThis model cannot view images. If you need to understand the image content, describe what you need to know.`;
}

// ---------------------------------------------------------------------------
// PDF text extraction
// ---------------------------------------------------------------------------

export async function extractPdfText(filePath: string, size: number, pages?: string): Promise<string> {
	const name = basename(filePath);

	// Try pdf-parse (optional dependency)
	try {
		const { readFile } = await import("node:fs/promises");
		const pdfMod: any = await import("pdf-parse");
		const buffer = await readFile(filePath);
		const parser = pdfMod.default && typeof pdfMod.default === "function"
			? pdfMod.default
			: (buf: Buffer) => new pdfMod.PDFParse({ verbosity: 0 }).getRawTextContent(buf);
		const data = await parser(buffer);
		const text = data.text ?? String(data);
		if (!text.trim()) {
			return `[PDF: ${name} (${formatBytes(size)}) — no extractable text. This model cannot view PDF content directly.]`;
		}
		return `[PDF: ${name} (${formatBytes(size)})]\n${text}`;
	} catch {
		return `[PDF: ${name} (${formatBytes(size)}) — PDF text extraction unavailable. This model cannot view PDF content directly.]`;
	}
}

// ---------------------------------------------------------------------------
// Jupyter Notebook parsing
// ---------------------------------------------------------------------------

export function parseJupyterNotebook(raw: string, filePath: string, pages?: string): string {
	try {
		const nb = JSON.parse(raw);
		if (!nb.cells || !Array.isArray(nb.cells)) {
			return `[Notebook: ${basename(filePath)} — invalid format]`;
		}

		let cells = nb.cells;
		if (pages) {
			const range = parsePageRange(pages, cells.length);
			cells = cells.slice(range.start, range.end);
		}

		const parts: string[] = [`[Notebook: ${basename(filePath)} — ${nb.cells.length} cells]`, ""];

		cells.forEach((cell: any, idx: number) => {
			const cellNum = pages ? idx + 1 : (nb.cells.indexOf(cell) + 1);
			const type = cell.cell_type ?? "code";
			const source = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");

			parts.push(`--- Cell ${cellNum} (${type}) ---`);
			parts.push(source);

			if (cell.outputs && cell.outputs.length > 0) {
				for (const out of cell.outputs) {
					if (out.text) {
						const text = Array.isArray(out.text) ? out.text.join("") : out.text;
						parts.push(`[Output] ${text}`);
					} else if (out.data?.["text/plain"]) {
						const text = Array.isArray(out.data["text/plain"])
							? out.data["text/plain"].join("")
							: out.data["text/plain"];
						parts.push(`[Output] ${text}`);
					} else if (out.data?.["image/png"]) {
						parts.push("[Output: image — cannot display]");
					} else if (out.traceback) {
						parts.push(`[Error] ${out.traceback.join("\n")}`);
					}
				}
			}
			parts.push("");
		});

		return parts.join("\n");
	} catch {
		return `[Notebook: ${basename(filePath)} — failed to parse]`;
	}
}

function parsePageRange(pages: string, total: number): { start: number; end: number } {
	const m = pages.match(/^(\d+)(?:-(\d+))?$/);
	if (!m) return { start: 0, end: total };
	const start = Math.max(0, parseInt(m[1], 10) - 1);
	const end = m[2] ? Math.min(total, parseInt(m[2], 10)) : start + 1;
	return { start, end };
}

// ---------------------------------------------------------------------------
// Similar file suggestions (ENOENT helper)
// ---------------------------------------------------------------------------

export async function suggestSimilarFiles(failedPath: string, workingDir?: string): Promise<string> {
	try {
		const dir = dirname(failedPath);
		const target = basename(failedPath);
		const baseName = target.replace(/\.[^.]+$/, "").toLowerCase();

		const entries = await readdir(resolve(workingDir ?? ".", dir));
		const scored = entries
			.map(name => ({ name, score: similarity(baseName, name.replace(/\.[^.]+$/, "").toLowerCase()) }))
			.filter(e => e.score > 0.3)
			.sort((a, b) => b.score - a.score)
			.slice(0, 3);

		if (scored.length === 0) return "";
		return "Did you mean:\n" + scored.map(e => `  - ${join(dir, e.name)}`).join("\n");
	} catch {
		return "";
	}
}

function similarity(a: string, b: string): number {
	if (a === b) return 1;
	if (!a || !b) return 0;
	const maxLen = Math.max(a.length, b.length);
	let matches = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] === b[i]) matches++;
	}
	return matches / maxLen;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
