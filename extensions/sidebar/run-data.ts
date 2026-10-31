// What the Agents card's ↗ and the subagent popup (./run-popup.ts) read: gentle-pi's presence files. gentle-agents
// publishes each session's active tasks (running, queued, waiting) with their live thread in
// <agent dir>/gentle-agents/presence/<sha256(session id)>.<incarnation>.activity.json, next to a .header.json that
// carries the incarnation's heartbeat. A session start (or /reload) gets a new incarnation, so the header with the
// newest heartbeat names the file to read. gentle-pi writes both atomically (temp file and rename), about every
// 400 ms while something changes; a task that finished leaves the file.
//
// Every function here takes its folder or file, reads synchronously and never throws, so callers (a timer, a
// click) decide when to read; nothing reads while a component renders.
// @ts-nocheck

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

/** The presence folder under Pi's agent dir. */
export function presenceDir(agentDir) {
	return path.join(String(agentDir), "gentle-agents", "presence");
}

/** gentle-pi's name for a session in its presence files: the sha256 hex of the session id. */
export function sessionHash(sessionId) {
	return createHash("sha256").update(String(sessionId)).digest("hex");
}

/**
 * This session's activity file in `dir`: the one of its header with the newest heartbeat whose activity file
 * exists. undefined when the folder, the session or its files are not there.
 */
export function findActivityFile(dir, sessionId, files = fs) {
	if (typeof sessionId !== "string" || !sessionId) return undefined;
	const prefix = `${sessionHash(sessionId)}.`;
	let names;
	try {
		names = files.readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".header.json"));
	} catch {
		return undefined;
	}
	const headers = [];
	for (const name of names) {
		try {
			const header = JSON.parse(files.readFileSync(path.join(dir, name), "utf8"));
			const incarnation = typeof header?.incarnation === "string" ? header.incarnation : name.slice(prefix.length, -".header.json".length);
			headers.push({ incarnation, heartbeat: Number(header?.heartbeat) || 0 });
		} catch {
			// a header being replaced right now: the next look finds it
		}
	}
	headers.sort((a, b) => b.heartbeat - a.heartbeat);
	for (const { incarnation } of headers) {
		const file = path.join(dir, `${prefix}${incarnation}.activity.json`);
		if (files.existsSync(file)) return file;
	}
	return undefined;
}

// Escape sequences and other control characters in a thread would drive the terminal; tabs become spaces.
const sanitize = (text) => String(text).replace(/\t/g, "    ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
const str = (value) => (typeof value === "string" ? sanitize(value) : "");
const time = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function threadItem(item) {
	switch (item?.kind) {
		case "text":
		case "thinking":
		case "note":
			return { kind: item.kind, text: str(item.text) };
		case "tool":
			return { kind: "tool", callId: str(item.callId), name: str(item.name), args: item.args ?? {}, output: str(item.output), running: item.running === true, isError: item.isError === true };
		default:
			return undefined;
	}
}

/**
 * The tasks of an activity file's text: { id, agent, label, status, model, createdAt, startedAt, endedAt,
 * lastActivityAt, thread: { version, dropped, items } } each. undefined when the text is not an activity file.
 */
export function parseActivity(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	const tasks = value?.activity?.tasks;
	if (!Array.isArray(tasks)) return undefined;
	return tasks.flatMap((task) => {
		const summary = task?.summary;
		if (typeof summary?.id !== "string" || !summary.id) return [];
		const items = Array.isArray(task.thread?.items) ? task.thread.items.map(threadItem).filter(Boolean) : [];
		return [{
			id: summary.id,
			agent: str(summary.agent),
			label: str(summary.label),
			status: str(summary.status),
			model: str(summary.model),
			createdAt: time(summary.createdAt) ?? 0,
			startedAt: time(summary.startedAt),
			endedAt: time(summary.endedAt),
			lastActivityAt: time(summary.lastActivityAt),
			thread: { version: Number(task.thread?.version) || 0, dropped: Math.max(0, Number(task.thread?.dropped) || 0), items },
		}];
	});
}

/** Reads an activity file: { tasks, stamp } (stamp changes with the file), or { error } when it cannot. */
export function readActivity(file, files = fs) {
	try {
		const stat = files.statSync(file);
		const tasks = parseActivity(files.readFileSync(file, "utf8"));
		if (!tasks) return { error: "not an activity file" };
		return { tasks, stamp: `${stat.mtimeMs}:${stat.size}` };
	} catch (error) {
		return { error: error?.code ?? error?.message ?? String(error) };
	}
}

// gentle-pi's status glyphs on an Agents row of a task still at work (gentle-quiet draws ◐ as ◔).
const ACTIVE_GLYPHS = { "◐": "running", "◔": "running", "○": "queued", "?": "waiting" };
const LEAD = /^\s*(\S)\s+(.*)$/su;

/** The status an Agents row's glyph shows when the task is still at work, else undefined. */
export function activeRowStatus(text) {
	const match = LEAD.exec(String(text));
	return match ? ACTIVE_GLYPHS[match[1]] : undefined;
}

// `text` is on the row whole, or cut by gentle-pi's clip(): its start and "…".
function shown(row, text) {
	if (!text) return false;
	if (row.includes(text)) return true;
	const chars = [...text];
	for (let length = chars.length - 1; length >= Math.min(4, chars.length - 1); length--) {
		if (row.includes(`${chars.slice(0, length).join("")}…`)) return true;
	}
	return false;
}

const newest = (a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt);

/**
 * The id of the task an Agents row (its plain text) shows, among `tasks` from the activity file: the row's glyph
 * must be a working one of the task's status, its agent must be on the row, and its label too when any task's
 * label is (a narrow card drops the labels). Two tasks alike: the newest. undefined for any other row.
 */
export function rowTask(text, tasks) {
	const status = activeRowStatus(text);
	if (!status || !Array.isArray(tasks)) return undefined;
	const row = LEAD.exec(String(text))[2];
	const working = tasks.filter((task) => task.status === status && shown(row, task.agent));
	const labelled = working.filter((task) => shown(row, task.label));
	return (labelled.length ? labelled : working).sort(newest)[0]?.id;
}

// ---------------------------------------------------------------------------
// Jobs: gentle-pi writes a background job's output to <tmp>/gentle-jobs-XXXX/<id>.log through a stream the Pi process
// holds open while the job runs. The folder is not published, so it is found in /proc/self/fd (Linux only).
// ---------------------------------------------------------------------------

const JOB_LOG = /^(.*\/gentle-jobs-[^/]+)\/([^/]+)\.log$/;

/** Every gentle-pi job log this process holds open: id -> path. Empty off Linux or when /proc cannot be read. */
export function scanJobLogs({ readdir = fs.readdirSync, readlink = fs.readlinkSync, platform = process.platform, dir = "/proc/self/fd" } = {}) {
	const logs = new Map();
	if (platform !== "linux") return logs;
	let entries;
	try {
		entries = readdir(dir);
	} catch {
		return logs;
	}
	for (const fd of entries) {
		let target;
		try {
			target = String(readlink(path.join(dir, String(fd))));
		} catch {
			continue; // closed since the listing, or not ours to read
		}
		const match = JOB_LOG.exec(target);
		if (match) logs.set(match[2], target);
	}
	return logs;
}

/** The log of job `id` among the files this process holds open, matched on the whole id (job-1 is not job-10). */
export function findJobLog(id, options) {
	return scanJobLogs(options).get(String(id));
}

/**
 * Job logs found in /proc and remembered: a job whose stream has closed (it finished) keeps the path seen while it
 * ran, and a job never seen open is looked for in the gentle-jobs folders seen so far.
 */
export class JobLogs {
	constructor(options = {}) {
		this.options = options;
		this.exists = options.exists ?? fs.existsSync;
		this.paths = new Map();
		this.dirs = new Set();
	}

	find(id) {
		const key = String(id);
		for (const [seen, file] of scanJobLogs(this.options)) {
			this.paths.set(seen, file);
			this.dirs.add(path.dirname(file));
		}
		if (this.paths.has(key)) return this.paths.get(key);
		if (key.includes("/")) return undefined;
		for (const dir of this.dirs) {
			const file = path.join(dir, `${key}.log`);
			try {
				if (this.exists(file)) return file;
			} catch {
				// unreadable: the next folder
			}
		}
		return undefined;
	}
}

// A line of a job's output as the pop-up can draw it: no escape sequences (colors, links, cursor moves), a carriage
// return's overwrite kept as its last state, tabs as spaces, no other control characters.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
function logLine(line) {
	const text = line.replace(ESCAPES, "").replace(/\r+$/, "");
	return text.slice(text.lastIndexOf("\r") + 1).replace(/\t/g, "    ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export const TAIL_BYTES = 256 * 1024;

/** The last `maxBytes` of a log as lines: { lines, cut, stamp }, cut when the start was left out; { error } when it cannot. */
export function readTail(file, maxBytes = TAIL_BYTES, files = fs) {
	let fd;
	try {
		fd = files.openSync(file, "r");
		const size = files.fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const buffer = Buffer.alloc(size - start);
		let read = 0;
		while (read < buffer.length) {
			const bytes = files.readSync(fd, buffer, read, buffer.length - read, start + read);
			if (!bytes) break;
			read += bytes;
		}
		const lines = buffer.subarray(0, read).toString("utf8").split("\n");
		if (start > 0) lines.shift(); // the line the cut went through
		if (lines.at(-1) === "") lines.pop();
		return { lines: lines.map(logLine), cut: start > 0, stamp: `${size}` };
	} catch (error) {
		return { error: error?.code ?? error?.message ?? String(error) };
	} finally {
		if (fd !== undefined) {
			try {
				files.closeSync(fd);
			} catch {
				// already closed
			}
		}
	}
}

// The Jobs card marks a running job with gentle-pi's hourglass, which gentle-quiet draws as Pi's Working spinner.
const JOB_RUNNING = new Set(["⧗", "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);

/**
 * The running job each row of the Jobs card (its plain texts) shows, or undefined: a row with the running glyph
 * whose label is a running job's, the newest first, each job on one row only.
 */
export function jobRows(texts, jobs) {
	const running = (Array.isArray(jobs) ? jobs : []).filter((job) => job?.status === undefined && typeof job.id === "string").sort((a, b) => b.startedAt - a.startedAt);
	const used = new Set();
	return texts.map((text) => {
		const match = LEAD.exec(String(text));
		if (!match || !JOB_RUNNING.has(match[1])) return undefined;
		const job = running.find((candidate) => !used.has(candidate.id) && shown(match[2], candidate.label));
		if (!job) return undefined;
		used.add(job.id);
		return job.id;
	});
}
