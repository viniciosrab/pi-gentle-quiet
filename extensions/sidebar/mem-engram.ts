// The Engram side of the MEM tab, after pi-cinlodev-cute's src/engram/engram-client.ts: the local server's
// health, stats and sync state over HTTP, the project's cloud enrollment, the latest session summary from
// the engram CLI, and the cloud commands behind the card's buttons. Every call has a short timeout and
// resolves to undefined (or { ok: false }) on any failure; nothing here throws.
//
// The I/O goes through `deps` (defaultDeps() below), so tests hand in stand-ins.
// @ts-nocheck

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_ENGRAM_PORT = 7437;
const HTTP_TIMEOUT = 1200;
const CLI_TIMEOUT = 2500;
const SYNC_TIMEOUT = 15000;

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
		open(url) {
			try {
				const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
				const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
				child.on("error", () => {});
				child.unref();
				return true;
			} catch {
				return false;
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

/** The cloud server from ~/.engram/cloud.json: only its URL is kept. */
export async function loadCloudConfig(deps) {
	const serverUrl = given((await readJson(deps, path.join(dataDir(deps), "cloud.json")))?.server_url);
	return serverUrl ? { serverUrl } : undefined;
}

/** The project's dashboard: on the cloud server when one is configured, else on the local one. */
export function dashboardUrl(cloud, project, endpoint) {
	const base = cloud?.serverUrl ? cloud.serverUrl.replace(/\/+$/, "") : (endpoint?.url ?? `http://127.0.0.1:${DEFAULT_ENGRAM_PORT}`);
	return project ? `${base}/dashboard/projects/${encodeURIComponent(project)}` : `${base}/dashboard/`;
}

/** The host the Cloud row names: the cloud server's, or "localhost". */
export function cloudHost(cloud, endpoint) {
	try {
		if (cloud?.serverUrl) return new URL(cloud.serverUrl).hostname;
		const host = endpoint ? new URL(endpoint.url).hostname : "localhost";
		return host === "127.0.0.1" || host === "::1" ? "localhost" : host;
	} catch {
		return "localhost";
	}
}

/** Enrolled for cloud sync: sqlite3 on Engram's store first (fast), else `engram cloud status`. */
export async function checkEnrolled(project, deps) {
	const db = path.join(dataDir(deps), "engram.db");
	const query = `SELECT 1 FROM sync_enrolled_projects WHERE project = '${project.replace(/'/g, "''")}' LIMIT 1;`;
	const sqlite = await deps.run("sqlite3", ["-readonly", db, query], 1500);
	if (sqlite.ok) return sqlite.stdout.trim() === "1";
	const status = await deps.run(engramBin(deps.env), ["cloud", "status", "--project", project], cliTimeout(deps));
	if (!status.ok) return false;
	const line = (status.stdout.match(/Project enrollment:\s*(.*)/i)?.[1] ?? "").trim().toLowerCase();
	return line.startsWith("enrolled");
}

/** Everything the Engram card draws, for the project at `cwd`. */
export async function fetchSnapshot(cwd, deps) {
	const endpoint = engramEndpoint(deps.env);
	const project = await detectProjectName(cwd, deps, endpoint);
	if (!project) return { project: undefined, endpoint, at: deps.now() };
	const get = (route) => (endpoint ? deps.fetchJson(`${endpoint.url}${route}`, httpTimeout(deps)) : Promise.resolve(undefined));
	const query = `?project=${encodeURIComponent(project)}`;
	const [health, stats, sync, enrolled, cloud] = await Promise.all([get("/health"), get(`/stats${query}`), get(`/sync/status${query}`), checkEnrolled(project, deps), loadCloudConfig(deps)]);
	return {
		project,
		endpoint,
		healthy: health?.status === "ok",
		version: health?.version,
		stats: stats ? { observations: Number(stats.total_observations ?? 0), sessions: Number(stats.total_sessions ?? 0), prompts: Number(stats.total_prompts ?? 0) } : undefined,
		sync: sync ? { enabled: Boolean(sync.enabled), phase: String(sync.phase || "idle"), lastSyncAt: sync.last_sync_at ? String(sync.last_sync_at) : null } : undefined,
		enrolled,
		cloud,
		at: deps.now(),
	};
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

/** The card's cloud buttons: enroll, unenroll, sync now. */
export async function cloudCommand(kind, project, deps) {
	const bin = engramBin(deps.env);
	const result =
		kind === "sync" ? await deps.run(bin, ["sync", "--cloud", "--project", project], SYNC_TIMEOUT)
		: await deps.run(bin, ["cloud", kind, project], 5000);
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
	const success = result.ok && (kind === "sync" ? !/failed|error/i.test(output) : /enrolled|✓/.test(output));
	const message = (success ? output : result.message || output || "failed").split("\n")[0].trim();
	return { success, message };
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
