import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { painted, plain, theme } from "./helpers.mjs";
import { createMemTab, createTab } from "../extensions/sidebar/mem.ts";
import { defaultDeps, engramEndpoint, parseHandoffs, relativeTime } from "../extensions/sidebar/mem-engram.ts";
import { countTools } from "../extensions/sidebar/mem-stack.ts";

const WIDTH = 59;
const NOW = Date.parse("2026-10-30T12:00:00Z");

// gentle-quiet's card and box, as the host hands them to a tab: the square outline, or the rows indented by one.
function fakeHost(options = {}) {
	const { outline = true, tools = ["mem_save", "read"], branch = [], agentDir = "/agent" } = options;
	const cwd = "cwd" in options ? options.cwd : "/srv/app";
	const inner = (width) => (outline ? width - 4 : width - 1);
	const fit = (row, width) => {
		const text = plain(row);
		return [...text].length <= width ? row : `${[...text].slice(0, width - 1).join("")}…`;
	};
	const box = (rows, width) =>
		outline
			? [theme.fg("border", `┌${"─".repeat(width - 2)}┐`), ...rows.map((row) => { const r = fit(row, width - 4); return `${theme.fg("border", "│")} ${r}${" ".repeat(Math.max(0, width - 4 - [...plain(r)].length))} ${theme.fg("border", "│")}`; }), theme.fg("border", `└${"─".repeat(width - 2)}┘`)]
			: rows.map((row) => ` ${fit(row, width - 1)}`);
	let renders = 0;
	const host = {
		theme,
		fg: (role, text) => theme.fg(role, text),
		bold: (text) => theme.bold(text),
		card: (title, rows, width) => box([theme.fg("toolTitle", theme.bold(title)), ...(rows.length ? ["", ...rows] : [])], width),
		box,
		inner,
		cwd: () => cwd,
		ctx: () => ({ sessionManager: { getBranch: () => branch, getEntries: () => branch } }),
		pi: { getAllTools: () => tools.map((name) => ({ name })) },
		agentDir,
		requestRender: () => renders++,
		git: async () => undefined,
		changes: () => undefined,
		usage: () => ({ name: "", windows: [] }),
		gauge: () => "",
		icons: { memory: "M", other: "›" },
	};
	return { host, renders: () => renders };
}

// Engram and the CLI as stand-ins: every call is recorded; answers come from the tables (null: no answer,
// enrolled null: sqlite3 cannot run).
function fakeDeps({ health = { status: "ok", version: "3.6.0" }, stats = { total_observations: 26, total_sessions: 59, total_prompts: 238 }, sync = { enabled: true, phase: "idle", last_sync_at: "2026-10-30T11:55:00Z" }, project, enrolled = true, search = "", files = {}, versions = { pi: "1.4.0", engram: "engram 3.6.0" }, open = true, run = {} } = {}) {
	const calls = { fetch: [], run: [], read: [], open: [] };
	const deps = {
		env: {},
		home: "/home/me",
		now: () => NOW,
		fetchJson: async (url) => {
			calls.fetch.push(url);
			const { pathname } = new URL(url);
			if (pathname === "/health") return health;
			if (pathname === "/stats") return stats;
			if (pathname === "/sync/status") return sync;
			if (pathname === "/project/current") return project ? { project } : undefined;
			return undefined;
		},
		run: async (bin, args) => {
			calls.run.push([bin, ...args]);
			const key = `${bin} ${args[0]}`;
			if (run[key]) return run[key](args);
			if (bin === "sqlite3") return enrolled === null ? { ok: false, stdout: "", message: "no sqlite3" } : { ok: true, stdout: enrolled ? "1\n" : "" };
			if (bin === "engram" && args[0] === "search") return search ? { ok: true, stdout: search } : { ok: false, stdout: "", message: "unknown project" };
			if (bin === "engram" && args[0] === "version") return versions.engram ? { ok: true, stdout: versions.engram } : { ok: false, stdout: "", message: "ENOENT" };
			if (bin === "pi") return versions.pi ? { ok: true, stdout: versions.pi } : { ok: false, stdout: "", message: "ENOENT" };
			if (bin === "engram" && args[0] === "cloud") return { ok: true, stdout: `✓ project ${args[1] === "enroll" ? "enrolled" : "unenrolled"}` };
			if (bin === "engram" && args[0] === "sync") return { ok: true, stdout: "synced 3 chunks" };
			return { ok: false, stdout: "", message: "ENOENT" };
		},
		readFile: async (file) => {
			calls.read.push(file);
			return files[file];
		},
		open: (url) => {
			calls.open.push(url);
			return open;
		},
	};
	return { deps, calls };
}

const PACKAGES = {
	"/agent/npm/node_modules/gentle-pi/package.json": JSON.stringify({ version: "4.5.1" }),
	"/agent/npm/node_modules/gentle-engram/package.json": JSON.stringify({ version: "0.5.1" }),
	"/srv/app/package.json": JSON.stringify({ name: "my-app" }),
};

// Engram prints dates in local time.
const local = (ms) => {
	const d = new Date(ms);
	const two = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

const HANDOFF = `Found 2 memories:

[1] #668 (session_summary) — Session summary
    ## Goal
Polish the status line for PR #12 on main -> develop.

## Discoveries
- Our gauge is byte-identical
    2026-10-16 18:05:01 | project: my-app | scope: project

[2] #803 (session_summary) — Session summary
    ## Goal
Ship the sidebar tabs.
- MEM tab done
    ${local(NOW - 3600_000)} | project: my-app | scope: project
`;

const flush = async () => {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function shown(options = {}, hostOptions = {}) {
	const { deps, calls } = fakeDeps({ files: PACKAGES, search: HANDOFF, ...options });
	const h = fakeHost(hostOptions);
	const tab = createMemTab(h.host, deps);
	tab.onShow?.();
	await flush();
	const rows = () => tab.render(WIDTH, 40);
	const text = () => rows().map(plain);
	const lineOf = (pattern) => text().findIndex((row) => pattern.test(row));
	const click = async (pattern, button = "left") => {
		const line = typeof pattern === "number" ? pattern : lineOf(pattern);
		assert.ok(line >= 0, `no row matches ${pattern}`);
		const acted = tab.handleClick(line, button, 3);
		await flush();
		return acted;
	};
	return { tab, deps, calls, rows, text, lineOf, click, ...h };
}

test("createTab does no I/O and draws before any data arrives", () => {
	const { deps, calls } = fakeDeps({ files: PACKAGES });
	const { host } = fakeHost();
	const tab = createMemTab(host, deps);
	assert.equal(tab.id, "mem");
	assert.deepEqual([calls.fetch.length, calls.run.length, calls.read.length], [0, 0, 0]);
	assert.equal(typeof createTab, "function");
	const out = tab.render(WIDTH, 40).map(plain);
	assert.ok(out.some((row) => row.includes("Stack · Ecosystem")));
	assert.ok(out.every((row) => [...row].length <= WIDTH), "nothing wider than the column");
});

test("onShow loads Engram's health, stats and sync state from the local server and redraws", async () => {
	const { text, rows, calls, renders } = await shown();
	assert.ok(calls.fetch.some((url) => url === "http://127.0.0.1:7437/health"));
	assert.ok(calls.fetch.some((url) => url === "http://127.0.0.1:7437/stats?project=my-app"));
	assert.ok(calls.fetch.some((url) => url === "http://127.0.0.1:7437/sync/status?project=my-app"));
	assert.ok(renders() > 0, "requestRender once the data came");
	const out = text();
	assert.match(out[1], /^│ M Engram: my-app +▲ │$/);
	assert.ok(out.some((row) => /│ Local \(7437\) +● Online · 26 obs │/.test(row)));
	assert.ok(out.some((row) => /│ ─+ │/.test(row)), "a divider under the daemon row");
	assert.ok(out.some((row) => /│ Cloud: localhost +dashboard ↗ │/.test(row)));
	assert.ok(out.some((row) => /│ {4}Sync: +● Enrolled \(5m ago\) │/.test(row)));
	assert.ok(out.some((row) => /│ {4}Push: +sync now ⟳ │/.test(row)));
	assert.ok(out.some((row) => /│ {4}Action: +unsync ✕ │/.test(row)));
	const joined = rows().join("\n");
	assert.ok(painted(joined, "success", "● Online"), "online in success");
	assert.ok(painted(joined, "accent", "dashboard ↗"));
	assert.ok(rows().every((row) => [...plain(row)].length === WIDTH), "every row as wide as the column");
});

test("the project comes from the Engram server first, then cute's chain: identity file, .engram/config.json, package.json, folder", async () => {
	assert.match((await shown({ project: "from-server" })).text()[1], /Engram: from-server/);
	const files = { ...PACKAGES, "/srv/app/.engram/config.json": JSON.stringify({ project: "from-config" }) };
	assert.match((await shown({ files })).text()[1], /Engram: from-config/);
	const identity = { ...files, "/srv/app/.git/engram-project-identity.json": JSON.stringify({ project: "from-identity" }) };
	assert.match((await shown({ files: identity })).text()[1], /Engram: from-identity/);
	const bare = { ...PACKAGES };
	delete bare["/srv/app/package.json"];
	assert.match((await shown({ files: bare })).text()[1], /Engram: app/);
});

test("a project not enrolled for cloud sync shows its state and the enroll action", async () => {
	const { text } = await shown({ enrolled: false });
	assert.ok(text().some((row) => /│ {4}State: +○ Not synced │/.test(row)));
	assert.ok(text().some((row) => /│ {4}Action: +\+ enroll repo │/.test(row)));
	assert.ok(!text().some((row) => /Sync:|Push:/.test(row)));
});

test("enrollment falls back to `engram cloud status` when sqlite3 cannot run", async () => {
	const status = { "engram cloud": (args) => ({ ok: true, stdout: args[1] === "status" ? "Project enrollment: enrolled (my-app)\n" : "" }) };
	const { text, calls } = await shown({ enrolled: null, run: status });
	assert.ok(calls.run.some((call) => call.join(" ") === "engram cloud status --project my-app"));
	assert.ok(text().some((row) => /Enrolled/.test(row)));
});

test("a syncing project shows the spinner text in warning", async () => {
	const { text, rows } = await shown({ sync: { enabled: true, phase: "syncing" } });
	assert.ok(text().some((row) => /Sync: +⟳ Syncing… │/.test(row)));
	assert.ok(painted(rows().join(""), "warning", "⟳ Syncing…"));
});

test("a daemon that is down degrades to a short message, without throwing", async () => {
	const { text, rows } = await shown({ health: null, stats: null, sync: null });
	assert.ok(text().some((row) => /│ Local \(7437\) +○ Down │/.test(row)));
	assert.ok(painted(rows().join(""), "error", "○ Down"));
});

test("clicking the Engram title collapses the card to one summary row, and again expands it", async () => {
	const { click, text } = await shown();
	assert.equal(await click(/Engram: my-app/), true);
	const out = text();
	assert.match(out[1], /Engram: my-app +▼/);
	assert.ok(out.some((row) => /│ ● 26 obs · cloud✓ +│/.test(row)));
	assert.ok(!out.some((row) => /Local \(7437\)/.test(row)));
	await click(/Engram: my-app/);
	assert.ok(text().some((row) => /Local \(7437\)/.test(row)));
});

test("'dashboard ↗' opens the project's dashboard: the cloud server's when configured, else the local one", async () => {
	const local = await shown();
	assert.equal(await local.click(/dashboard ↗/), true);
	assert.deepEqual(local.calls.open, ["http://127.0.0.1:7437/dashboard/projects/my-app"]);
	assert.ok(local.text().some((row) => /⚡ Opening my-app in the browser…/.test(row)), "a notice while it opens");
	const files = { ...PACKAGES, "/home/me/.engram/cloud.json": JSON.stringify({ server_url: "https://cloud.example.com/", token: "secret" }) };
	const cloud = await shown({ files });
	assert.ok(cloud.text().some((row) => /Cloud: cloud\.example\.com +dashboard ↗/.test(row)));
	await cloud.click(/dashboard ↗/);
	assert.deepEqual(cloud.calls.open, ["https://cloud.example.com/dashboard/projects/my-app"]);
	assert.ok(!cloud.text().join("").includes("secret"), "the token is never drawn");
	const broken = await shown({ open: false });
	await broken.click(/dashboard ↗/);
	assert.ok(broken.text().some((row) => /Could not open the browser/.test(row)));
});

test("enroll asks for a second click, then runs `engram cloud enroll`; a click elsewhere cancels", async () => {
	const { click, text, calls, lineOf } = await shown({ enrolled: false });
	await click(/\+ enroll repo/);
	assert.ok(text().some((row) => /Enroll repo\? \[click = yes\]/.test(row)));
	assert.ok(!calls.run.some((call) => call[1] === "cloud" && call[2] === "enroll"), "not yet");
	assert.equal(await click(lineOf(/Local \(7437\)/)), true, "a click elsewhere cancels");
	assert.ok(text().some((row) => /\+ enroll repo/.test(row)));
	await click(/\+ enroll repo/);
	await click(/Enroll repo\?/);
	assert.ok(calls.run.some((call) => call.join(" ") === "engram cloud enroll my-app"));
	assert.ok(text().some((row) => /✓ my-app enrolled/.test(row)));
});

test("unsync asks for a second click, then runs `engram cloud unenroll`; sync now runs `engram sync --cloud`", async () => {
	const { click, text, calls } = await shown();
	await click(/unsync ✕/);
	assert.ok(text().some((row) => /Unsync\? \[click = yes\]/.test(row)));
	await click(/Unsync\?/);
	assert.ok(calls.run.some((call) => call.join(" ") === "engram cloud unenroll my-app"));
	await click(/sync now ⟳/);
	assert.ok(calls.run.some((call) => call.join(" ") === "engram sync --cloud --project my-app"));
	assert.ok(text().some((row) => /✓ my-app synced/.test(row)));
});

test("a failing cloud command shows a short error notice", async () => {
	const failing = { "engram sync": () => ({ ok: false, stdout: "", message: "no effective server URL configured for cloud sync" }) };
	const { click, text } = await shown({ run: failing });
	await click(/sync now ⟳/);
	const notice = text().find((row) => /⚠ Sync failed/.test(row));
	assert.ok(notice, "the notice");
	assert.ok([...notice].length <= WIDTH);
});

test("the Active Handoff card shows the latest session summary from `engram search`", async () => {
	const { text, rows, calls } = await shown();
	assert.ok(calls.run.some((call) => call.join(" ") === "engram search session summary --type session_summary --limit 5 --project my-app"));
	const out = text();
	const start = out.findIndex((row) => /M Active Handoff/.test(row));
	assert.ok(start > 0);
	const card = out.slice(start);
	assert.match(card[2], /│ #803 session_summary +1h ago │/);
	assert.ok(card.some((row) => /│ ✦ Goal +│/.test(row)));
	assert.ok(card.some((row) => /│ Ship the sidebar tabs\. +│/.test(row)));
	assert.ok(card.some((row) => /│ {3}• MEM tab done +│/.test(row)));
	assert.ok(!card.some((row) => /#668/.test(row)), "only the latest");
	assert.ok(painted(rows().join(""), "accent", "#803"));
});

test("handoff text wraps to the card and marks PRs, branches and arrows", () => {
	const [record] = parseHandoffs(HANDOFF);
	assert.equal(record.id, "668");
	assert.equal(record.type, "session_summary");
	assert.deepEqual(record.rawLines, ["## Goal", "Polish the status line for PR #12 on main -> develop.", "## Discoveries", "- Our gauge is byte-identical"]);
	assert.equal(record.date, "2026-10-16 18:05:01");
	assert.deepEqual(parseHandoffs("engram: unknown project"), []);
	assert.deepEqual(parseHandoffs(""), []);
});

test("without a session summary the handoff card says so; a click on it fetches again", async () => {
	const { text, click, calls } = await shown({ search: "" });
	assert.ok(text().some((row) => /No previous session summary/.test(row)));
	const before = calls.run.filter((call) => call[1] === "search").length;
	assert.equal(await click(/No previous session summary/), true);
	assert.equal(calls.run.filter((call) => call[1] === "search").length, before + 1);
});

test("the Ecosystem card lists Pi, gentle-pi, gentle-engram and the engram binary; a click toggles the details", async () => {
	const { text, rows, click } = await shown({ versions: { pi: "1.4.0" } });
	const out = text();
	assert.ok(out.some((row) => /│ ● pi v1\.4\.0 +│/.test(row)));
	assert.ok(out.some((row) => /│ ● gentle-pi v4\.5\.1 +│/.test(row)));
	assert.ok(out.some((row) => /│ ● gentle-engram v0\.5\.1 +│/.test(row)));
	assert.ok(out.some((row) => /│ ○ engram - +│/.test(row)), "a missing binary: dim, no version");
	assert.ok(painted(rows().join(""), "dim", "○"));
	await click(/gentle-pi v/);
	assert.ok(text().some((row) => /gentle-pi v4\.5\.1 +installed │/.test(row)));
	assert.ok(text().some((row) => /engram - +not available │/.test(row)));
	await click(/Stack · Ecosystem/);
	assert.ok(!text().some((row) => /installed/.test(row)));
});

test("the Tools card counts the session's tool calls by group, and is left out before any call", async () => {
	const call = (...names) => ({ type: "message", message: { role: "assistant", content: names.map((name) => ({ type: "toolCall", name })) } });
	const branch = [call("read", "read", "edit"), call("bash"), call("mem_save", "grep", "web_search", "fetch_content", "subagent_run"), { type: "message", message: { role: "user", content: "hi" } }];
	const { text, rows } = await shown({}, { branch });
	const out = text();
	assert.ok(out.some((row) => /Tools +9 calls/.test(row)));
	assert.ok(out.some((row) => row.includes("✎ 2 read") && row.includes("✎ 1 write") && row.includes(">_ 1 bash")));
	assert.ok(out.some((row) => row.includes("M 1 engram")));
	assert.ok(out.some((row) => row.includes("⚙ 1 other")));
	assert.ok(painted(rows().join(""), "success", ">_ 1 bash"));
	assert.ok(!(await shown()).text().some((row) => /Tools/.test(row)));
	assert.deepEqual(countTools(undefined).total, 0);
});

test("without gentle-engram the Engram and handoff cards are left out", async () => {
	const files = { ...PACKAGES };
	delete files["/agent/npm/node_modules/gentle-engram/package.json"];
	const { text, calls } = await shown({ files }, { tools: ["read"] });
	assert.ok(!text().some((row) => /Engram:|Active Handoff/.test(row)));
	assert.ok(text().some((row) => /Stack · Ecosystem/.test(row)));
	assert.ok(!calls.fetch.length, "no Engram calls");
	assert.ok(!text().some((row) => /Persistent Memory/.test(row)), "no persistent memory card without ~/.memory/memories.db");
});

test("with the outline off the same rows are clickable, and the wheel is left to the column", async () => {
	const { click, text, tab } = await shown({}, { outline: false });
	assert.match(text()[0], /^ M Engram: my-app/);
	await click(/dashboard ↗/);
	await click(/^ M Engram/);
	assert.ok(text().some((row) => /● 26 obs · cloud✓/.test(row)));
	assert.equal(tab.handleWheel?.(1, 0, 0) ?? false, false);
	assert.equal(tab.handleClick(2, "right", 0), false, "only the left button");
	assert.equal(tab.handleClick(999, "left", 0), false, "past the rows");
});

test("onShow refreshes stale data, keeps fresh data cached, and dispose clears the timers", async () => {
	const { tab, calls, click } = await shown();
	const healthCalls = () => calls.fetch.filter((url) => url.endsWith("/health")).length;
	const before = healthCalls();
	tab.onShow();
	await flush();
	assert.equal(healthCalls(), before, "fresh within the cache window");
	await click(/dashboard ↗/); // starts the notice timer
	tab.invalidate?.();
	tab.dispose?.();
});

test("relative times read like cute's, in English", () => {
	assert.equal(relativeTime(null, NOW), "never");
	assert.equal(relativeTime(new Date(NOW - 3000).toISOString(), NOW), "just now");
	assert.equal(relativeTime(new Date(NOW - 30_000).toISOString(), NOW), "30s ago");
	assert.equal(relativeTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW), "3h ago");
	assert.equal(relativeTime(new Date(NOW - 2 * 86400_000).toISOString(), NOW), "2d ago");
	assert.equal(relativeTime("not a date", NOW), "never");
});

test("the endpoint is gentle-engram's: ENGRAM_URL, else 127.0.0.1 and ENGRAM_PORT or 7437; none for a session-owned server", () => {
	assert.deepEqual(engramEndpoint({}), { url: "http://127.0.0.1:7437", label: "7437" });
	assert.deepEqual(engramEndpoint({ ENGRAM_PORT: "17437" }), { url: "http://127.0.0.1:17437", label: "17437" });
	assert.deepEqual(engramEndpoint({ ENGRAM_PORT: "  " }), { url: "http://127.0.0.1:7437", label: "7437" });
	assert.deepEqual(engramEndpoint({ ENGRAM_URL: "http://box:9000/", ENGRAM_PORT: "1" }), { url: "http://box:9000", label: "box:9000" });
	assert.equal(engramEndpoint({ ENGRAM_SERVER_MODE: "session-owned" }), undefined);
});

test("a session-owned server shows as private, with no HTTP calls", async () => {
	const { deps, calls } = fakeDeps({ files: PACKAGES, search: HANDOFF });
	deps.env = { ENGRAM_SERVER_MODE: "session-owned" };
	const { host } = fakeHost();
	const tab = createMemTab(host, deps);
	tab.onShow();
	await flush();
	const out = tab.render(WIDTH, 40).map(plain);
	assert.ok(out.some((row) => /Local \(private\) +○ Unreachable/.test(row)));
	assert.equal(calls.fetch.length, 0);
});

test("the real I/O degrades: a missing engram binary, a server that never answers, no cwd", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gq-mem-"));
	mkdirSync(path.join(dir, "agent"), { recursive: true });
	writeFileSync(path.join(dir, "package.json"), "{ not json");
	const server = createServer(() => {}); // takes the request and never answers
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const deps = defaultDeps();
		deps.env = { ENGRAM_URL: `http://127.0.0.1:${server.address().port}`, ENGRAM_BIN: path.join(dir, "no-such-engram"), PATH: "" };
		deps.home = dir;
		deps.timeouts = { http: 200, cli: 300 };
		assert.equal(await deps.fetchJson(`http://127.0.0.1:${server.address().port}/health`, 200), undefined);
		const missing = await deps.run(path.join(dir, "no-such-engram"), ["version"], 300);
		assert.equal(missing.ok, false);
		assert.equal(await deps.readFile(path.join(dir, "nothing.json")), undefined);
		const { host } = fakeHost({ cwd: dir, tools: ["mem_save"], agentDir: path.join(dir, "agent") });
		const tab = createMemTab(host, deps);
		tab.onShow();
		const started = Date.now();
		while (Date.now() - started < 3000 && !tab.render(WIDTH, 40).map(plain).some((row) => /○ Down/.test(row))) await new Promise((resolve) => setTimeout(resolve, 50));
		const out = tab.render(WIDTH, 40).map(plain);
		assert.ok(out.some((row) => /○ Down/.test(row)), "the hanging server times out to Down");
		assert.ok(out.some((row) => new RegExp(`Engram: ${path.basename(dir)}`).test(row)), "a broken package.json falls through to the folder");
		assert.ok(out.some((row) => /No previous session summary/.test(row)));
		const { host: lost } = fakeHost({ cwd: undefined });
		const orphan = createMemTab(lost, fakeDeps({ files: PACKAGES }).deps);
		orphan.onShow();
		await flush();
		assert.ok(orphan.render(WIDTH, 40).map(plain).some((row) => /No project/.test(row)), "no cwd: a short message");
		tab.dispose();
	} finally {
		server.closeAllConnections?.();
		server.close();
	}
});
