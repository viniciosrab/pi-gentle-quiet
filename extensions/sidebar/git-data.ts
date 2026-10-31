// The GIT tab's data, after pi-cinlodev-cute's src/git/git-cli.ts: the same git commands, run through
// host.git (asynchronous, timeout-guarded) and kept in TTL caches like cute's. Parsers are pure functions.
// @ts-nocheck

import type { SidebarHost } from "./tabs.ts";
import { FULL_CONTEXT } from "./diff-preview.ts";

export interface GitFile {
	path: string;
	code: string; // porcelain or name-status code: "M", "??", "R090", ...
	xy?: string; // the two porcelain columns, untrimmed (index, worktree)
	status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";
	added: number;
	deleted: number;
}

export interface GitBranch {
	name: string;
	current: boolean;
	remote: boolean;
	ahead?: number;
	behind?: number;
	gone?: boolean;
	date?: string;
}

const lines = (text = "") => text.replace(/\r\n/g, "\n").split("\n");

// Porcelain quotes paths with spaces or special bytes ("a b.txt"); core.quotePath=false keeps UTF-8 as is.
const unquote = (text) => {
	if (!text.startsWith('"') || !text.endsWith('"')) return text;
	try {
		return JSON.parse(text);
	} catch {
		return text.slice(1, -1);
	}
};

// A rename in --numstat: "old => new" or "dir/{old => new}/file".
const renamedTo = (text) => text.replace(/\{[^{}]* => ([^{}]*)\}/g, "$1").replace(/^.* => /, "").replace(/\/\/+/g, "/");

/** `git diff --numstat` as path -> lines added and deleted ("-" for binary files counts 0). */
export function parseNumstat(output = "") {
	const map = new Map();
	for (const line of lines(output)) {
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		map.set(renamedTo(parts.slice(2).join("\t").trim()), { added: Number.parseInt(parts[0], 10) || 0, deleted: Number.parseInt(parts[1], 10) || 0 });
	}
	return map;
}

/** `git status --porcelain=v1` with `git diff HEAD --numstat`: one entry per changed file. */
export function parseStatus(porcelain = "", numstat = ""): GitFile[] {
	const counts = parseNumstat(numstat);
	const files = [];
	for (const line of lines(porcelain)) {
		if (line.length < 4) continue;
		const x = line[0];
		const y = line[1];
		let rest = line.slice(3);
		const arrow = rest.indexOf(" -> ");
		if ((x === "R" || x === "C") && arrow >= 0) rest = rest.slice(arrow + 4);
		const path = unquote(rest.trim());
		let status = "modified";
		if (x === "?" && y === "?") status = "untracked";
		else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) status = "conflict";
		else if (x === "R" || x === "C") status = "renamed";
		else if (x === "A" || y === "A") status = "added";
		else if (x === "D" || y === "D") status = "deleted";
		const num = counts.get(path) ?? { added: 0, deleted: 0 };
		files.push({ path, code: line.slice(0, 2).trim(), xy: line.slice(0, 2), status, added: num.added, deleted: num.deleted });
	}
	return files;
}

/** Cute's status counts (staged, modified, untracked, conflicts) and the lines added and deleted. */
export function statusCounts(files: GitFile[]) {
	const counts = { staged: 0, modified: 0, untracked: 0, conflicts: 0, added: 0, deleted: 0, clean: true };
	for (const file of files) {
		counts.added += file.added;
		counts.deleted += file.deleted;
		const [x = " ", y = " "] = (file.xy ?? file.code).padEnd(2, " ");
		if (file.status === "untracked") counts.untracked++;
		else if (file.status === "conflict") counts.conflicts++;
		else {
			if (x !== " ") counts.staged++;
			if (y !== " ") counts.modified++;
		}
	}
	counts.clean = counts.staged + counts.modified + counts.untracked + counts.conflicts === 0;
	return counts;
}

/** "2 hours ago" -> "2h", as cute's shortenRelativeTime. */
export const shortDate = (text = "") =>
	text
		.replace(/ minutes? ago/, "m")
		.replace(/ hours? ago/, "h")
		.replace(/ days? ago/, "d")
		.replace(/ weeks? ago/, "w")
		.replace(/ months? ago/, "mo")
		.replace(/ years? ago/, "y")
		.replace(/ seconds? ago/, "s");

/** for-each-ref output: local branches (the current one first), then remote branches with no local one. */
export function parseBranches(output = "", current = ""): GitBranch[] {
	const local = [];
	const remote = [];
	for (const line of lines(output)) {
		const [ref = "", name = "", , track = "", date = ""] = line.split("\t").map((part) => part.trim());
		if (!name || name === "origin" || ref.endsWith("/HEAD") || name.endsWith("/HEAD")) continue;
		if (ref.startsWith("refs/remotes/")) {
			remote.push({ name, current: false, remote: true, date: shortDate(date) });
			continue;
		}
		const ahead = /ahead (\d+)/.exec(track);
		const behind = /behind (\d+)/.exec(track);
		local.push({
			name,
			current: name === current,
			remote: false,
			...(ahead ? { ahead: Number(ahead[1]) } : {}),
			...(behind ? { behind: Number(behind[1]) } : {}),
			gone: track.includes("gone"),
			date: shortDate(date),
		});
	}
	const names = new Set(local.map((branch) => branch.name));
	local.sort((a, b) => Number(b.current) - Number(a.current));
	return [...local, ...remote.filter((branch) => !names.has(branch.name.replace(/^[^/]+\//, "")))];
}

/** A branch diff from `--numstat` and `--name-status`, with its totals. */
export function parseBranchDiff(numstat = "", nameStatus = "") {
	const codes = new Map();
	for (const line of lines(nameStatus)) {
		const parts = line.split("\t");
		if (parts.length >= 2) codes.set(parts.at(-1).trim(), parts[0].trim());
	}
	const files = [];
	let added = 0;
	let deleted = 0;
	for (const [path, num] of parseNumstat(numstat)) {
		const code = codes.get(path) ?? "M";
		const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : code.startsWith("R") ? "renamed" : "modified";
		files.push({ path, code, status, added: num.added, deleted: num.deleted });
		added += num.added;
		deleted += num.deleted;
	}
	return { files, added, deleted };
}

// How long each part stays fresh, in ms (cute: status 2-4 s, branches 3 s, graph 4 s, branch diff 3 s).
const TTL = { repo: 4000, graph: 4000, status: 2000, branches: 3000, diff: 3000 };

/**
 * The tab's git data for a working directory. Every getter returns what is cached (undefined while the first
 * read runs) and starts a read in the background when the cache is stale; a read that changes the data asks
 * for a redraw. host.git answers undefined on any failure (no repository, no git, a timeout).
 */
export function createGitData(host: SidebarHost) {
	const slots = new Map(); // key -> { value, readAt, pending }
	let disposed = false;
	let forced = new Set(); // keys to read again whatever their age (onShow)

	const git = async (args, cwd) => {
		try {
			return await host.git(args, cwd);
		} catch {
			return undefined;
		}
	};

	const get = (key, ttl, read) => {
		let slot = slots.get(key);
		if (!slot) slots.set(key, (slot = { value: undefined, readAt: undefined, pending: undefined }));
		const stale = slot.readAt === undefined || Date.now() - slot.readAt >= ttl || forced.has(key);
		if (stale && !slot.pending) {
			forced.delete(key);
			slot.pending = Promise.resolve()
				.then(read)
				.catch(() => ({ error: true }))
				.then((value) => {
					slot.pending = undefined;
					slot.readAt = Date.now();
					const changed = JSON.stringify(value) !== JSON.stringify(slot.value);
					slot.value = value;
					if (changed && !disposed) host.requestRender();
				});
		}
		return slot.value;
	};

	return {
		/** { ok, root, branch }: the repository's top folder and the branch (the short commit when detached). */
		repo: (cwd) =>
			get(`repo:${cwd}`, TTL.repo, async () => {
				const root = (await git(["rev-parse", "--show-toplevel"], cwd))?.trim();
				if (!root) return { ok: false };
				const branch = (await git(["branch", "--show-current"], cwd))?.trim() || (await git(["rev-parse", "--short", "HEAD"], cwd))?.trim() || "HEAD";
				return { ok: true, root, branch };
			}),
		/** { lines }: `git log --graph --oneline --decorate -n 20`, no lines with no commits. */
		graph: (cwd) =>
			get(`graph:${cwd}`, TTL.graph, async () => {
				const out = await git(["log", "--graph", "--oneline", "--decorate", "--no-color", "-n", "20"], cwd);
				return { lines: lines(out ?? "").filter((line) => line.trim()) };
			}),
		/** { files } or { error }: the working tree's changed files. */
		status: (cwd) =>
			get(`status:${cwd}`, TTL.status, async () => {
				const porcelain = await git(["-c", "core.quotePath=false", "status", "--porcelain=v1"], cwd);
				if (porcelain === undefined) return { error: true };
				const numstat = await git(["-c", "core.quotePath=false", "diff", "HEAD", "--numstat", "--no-renames"], cwd);
				return { files: parseStatus(porcelain, numstat ?? "") };
			}),
		/** { branches }: local and remote-only branches, the current one alone when for-each-ref fails. */
		branches: (cwd, current) =>
			get(`branches:${cwd}:${current}`, TTL.branches, async () => {
				const out = await git(
					["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:relative)", "refs/heads/", "refs/remotes/"],
					cwd,
				);
				return { branches: out === undefined ? [{ name: current, current: true, remote: false }] : parseBranches(out, current) };
			}),
		/** { files, added, deleted, direct }: HEAD...branch, or HEAD branch when that is empty (no merge base). */
		diff: (cwd, current, branch) =>
			get(`diff:${cwd}:${current}:${branch}`, TTL.diff, async () => {
				let numstat = await git(["diff", `HEAD...${branch}`, "--numstat"], cwd);
				let direct = false;
				if (!numstat?.trim()) {
					numstat = await git(["diff", "HEAD", branch, "--numstat"], cwd);
					direct = true;
				}
				const names = await git(direct ? ["diff", "HEAD", branch, "--name-status"] : ["diff", `HEAD...${branch}`, "--name-status"], cwd);
				return { ...parseBranchDiff(numstat ?? "", names ?? ""), direct };
			}),
		/**
		 * One file's `git diff` with the whole file as context, not cached: `range` ["HEAD"] (the default) is its
		 * uncommitted changes, staged and unstaged; ["HEAD...b"] or ["HEAD", "b"] a branch's. Undefined when git fails.
		 */
		fileDiff: (cwd, file, range = ["HEAD"]) =>
			git(["-c", "core.quotePath=false", "diff", ...range, "--no-color", "--no-ext-diff", `-U${FULL_CONTEXT}`, "--", file], cwd),
		/** Read everything again on the next get, whatever its age. */
		refresh() {
			forced = new Set(slots.keys());
		},
		dispose() {
			disposed = true;
		},
	};
}
