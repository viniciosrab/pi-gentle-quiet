// TREE's memory (./tree.ts): the folders open in each project, so the tree opens again as it was left. Kept in
// <Pi agent dir>/gentle-quiet-tree.json as { "<project folder>": { "expanded": ["src", "src/lib"], "at": <ms> } },
// the newest MAX_PROJECTS projects only. A save reads the file again right before it writes, so another Pi window's
// projects stay, and writes it atomically (a temp file in the same folder, then rename). A missing, unreadable or
// broken file is no memory: the tree keeps its default; a failed save is dropped.
// @ts-nocheck

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_PROJECTS = 200;

/** Where the memory is; tests point it elsewhere through the host's agentDir. */
export const memoryFile = (agentDir) => path.join(String(agentDir), "gentle-quiet-tree.json");

async function readAll(agentDir) {
	try {
		const data = JSON.parse(await readFile(memoryFile(agentDir), "utf8"));
		return data && typeof data === "object" && !Array.isArray(data) ? data : {};
	} catch {
		return {};
	}
}

/** The folders saved open for `cwd`, or undefined when the project has none saved. */
export async function loadExpanded(agentDir, cwd) {
	const entry = (await readAll(agentDir))[cwd];
	if (!Array.isArray(entry?.expanded)) return undefined;
	return new Set(entry.expanded.filter((relPath) => typeof relPath === "string"));
}

// One save at a time, so a quick run of clicks writes in order.
let queue = Promise.resolve();

/** Saves the folders open in `cwd`; never throws. */
export function saveExpanded(agentDir, cwd, expanded) {
	const folders = [...expanded].sort();
	queue = queue.then(async () => {
		const all = await readAll(agentDir);
		all[cwd] = { expanded: folders, at: Date.now() };
		const kept = Object.entries(all)
			.filter(([, entry]) => Array.isArray(entry?.expanded))
			.sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0))
			.slice(0, MAX_PROJECTS);
		const file = memoryFile(agentDir);
		const tmp = `${file}.${process.pid}.tmp`;
		await writeFile(tmp, `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`);
		await rename(tmp, file);
	}).catch(() => undefined);
	return queue;
}
