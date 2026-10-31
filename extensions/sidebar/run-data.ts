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

// ---------------------------------------------------------------------------
// A subagent's own session (S16): gentle-agents runs each subagent as a Pi session written to
// <agent dir>/gentle-agents/sessions/<time>_<uuid>.jsonl, one JSON entry per line, with every tool call's arguments
// and result. A finished task's record, <agent dir>/gentle-agents/tasks/<id>.json, names its file (task.sessionPath);
// a running task has no record yet, so its file is the one that holds one of the tool call ids its presence thread
// shows (several subagents can start in the same second, so the file's name cannot tell them apart).
// ---------------------------------------------------------------------------

/** The child sessions' folder under Pi's agent dir. */
export function sessionsDir(agentDir) {
	return path.join(String(agentDir), "gentle-agents", "sessions");
}

/** The finished tasks' records under Pi's agent dir. */
export function tasksDir(agentDir) {
	return path.join(String(agentDir), "gentle-agents", "tasks");
}

const SAFE_ID = /^[\w.-]+$/;

// A record's task as the popup and the Agents card use it; its thread is drawn when its session cannot be.
function taskOf(value) {
	const task = value?.task;
	if (typeof task?.id !== "string" || !task.id) return undefined;
	return {
		id: task.id,
		agent: str(task.agent),
		label: str(task.label),
		status: str(task.status),
		model: str(task.model),
		parentSessionId: typeof task.parentSessionId === "string" ? task.parentSessionId : "",
		sessionPath: typeof task.sessionPath === "string" ? task.sessionPath : null,
		createdAt: time(task.createdAt) ?? 0,
		startedAt: time(task.startedAt),
		endedAt: time(task.endedAt),
		tokens: Number(task.tokens) || 0,
		cost: Number(task.cost) || 0,
	};
}

/** Task `id`'s record in the tasks folder `dir`, or undefined when there is none or it cannot be read. */
export function readTaskRecord(dir, id, files = fs) {
	if (typeof id !== "string" || !SAFE_ID.test(id) || id.startsWith(".")) return undefined;
	try {
		return taskOf(JSON.parse(files.readFileSync(path.join(dir, `${id}.json`), "utf8")));
	} catch {
		return undefined;
	}
}

/** A record's session file when it is a .jsonl inside the sessions folder `sessions` and exists; else undefined. */
export function recordSessionPath(record, sessions, files = fs) {
	const file = record?.sessionPath;
	if (typeof file !== "string" || !file.endsWith(".jsonl")) return undefined;
	const full = path.resolve(file);
	if (path.dirname(full) !== path.resolve(sessions)) return undefined;
	try {
		return files.existsSync(full) ? full : undefined;
	} catch {
		return undefined;
	}
}

/** Session files written in the margin before a task's creation still count: the child starts right after it. */
export const SESSION_MARGIN_MS = 10_000;
const SCAN_CHUNK = 1024 * 1024;

// Whether `file` holds any of `needles`, read a chunk at a time with an overlap so a needle split between two
// chunks is still found.
function holdsAny(file, needles, files) {
	const longest = Math.max(...needles.map((needle) => Buffer.byteLength(needle)));
	let fd;
	try {
		fd = files.openSync(file, "r");
		const buffer = Buffer.alloc(SCAN_CHUNK + longest);
		// Needles are ASCII JSON, so latin1 decoding finds them without splitting a UTF-8 character.
		let carried = 0;
		let position = 0;
		for (;;) {
			const bytes = files.readSync(fd, buffer, carried, SCAN_CHUNK, position);
			if (!bytes) return false;
			position += bytes;
			const total = carried + bytes;
			const text = buffer.toString("latin1", 0, total);
			if (needles.some((needle) => text.includes(needle))) return true;
			// The last bytes, too few to hold a whole needle, start the next chunk.
			carried = Math.min(longest - 1, total);
			buffer.copy(buffer, 0, total - carried, total);
		}
	} catch {
		return false;
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

/**
 * The session file in `sessions` that holds one of `callIds` as a tool call's id, among the .jsonl files modified at
 * or after `since` (less SESSION_MARGIN_MS), the newest first. Exactly one such file is the answer; none or more
 * than one give undefined.
 */
export function findSessionByCalls(sessions, callIds, since, files = fs) {
	const ids = [...new Set((Array.isArray(callIds) ? callIds : []).filter((id) => typeof id === "string" && id))];
	if (!ids.length) return undefined;
	let names;
	try {
		names = files.readdirSync(sessions).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return undefined;
	}
	const from = (Number(since) || 0) - SESSION_MARGIN_MS;
	const recent = [];
	for (const name of names) {
		const file = path.join(sessions, name);
		try {
			const mtime = files.statSync(file).mtimeMs;
			if (mtime >= from) recent.push({ file, mtime });
		} catch {
			// gone since the listing
		}
	}
	recent.sort((a, b) => b.mtime - a.mtime);
	// Pi writes entries with JSON.stringify: a call is {"type":"toolCall","id":"…"}; a result's "toolCallId" is not it.
	const needles = ids.map((id) => `"id":${JSON.stringify(id)}`);
	const found = recent.filter(({ file }) => holdsAny(file, needles, files));
	return found.length === 1 ? found[0].file : undefined;
}

/**
 * Finds a task's session file and remembers it by task id: the task's record first (once it finished), else its
 * presence thread's tool call ids, searched again only when the thread shows ids not searched before.
 */
export class SessionFinder {
	constructor({ agentDir, sessions, tasks, files = fs } = {}) {
		this.sessions = sessions ?? sessionsDir(agentDir);
		this.tasks = tasks ?? tasksDir(agentDir);
		this.files = files;
		this.paths = new Map();
		this.searched = new Map(); // task id -> the call ids last searched for
	}

	find(task) {
		const id = task?.id;
		if (typeof id !== "string" || !id) return undefined;
		if (this.paths.has(id)) return this.paths.get(id);
		const recorded = recordSessionPath(readTaskRecord(this.tasks, id, this.files), this.sessions, this.files);
		if (recorded) return this.remember(id, recorded);
		const items = Array.isArray(task.thread?.items) ? task.thread.items : [];
		const ids = items.filter((item) => item?.kind === "tool" && typeof item.callId === "string" && item.callId).map((item) => item.callId);
		const seen = this.searched.get(id);
		if (!ids.length || (seen && ids.every((callId) => seen.has(callId)))) return undefined;
		this.searched.set(id, new Set(ids));
		const file = findSessionByCalls(this.sessions, ids, task.createdAt, this.files);
		return file ? this.remember(id, file) : undefined;
	}

	/** Task `id`'s record, once its task finished. */
	record(id) {
		return readTaskRecord(this.tasks, id, this.files);
	}

	remember(id, file) {
		this.paths.set(id, file);
		this.searched.delete(id);
		return file;
	}
}

/** How much of a session file one read takes at most: a long session fills the pop-up over a few polls. */
export const SESSION_CHUNK = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * Reads a session file's new lines on each read(): only the bytes appended since the last one, at most `chunk`; a
 * last line not yet ended waits for its end. A file shorter than what was read starts over from its first byte
 * ({ reset: true }). Lines that are not JSON are skipped. { error } when the file cannot be read.
 */
export class SessionTail {
	constructor(file, { files = fs, chunk = SESSION_CHUNK } = {}) {
		Object.assign(this, { file, files, chunk });
		this.offset = 0; // bytes consumed, the partial line included
		this.partial = Buffer.alloc(0);
	}

	read() {
		let fd;
		try {
			const size = this.files.statSync(this.file).size;
			let reset = false;
			if (size < this.offset) {
				this.offset = 0;
				this.partial = Buffer.alloc(0);
				reset = true;
			}
			if (size === this.offset) return { entries: [], reset };
			fd = this.files.openSync(this.file, "r");
			const buffer = Buffer.alloc(Math.min(this.chunk, size - this.offset));
			let read = 0;
			while (read < buffer.length) {
				const bytes = this.files.readSync(fd, buffer, read, buffer.length - read, this.offset + read);
				if (!bytes) break;
				read += bytes;
			}
			this.offset += read;
			const data = this.partial.length ? Buffer.concat([this.partial, buffer.subarray(0, read)]) : buffer.subarray(0, read);
			const end = data.lastIndexOf(NEWLINE);
			this.partial = Buffer.from(end < 0 ? data : data.subarray(end + 1));
			const entries = [];
			if (end >= 0) {
				for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
					if (!line.trim()) continue;
					try {
						entries.push(JSON.parse(line));
					} catch {
						// not an entry: skipped
					}
				}
			}
			return { entries, reset };
		} catch (error) {
			return { error: error?.code ?? error?.message ?? String(error) };
		} finally {
			if (fd !== undefined) {
				try {
					this.files.closeSync(fd);
				} catch {
					// already closed
				}
			}
		}
	}
}

const textParts = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => str(part.text)).join("\n") : "");

/**
 * A subagent's session as the pop-up draws it, kept up to date by poll(): its items in order,
 * { kind: "user" | "thinking" | "text", text } and { kind: "tool", id, name, args, result, isError, durationMs }, a
 * tool's result (Pi's { content, details }) undefined until its toolResult arrives. `version` grows with each change.
 */
export class SessionLog {
	constructor(file, options = {}) {
		this.tail = new SessionTail(file, options);
		this.items = [];
		this.tools = new Map();
		this.version = 0;
		this.error = undefined;
	}

	/** Reads what was appended; true when the items changed. */
	poll() {
		const read = this.tail.read();
		if (read.error) {
			this.error = read.error;
			return false;
		}
		this.error = undefined;
		let changed = false;
		if (read.reset) {
			this.items = [];
			this.tools = new Map();
			changed = true;
		}
		for (const entry of read.entries) changed = this.add(entry) || changed;
		if (changed) this.version++;
		return changed;
	}

	add(entry) {
		const message = entry?.type === "message" ? entry.message : undefined;
		switch (message?.role) {
			case "user": {
				const text = textParts(message.content);
				if (!text) return false;
				this.items.push({ kind: "user", text });
				return true;
			}
			case "assistant": {
				const before = this.items.length;
				for (const part of Array.isArray(message.content) ? message.content : []) {
					if (part?.type === "thinking" && str(part.thinking).trim()) this.items.push({ kind: "thinking", text: str(part.thinking) });
					else if (part?.type === "text" && str(part.text).trim()) this.items.push({ kind: "text", text: str(part.text) });
					else if (part?.type === "toolCall" && typeof part.id === "string") {
						const item = { kind: "tool", id: part.id, name: str(part.name), args: part.arguments && typeof part.arguments === "object" ? part.arguments : {}, result: undefined, isError: false, durationMs: undefined };
						this.tools.set(part.id, item);
						this.items.push(item);
					}
				}
				return this.items.length > before;
			}
			case "toolResult": {
				const item = this.tools.get(message.toolCallId);
				if (!item) return false;
				item.result = { content: Array.isArray(message.content) ? message.content : [], details: message.details };
				item.isError = message.isError === true;
				item.durationMs = typeof message.durationMs === "number" ? message.durationMs : undefined;
				item.version = (item.version ?? 0) + 1;
				return true;
			}
			default:
				return false;
		}
	}
}

// ---------------------------------------------------------------------------
// Finished rows of the Agents card: gentle-pi draws a finished task with ✓ (completed), ✗ (failed, timed out) or –
// (cancelled). Its record in the tasks folder names the session whose pop-up the row's ↗ opens.
// ---------------------------------------------------------------------------

const FINISHED_GLYPHS = { "✓": ["completed"], "✗": ["failed", "timed_out"], "–": ["cancelled"] };

/** The statuses an Agents row's glyph shows when its task finished, else undefined. */
export function finishedRowStatus(text) {
	const match = LEAD.exec(String(text));
	return match ? FINISHED_GLYPHS[match[1]] : undefined;
}

const newestEnd = (a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt);

/** The id of the record a finished Agents row shows, as rowTask matches a working one; the newest of alike. */
export function rowRecord(text, records) {
	const statuses = finishedRowStatus(text);
	if (!statuses || !Array.isArray(records)) return undefined;
	const row = LEAD.exec(String(text))[2];
	const done = records.filter((record) => statuses.includes(record.status) && shown(row, record.agent));
	const labelled = done.filter((record) => shown(row, record.label));
	return (labelled.length ? labelled : done).sort(newestEnd)[0]?.id;
}

/**
 * The tasks folder's records, read once each and again only when their file changes: list(parentSessionId) gives
 * that session's records whose session file is there to read.
 */
export class FinishedRecords {
	constructor({ agentDir, sessions, tasks, files = fs } = {}) {
		this.sessions = sessions ?? sessionsDir(agentDir);
		this.tasks = tasks ?? tasksDir(agentDir);
		this.files = files;
		this.cache = new Map(); // file name -> { stamp, record }
	}

	list(parentSessionId) {
		if (typeof parentSessionId !== "string" || !parentSessionId) return [];
		let names;
		try {
			names = this.files.readdirSync(this.tasks).filter((name) => name.endsWith(".json"));
		} catch {
			return [];
		}
		const listed = new Set(names);
		for (const name of this.cache.keys()) if (!listed.has(name)) this.cache.delete(name);
		const out = [];
		for (const name of names) {
			const file = path.join(this.tasks, name);
			let stamp;
			try {
				const stat = this.files.statSync(file);
				stamp = `${stat.mtimeMs}:${stat.size}`;
			} catch {
				continue;
			}
			let cached = this.cache.get(name);
			if (cached?.stamp !== stamp) {
				let record;
				try {
					record = taskOf(JSON.parse(this.files.readFileSync(file, "utf8")));
				} catch {
					record = undefined;
				}
				cached = { stamp, record };
				this.cache.set(name, cached);
			}
			const record = cached.record;
			if (record?.parentSessionId === parentSessionId && recordSessionPath(record, this.sessions, this.files)) out.push(record);
		}
		return out;
	}

	/** A record seen by the last list(), by id. */
	get(id) {
		for (const { record } of this.cache.values()) if (record?.id === id) return record;
		return undefined;
	}
}
