// 文件系统工具函数
//
// # 文件说明书
//
// ## 核心功能
// 提供文件过滤、目录遍历和文件树构建的共享工具函数
//
// ## 输入
// 目录路径、忽略规则、文件扩展名
//
// ## 输出
// IGNORED_DIRS/TEXT_EXTS 常量、buildTree 目录树函数
//
// ## 定位
// src/shared/ — 共享层，为主进程和渲染器提供文件系统工具
//
// ## 依赖
// Node.js fs/path
//
// ## 维护规则
// 新增忽略目录或文本扩展名需在此添加
//
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".cache"]);

export const TEXT_EXTS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".html",
	".yaml", ".yml", ".toml", ".py", ".rs", ".go", ".java", ".txt",
	".sh", ".bash", ".env", ".gitignore", ".sql",
]);

export interface FileTreeNode {
	name: string;
	path: string;
	type: "dir" | "file";
	children?: FileTreeNode[];
}

export function buildTree(dir: string, basePath: string): FileTreeNode[] {
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		return entries
			.filter((e) => !e.name.startsWith(".") && !IGNORED_DIRS.has(e.name))
			.sort((a, b) => {
				if (a.isDirectory() && !b.isDirectory()) return -1;
				if (!a.isDirectory() && b.isDirectory()) return 1;
				return a.name.localeCompare(b.name);
			})
			.map((e) => {
				const fullPath = join(dir, e.name);
				const relPath = join(basePath, e.name);
				if (e.isDirectory()) {
					return {
						name: e.name,
						path: relPath,
						type: "dir",
						children: buildTree(fullPath, relPath),
					};
				}
				return { name: e.name, path: relPath, type: "file" };
			});
	} catch {
		return [];
	}
}
