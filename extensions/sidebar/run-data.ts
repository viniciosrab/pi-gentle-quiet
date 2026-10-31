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
