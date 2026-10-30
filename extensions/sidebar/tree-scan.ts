// The TREE tab's data, after pi-cinlodev-cute's src/tree/tree-scanner.ts: the project folder read with
// fs/promises (folders first, build and dependency folders left out, five levels deep, only the open
// folders read below the first level), the rows it draws with their "├── " guides, and git's
// `status --porcelain=v1` mapped onto it.
// @ts-nocheck

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface TreeNode {
	name: string;
	relPath: string;
	absPath: string;
	isDirectory: boolean;
	children?: TreeNode[];
	itemCount?: number;
	extension?: string;
}

export interface TreeRow {
	node: TreeNode;
	prefix: string;
	depth: number;
}

export const IGNORED_NAMES = new Set([".git", "node_modules", "dist", ".cache", ".next", "coverage", ".turbo", "build"]);
export const MAX_DEPTH = 5;

/**
 * The folder at `root`, folders first then files, each sorted by name. A folder's children are read when it
 * is in `expanded` (every folder when `expanded` is undefined) and sits less than `maxDepth` levels down;
 * otherwise only its items are counted. An unreadable `root` rejects; an unreadable subfolder is empty.
 */
export async function scanTree(root, expanded?, maxDepth = MAX_DEPTH) {
	return scanDir(root, root, expanded, maxDepth, 0);
}

async function scanDir(dir, root, expanded, maxDepth, depth) {
	const entries = await readdir(dir, { withFileTypes: true });
	const nodes = await Promise.all(
		entries
			.filter((entry) => !IGNORED_NAMES.has(entry.name))
			.map(async (entry) => {
				const absPath = path.join(dir, entry.name);
				const relPath = path.relative(root, absPath);
				if (!entry.isDirectory()) {
					return { name: entry.name, relPath, absPath, isDirectory: false, extension: path.extname(entry.name).toLowerCase().replace(/^\./, "") };
				}
				const node = { name: entry.name, relPath, absPath, isDirectory: true, itemCount: 0 };
				if (depth < maxDepth && (!expanded || expanded.has(relPath))) {
					node.children = await scanDir(absPath, root, expanded, maxDepth, depth + 1).catch(() => []);
					node.itemCount = node.children.length;
				} else {
					node.itemCount = await readdir(absPath).then((names) => names.filter((name) => !IGNORED_NAMES.has(name)).length, () => 0);
				}
				return node;
			}),
	);
	const byName = (a, b) => a.name.localeCompare(b.name);
	return [...nodes.filter((node) => node.isDirectory).sort(byName), ...nodes.filter((node) => !node.isDirectory).sort(byName)];
}

/** The rows of the open part of the tree, top to bottom, with their guides. */
export function flattenTree(nodes, expanded, parentPrefix = "", depth = 0) {
	const rows = [];
	nodes.forEach((node, index) => {
		const last = index === nodes.length - 1;
		rows.push({ node, prefix: `${parentPrefix}${last ? "└── " : "├── "}`, depth });
		if (node.isDirectory && expanded.has(node.relPath) && node.children?.length) {
			rows.push(...flattenTree(node.children, expanded, `${parentPrefix}${last ? "    " : "│   "}`, depth + 1));
		}
	});
	return rows;
}

/** Every folder's relative path in `nodes`, into `into`. */
export function collectDirs(nodes, into = new Set()) {
	for (const node of nodes) {
		if (!node.isDirectory) continue;
		into.add(node.relPath);
		if (node.children) collectDirs(node.children, into);
	}
	return into;
}

// A path as git prints it: "quoted" with C escapes when it holds spaces, quotes or non-ASCII bytes.
function unquote(text) {
	if (!text.startsWith('"') || !text.endsWith('"')) return text;
	const bytes = [];
	const body = text.slice(1, -1);
	const named = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, "\\": 92 };
	for (let i = 0; i < body.length; i++) {
		if (body[i] !== "\\") {
			bytes.push(...Buffer.from(body[i]));
			continue;
		}
		const octal = body.slice(i + 1, i + 4);
		if (/^[0-7]{3}$/.test(octal)) {
			bytes.push(parseInt(octal, 8));
			i += 3;
		} else {
			bytes.push(named[body[i + 1]] ?? body.charCodeAt(i + 1));
			i += 1;
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

const KIND = (code) => {
	if (code === "??") return "untracked";
	if (code.includes("U") || code === "AA" || code === "DD") return "conflict";
	if (code.includes("A")) return "added";
	if (code.includes("D")) return "deleted";
	return "modified";
};

/**
 * `git status --porcelain=v1` (paths from the repository's root) seen from the session's folder, `prefix`
 * being `git rev-parse --show-prefix` there: status(relPath) is a file's change ("modified", "added",
 * "untracked", "conflict", "deleted") and dirty(relPath) whether a folder holds one. An untracked folder
 * ("?? dir/") marks everything under it untracked. Changes outside the session's folder are left out.
 */
export function parseGitStatus(output, prefix = "") {
	const files = new Map();
	const untrackedDirs = [];
	const dirty = new Set();
	for (const line of String(output ?? "").split("\n")) {
		if (line.length < 4) continue;
		const code = line.slice(0, 2);
		const rest = line.slice(3);
		const arrow = rest.lastIndexOf(" -> ");
		const full = unquote(arrow >= 0 && /^[RC]/.test(code) ? rest.slice(arrow + 4) : rest);
		if (prefix && !full.startsWith(prefix)) continue;
		const rel = full.slice(prefix.length);
		if (!rel) continue;
		const kind = KIND(code);
		if (rel.endsWith("/")) {
			const dir = rel.slice(0, -1);
			untrackedDirs.push(`${dir}/`);
			dirty.add(dir);
		} else files.set(rel, kind);
		for (let parent = path.dirname(rel.replace(/\/$/, "")); parent && parent !== "." && parent !== "/"; parent = path.dirname(parent)) dirty.add(parent);
	}
	return {
		size: files.size + untrackedDirs.length,
		status: (rel) => files.get(rel) ?? (untrackedDirs.some((dir) => rel.startsWith(dir)) ? "untracked" : undefined),
		dirty: (rel) => dirty.has(rel) || untrackedDirs.some((dir) => `${rel}/`.startsWith(dir)),
	};
}

const projectField = async (file, field) => {
	try {
		const value = JSON.parse(await readFile(file, "utf8"))?.[field];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	} catch {
		return undefined;
	}
};

/** cute's project name: Engram's project identity, then .engram/config.json, then package.json, then the folder's name. */
export async function projectName(cwd) {
	return (
		(await projectField(path.join(cwd, ".git", "engram-project-identity.json"), "project")) ??
		(await projectField(path.join(cwd, ".engram", "config.json"), "project")) ??
		(await projectField(path.join(cwd, "package.json"), "name")) ??
		(path.basename(cwd) || "project")
	);
}
