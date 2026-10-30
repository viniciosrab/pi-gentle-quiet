// The Engram side of the MEM tab, after pi-cinlodev-cute's src/engram/engram-client.ts: the local server's
// health, its projects' counts and pending items (observations due for review, relations waiting for judgment)
// over HTTP, one observation by id (GET only), the database's size on disk (stat only) and the latest session
// summary from the engram CLI. No cloud: nothing here reads the cloud config or runs a cloud command. Every
// call has a short timeout and resolves to undefined (or { ok: false }) on any failure; nothing here throws.
//
// The I/O goes through `deps` (defaultDeps() below), so tests hand in stand-ins.
// @ts-nocheck

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_ENGRAM_PORT = 7437;
const HTTP_TIMEOUT = 1200;
const CLI_TIMEOUT = 2500;

export function defaultDeps() {
	return {
		env: process.env,
		home: os.homedir(),
		now: () => Date.now(),
		timeouts: { http: HTTP_TIMEOUT, cli: CLI_TIMEOUT },
		async fetchJson(url, ms) {
			try {
				const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
				return res.ok ? await res.json() : undefined;
			} catch {
				return undefined;
			}
		},
		run(bin, args, ms) {
			return new Promise((resolve) => {
				try {
					execFile(bin, args, { timeout: ms, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
						resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), message: error ? String(stderr || error.message || error).trim() : "" });
					});
				} catch (error) {
					resolve({ ok: false, stdout: "", stderr: "", message: String(error?.message ?? error) });
				}
			});
		},
		async readFile(file) {
			try {
				return await readFile(file, "utf8");
			} catch {
				return undefined;
			}
		},
		async statSize(file) {
			try {
				return (await stat(file)).size;
			} catch {
				return undefined;
			}
		},
	};
}

const given = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const httpTimeout = (deps) => deps.timeouts?.http ?? HTTP_TIMEOUT;
const cliTimeout = (deps) => deps.timeouts?.cli ?? CLI_TIMEOUT;
export const engramBin = (env) => given(env?.ENGRAM_BIN) ?? "engram";
const dataDir = (deps) => given(deps.env?.ENGRAM_DATA_DIR) ?? path.join(deps.home, ".engram");

/**
 * The server gentle-engram talks to: ENGRAM_URL when set, else 127.0.0.1 on ENGRAM_PORT (7437). A
 * session-owned server (ENGRAM_SERVER_MODE=session-owned) has a private port and token: undefined.
 */
export function engramEndpoint(env = {}) {
	if (env.ENGRAM_SERVER_MODE === "session-owned") return undefined;
	const url = given(env.ENGRAM_URL);
	if (url) {
		const clean = url.replace(/\/+$/, "");
		let label = clean;
		try {
			label = new URL(clean).host;
		} catch {}
		return { url: clean, label };
	}
	const port = Number.parseInt(given(env.ENGRAM_PORT) ?? "", 10) || DEFAULT_ENGRAM_PORT;
	return { url: `http://127.0.0.1:${port}`, label: String(port) };
}

async function readJson(deps, file) {
	const text = await deps.readFile(file);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * The project's Engram name: what the server resolves for the cwd (as gentle-engram does), else cute's
 * chain: .git/engram-project-identity.json, .engram/config.json, package.json's name, the folder's name.
 */
export async function detectProjectName(cwd, deps, endpoint = engramEndpoint(deps.env)) {
	if (!cwd) return undefined;
	if (endpoint) {
		const current = await deps.fetchJson(`${endpoint.url}/project/current?cwd=${encodeURIComponent(cwd)}`, httpTimeout(deps));
		if (given(current?.project)) return current.project.trim();
	}
	for (const [file, key] of [
		[path.join(cwd, ".git", "engram-project-identity.json"), "project"],
		[path.join(cwd, ".engram", "config.json"), "project"],
		[path.join(cwd, "package.json"), "name"],
	]) {
		const value = (await readJson(deps, file))?.[key];
		if (given(value)) return value.trim();
	}
	return path.basename(path.resolve(cwd));
}

/** Bytes as "512 B", "1.5 KB", "21.9 MB", "2.0 GB" (1024-based); undefined for no number. */
export function formatBytes(bytes) {
	if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return undefined;
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

/** Engram's store on disk: engram.db with its -wal and -shm; undefined without engram.db. */
export async function databaseSize(deps) {
	const db = path.join(dataDir(deps), "engram.db");
	const [main, wal, shm] = await Promise.all(["", "-wal", "-shm"].map((suffix) => deps.statSize(`${db}${suffix}`)));
	if (typeof main !== "number") return undefined;
	return [main, wal, shm].reduce((sum, size) => sum + (typeof size === "number" ? size : 0), 0);
}

const count = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);

/** GET /projects as this project's counts and the totals across projects; undefined without an answer. */
export function projectCounts(answer, project) {
	if (!Array.isArray(answer?.projects)) return undefined;
	const entry = answer.projects.find((item) => item?.name === project);
	return {
		project: { observations: count(entry?.observation_count), sessions: count(entry?.session_count), prompts: count(entry?.prompt_count) },
		all: { observations: answer.projects.reduce((sum, item) => sum + count(item?.observation_count), 0), projects: answer.projects.length },
	};
}

/** Everything the Engram card draws, for the project at `cwd`. */
export async function fetchSnapshot(cwd, deps) {
	const endpoint = engramEndpoint(deps.env);
	const project = await detectProjectName(cwd, deps, endpoint);
	if (!project) return { project: undefined, endpoint, at: deps.now() };
	const get = (route) => (endpoint ? deps.fetchJson(`${endpoint.url}${route}`, httpTimeout(deps)) : Promise.resolve(undefined));
	const query = `?project=${encodeURIComponent(project)}`;
	const [health, projects, review, conflicts, dbSize] = await Promise.all([
		get("/health"),
		get("/projects"),
		get(`/review${query}&limit=100`),
		get(`/conflicts/stats${query}`),
		databaseSize(deps).catch(() => undefined),
	]);
	return {
		project,
		endpoint,
		healthy: health?.status === "ok",
		version: given(health?.version),
		counts: projectCounts(projects, project),
		dbSize,
		pending: { review: count(review?.count ?? review?.observations?.length), conflicts: count(conflicts?.by_judgment_status?.pending) },
		at: deps.now(),
	};
}

/** One observation from the local server ({ id, type, title, content, … }); undefined when it cannot say. */
export async function fetchObservation(id, deps) {
	const endpoint = engramEndpoint(deps.env);
	if (!endpoint || !id) return undefined;
	const observation = await deps.fetchJson(`${endpoint.url}/observations/${encodeURIComponent(String(id))}`, httpTimeout(deps));
	return observation && typeof observation === "object" ? observation : undefined;
}

const RESULT = /^\[\d+\]\s+#(\d+)\s*\(([^)]+)\)\s*—\s*(.+)$/;

/** `engram search` output as records: id, type, title, the body's lines and the date line. */
export function parseHandoffs(raw) {
	if (!raw || typeof raw !== "string") return [];
	const records = [];
	let current;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		const head = trimmed.match(RESULT);
		if (head) {
			current = { id: head[1], type: head[2], title: head[3].trim(), rawLines: [], date: "" };
			records.push(current);
			continue;
		}
		if (!current || !trimmed) continue;
		if (trimmed.includes("| project:") || trimmed.includes("| scope:")) {
			current.date = trimmed.split("|")[0].trim();
			continue;
		}
		current.rawLines.push(trimmed);
	}
	return records;
}

const recordTime = (record) => {
	const time = Date.parse(String(record.date ?? "").replace(" ", "T"));
	return Number.isNaN(time) ? -1 : time;
};

/**
 * The project's latest session summary. cute searches "session summary" and takes the first hit, but
 * search ranks by relevance: this asks for the last few summaries and keeps the newest.
 */
export async function fetchHandoff(project, deps) {
	const result = await deps.run(engramBin(deps.env), ["search", "session summary", "--type", "session_summary", "--limit", "5", "--project", project], cliTimeout(deps));
	if (!result.ok) return null;
	const records = parseHandoffs(result.stdout);
	if (!records.length) return null;
	return records.reduce((best, record) => (recordTime(record) > recordTime(best) || (recordTime(record) === recordTime(best) && Number(record.id) > Number(best.id)) ? record : best));
}

/** "just now", "30s ago", "5m ago", "3h ago", "2d ago"; "never" without a date. */
export function relativeTime(input, now = Date.now()) {
	if (!input) return "never";
	const time = typeof input === "string" ? Date.parse(input.includes("T") ? input : input.replace(" ", "T")) : input.getTime?.();
	if (!Number.isFinite(time)) return "never";
	const sec = Math.floor(Math.max(0, now - time) / 1000);
	if (sec < 10) return "just now";
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hours = Math.floor(min / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}
