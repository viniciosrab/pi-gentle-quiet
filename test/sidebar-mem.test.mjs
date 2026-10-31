import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { painted, plain, theme } from "./helpers.mjs";
import { createMemTab, createTab } from "../extensions/sidebar/mem.ts";
import { defaultDeps, engramEndpoint, formatBytes, parseHandoffs, relativeTime } from "../extensions/sidebar/mem-engram.ts";
import { scanSession } from "../extensions/sidebar/mem-session.ts";

const WIDTH = 59;
const NOW = Date.parse("2026-10-30T12:00:00Z");

// gentle-quiet's card and box, as the host hands them to a tab: the square outline, or the rows indented by one.
function fakeHost(options = {}) {
	const { outline = true, tools = ["mem_save", "read"], branch = [], agentDir = "/agent", ui } = options;
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
		ctx: () => ({ sessionManager: { getBranch: () => branch, getEntries: () => branch }, ...(ui ? { hasUI: true, ui } : {}) }),
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

// Engram, the CLI and the disk as stand-ins: every call is recorded; answers come from the tables (null: no
// answer). `sizes` maps a file to its size on disk; a file not there has no size.
const PROJECTS = {
	count: 3,
	projects: [
		{ name: "my-app", observation_count: 27, session_count: 72, prompt_count: 284, directories: ["/srv/app"] },
		{ name: "other", observation_count: 300, session_count: 400, prompt_count: 1500 },
		{ name: "third", observation_count: 20, session_count: 1, prompt_count: 2 },
	],
};
const SIZES = { "/home/me/.engram/engram.db": 17_000_000, "/home/me/.engram/engram.db-wal": 5_900_000, "/home/me/.engram/engram.db-shm": 63_814 };

function fakeDeps({ observations = {}, review, conflicts, health = { status: "ok", version: "3.6.0" }, projects = PROJECTS, project, search = "", files = {}, sizes = SIZES, run = {} } = {}) {
	const calls = { fetch: [], run: [], read: [], stat: [] };
	const deps = {
		env: {},
		home: "/home/me",
		now: () => NOW,
		fetchJson: async (url) => {
			calls.fetch.push(url);
			const { pathname } = new URL(url);
			if (pathname === "/health") return health;
			if (pathname === "/projects") return projects;
			if (pathname === "/project/current") return project ? { project } : undefined;
			if (pathname.startsWith("/observations/")) return observations[pathname.split("/")[2]];
			if (pathname === "/review") return review;
			if (pathname === "/conflicts/stats") return conflicts;
			return undefined;
		},
		run: async (bin, args) => {
			calls.run.push([bin, ...args]);
			const key = `${bin} ${args[0]}`;
			if (run[key]) return run[key](args);
			if (bin === "engram" && args[0] === "search") return search ? { ok: true, stdout: search } : { ok: false, stdout: "", message: "unknown project" };
			return { ok: false, stdout: "", message: "ENOENT" };
		},
		readFile: async (file) => {
			calls.read.push(file);
			return files[file];
		},
		statSize: async (file) => {
			calls.stat.push(file);
			return sizes[file];
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

const cardOf = (out, title) => {
	const start = out.findIndex((row) => row.includes(title));
	assert.ok(start >= 0, `no ${title} card`);
	const end = out.findIndex((row, i) => i > start && /^└/.test(row));
	return out.slice(start + 2, end);
};

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
	assert.ok(out.some((row) => row.includes("Saved this session")));
	assert.ok(out.every((row) => [...row].length <= WIDTH), "nothing wider than the column");
});

test("onShow loads Engram's health and projects from the local server and redraws", async () => {
	const { text, rows, calls, renders } = await shown();
	assert.ok(calls.fetch.some((url) => url === "http://127.0.0.1:7437/health"));
	assert.ok(calls.fetch.some((url) => url === "http://127.0.0.1:7437/projects"));
	assert.ok(renders() > 0, "requestRender once the data came");
	const out = text();
	assert.match(out[1], /^│ M Engram: my-app +▲ │$/);
	const card = cardOf(out, "Engram: my-app");
	assert.deepEqual(card.map((row) => row.replace(/ {2,}/g, "  ")), [
		"│ Local (7437)  ● Online · v3.6.0 │",
		"│ This project  27 memories · 72 sessions · 284 prompts │",
		"│ Database (all projects)  21.9 MB │",
	]);
	const joined = rows().join("\n");
	assert.ok(painted(joined, "success", "● Online"), "online in success");
	assert.ok(!joined.includes("All projects"), "only this project's counts: no sum over every project");
	for (const label of ["Local (7437)", "This project", "Database (all projects)"]) assert.ok(painted(joined, "muted", label), `${label} muted`);
	assert.ok(rows().every((row) => [...plain(row)].length === WIDTH), "every row as wide as the column");
});

test("the database size is engram.db with its -wal and -shm, stat only; ENGRAM_DATA_DIR moves it", async () => {
	const { calls } = await shown();
	assert.deepEqual([...calls.stat].sort(), ["/home/me/.engram/engram.db", "/home/me/.engram/engram.db-shm", "/home/me/.engram/engram.db-wal"]);
	assert.ok(!calls.read.some((file) => /engram\.db|cloud\.json/.test(file)), "no file read for the size, no cloud config");
	const { deps, calls: moved } = fakeDeps({ files: PACKAGES, sizes: { "/data/engram.db": 2048 } });
	deps.env = { ENGRAM_DATA_DIR: "/data" };
	const tab = createMemTab(fakeHost().host, deps);
	tab.onShow();
	await flush();
	assert.ok(moved.stat.includes("/data/engram.db"));
	assert.ok(tab.render(WIDTH, 40).map(plain).some((row) => /│ Database \(all projects\) +2\.0 KB │/.test(row)), "missing -wal and -shm count as nothing");
	const none = await shown({ sizes: {} });
	assert.ok(!none.text().some((row) => /Database/.test(row)), "no database file: no row");
});

test("sizes read as B, KB, MB and GB", () => {
	assert.equal(formatBytes(0), "0 B");
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(1536), "1.5 KB");
	assert.equal(formatBytes(22_963_814), "21.9 MB");
	assert.equal(formatBytes(2 * 1024 ** 3), "2.0 GB");
	assert.equal(formatBytes(undefined), undefined);
	assert.equal(formatBytes(Number.NaN), undefined);
});

test("one memory, session or prompt reads in the singular", async () => {
	const projects = { count: 1, projects: [{ name: "my-app", observation_count: 1, session_count: 1, prompt_count: 1 }] };
	const { text } = await shown({ projects });
	assert.ok(text().some((row) => /│ This project +1 memory · 1 session · 1 prompt │/.test(row)));
	const fresh = await shown({ projects: { count: 1, projects: [{ name: "other", observation_count: 5, session_count: 2, prompt_count: 3 }] } });
	assert.ok(fresh.text().some((row) => /│ This project +0 memories · 0 sessions · 0 prompts │/.test(row)), "a project Engram has not seen yet");
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

test("a daemon that is down shows offline in warning, without throwing; the database size still shows", async () => {
	const { text, rows } = await shown({ health: null, projects: null });
	assert.ok(text().some((row) => /│ Local \(7437\) +○ Offline │/.test(row)));
	assert.ok(painted(rows().join(""), "warning", "○ Offline"));
	assert.ok(!text().some((row) => /This project/.test(row)), "no counts without the server");
	assert.ok(text().some((row) => /│ Database \(all projects\) +21\.9 MB │/.test(row)));
});

test("no Cloud section: no host, state, dashboard or enroll/sync actions, and clicks on the card spawn nothing", async () => {
	const { text, calls, click } = await shown({ review: { count: 2 }, conflicts: { by_judgment_status: { pending: 1 } } });
	assert.ok(!text().some((row) => /Cloud|cloud|dashboard|enroll|Enroll|unsync|sync now|Sync:|State:|Action:|Push:|Enrolled/.test(row)));
	assert.ok(!calls.fetch.some((url) => /^\/(sync|stats|cloud)\b/.test(new URL(url).pathname)), "no sync state, no /stats, no cloud route");
	assert.ok(!calls.read.some((file) => /cloud\.json/.test(file)));
	const before = calls.run.length;
	for (const pattern of [/Local \(7437\)/, /This project/, /Database/, /⚑ 2 to review/]) assert.equal(await click(pattern), false, `${pattern} is not an action`);
	assert.equal(calls.run.length, before, "no command ran");
	assert.ok(calls.run.every((call) => call[0] === "engram" && call[1] === "search"), "the handoff search is the only command");
});

test("clicking the Engram title collapses the card to one summary row, and again expands it", async () => {
	const { click, text } = await shown();
	assert.equal(await click(/Engram: my-app/), true);
	const out = text();
	assert.match(out[1], /Engram: my-app +▼/);
	assert.ok(out.some((row) => /│ ● 27 memories · 21\.9 MB +│/.test(row)));
	assert.ok(!out.some((row) => /Local \(7437\)/.test(row)));
	await click(/Engram: my-app/);
	assert.ok(text().some((row) => /Local \(7437\)/.test(row)));
});

test("the Active Handoff starts folded to one row: id, age and the goal's first line", async () => {
	const { text, rows, calls } = await shown();
	assert.ok(calls.run.some((call) => call.join(" ") === "engram search session summary --type session_summary --limit 5 --project my-app"));
	const out = text();
	const start = out.findIndex((row) => /M Active Handoff/.test(row));
	assert.ok(start > 0);
	assert.match(out[start], /M Active Handoff +▼ │$/);
	const card = out.slice(start, out.findIndex((row, i) => i > start && /^└/.test(row)) + 1);
	assert.equal(card.length, 4, "title, blank, one row, bottom");
	assert.match(card[2], /^│ #803 · 1h ago · Ship the sidebar tabs\. +│$/);
	assert.ok(painted(rows().join(""), "accent", "#803"));
});

test("the folded handoff cuts a long goal with …; a click on its title toggles the full text", async () => {
	const long = HANDOFF.replace("Ship the sidebar tabs.", `Ship the sidebar tabs ${"and more ".repeat(12)}.`);
	const { text, click } = await shown({ search: long });
	const row = text().find((r) => /#803 · 1h ago/.test(r));
	assert.match(row, /… │$/);
	assert.equal([...row].length, WIDTH);
	assert.equal(await click(/M Active Handoff/), true);
	assert.ok(text().some((r) => /│ ✦ Goal +│/.test(r)), "expanded");
	assert.ok(text().some((r) => /M Active Handoff +▲ │$/.test(r)));
	await click(/M Active Handoff/);
	assert.ok(!text().some((r) => /✦ Goal/.test(r)), "folded again");
});

test("a click on the handoff's content opens the whole summary read-only in the pop-up, folded or not", async () => {
	const observations = { 803: { id: 803, type: "session_summary", title: "Session summary", content: "## Goal\nShip the sidebar tabs.\n\n## Next Steps\n- the whole text, not only the card" } };
	const fake = fakeUi();
	const { text, click, calls } = await shown({ observations }, { ui: fake.ui });
	assert.equal(await click(/#803 · 1h ago/), true);
	assert.equal(fake.opened.length, 1, "the folded row opens it");
	assert.ok(!text().some((r) => /✦ Goal/.test(r)), "the card stays folded");
	assert.ok(calls.fetch.includes("http://127.0.0.1:7437/observations/803"), "the full text from the local API");
	const out = (await fake.component()).render(80).map(plain);
	assert.match(out[1], /^▏ Read-only — Handoff +▕$/);
	assert.match(out[2], /^▏ #803 · session_summary · Session summary +▕$/);
	assert.ok(out.some((r) => /the whole text, not only the card/.test(r)));
	await click(/M Active Handoff/);
	assert.equal(await click(/✦ Goal/), true);
	assert.equal(fake.opened.length, 2, "a row of the expanded card opens it too");
	assert.ok(text().some((r) => /✦ Goal/.test(r)), "and leaves the card expanded");
});

test("without Engram's API the handoff pop-up shows the search's text", async () => {
	const fake = fakeUi();
	const { click } = await shown({}, { ui: fake.ui });
	await click(/#803 · 1h ago/);
	const out = (await fake.component()).render(80).map(plain);
	assert.ok(out.some((r) => /Ship the sidebar tabs\./.test(r)));
});

test("the expanded Active Handoff shows the latest session summary from `engram search`", async () => {
	const { text, rows, click } = await shown();
	await click(/M Active Handoff/);
	const out = text();
	const start = out.findIndex((row) => /M Active Handoff/.test(row));
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

test("no Stack · Ecosystem card (no offline source of the latest versions) and no Tools card", async () => {
	const call = (...names) => ({ type: "message", message: { role: "assistant", content: names.map((name, i) => ({ type: "toolCall", id: `t${i}`, name, arguments: {} })) } });
	const { text, calls } = await shown({}, { branch: [call("read", "bash", "grep")] });
	assert.ok(!text().some((row) => /Stack|Ecosystem|Tools|calls/.test(row)));
	assert.ok(!calls.run.some((call) => call[0] === "pi" || call[1] === "version"), "no version probes");
});

// A session branch: the assistant's tool calls and their results, oldest first.
let seq = 0;
const toolCall = (name, args = {}, data, { text, error = false } = {}) => {
	const id = `call-${++seq}`;
	return [
		{ type: "message", id: `a${seq}`, message: { role: "assistant", content: [{ type: "text", text: "…" }, { type: "toolCall", id, name, arguments: args }] } },
		{ type: "message", id: `r${seq}`, message: { role: "toolResult", toolCallId: id, toolName: name, isError: error, content: [{ type: "text", text: text ?? JSON.stringify(data ?? {}) }], ...(data === undefined ? {} : { details: { data } }) } },
	];
};

test("Saved this session lists mem_save and mem_update calls newest first, prefixed names too, with type and an updated marker", async () => {
	const branch = [
		...toolCall("mem_save", { title: "Fixed the gauge rounding", type: "bugfix", content: "**What**: …" }, { id: 41 }),
		...toolCall("read", { path: "x" }, undefined, { text: "file" }),
		...toolCall("mcp__engram__mem_save", { title: "Chose rulesets over branch protection " + "with a very long title ".repeat(3), type: "decision" }, undefined, { text: "Memory saved: observation #42" }),
		...toolCall("mem_update", { id: 7, title: "Tab contract gains onHide", type: "pattern" }, { id: 7 }),
		...toolCall("mem_save", { title: "Failed save", type: "bugfix" }, undefined, { text: "boom", error: true }),
		...toolCall("mem_save_prompt", { content: "not a memory" }, { id: 99 }),
	];
	const { text, rows } = await shown({}, { branch });
	const card = cardOf(text(), "Saved this session");
	assert.equal(card.length, 3, "three saved memories; the failed save and the prompt are left out");
	assert.match(card[0], /^│ pattern Tab contract gains onHide +updated │$/);
	assert.match(card[1], /^│ decision Chose rulesets over branch protection with a \S*… │$/u, "a long title is cut with …");
	assert.equal([...card[1]].length, WIDTH);
	assert.match(card[2], /^│ bugfix Fixed the gauge rounding +│$/);
	const joined = rows().join("");
	assert.ok(painted(joined, "dim", "bugfix"), "the type badge dim");
});

test("Recalled this session lists get_observation, search and context newest first, one row per memory", async () => {
	const branch = [
		...toolCall("mem_context", { project: "my-app" }, { context: "## Recent\n…" }),
		...toolCall("mem_get_observation", { id: 12 }, { id: 12, type: "decision", title: "Use rulesets", content: "Body 12" }),
		...toolCall("mem_search", { query: "sidebar tabs" }, [{ id: 1 }, { id: 2 }, { id: 3 }]),
		...toolCall("mcp__engram__mem_search", { query: "nothing here" }, undefined, { text: "No memories found" }),
		...toolCall("mem_get_observation", { id: 30 }, { id: 30, type: "bugfix", title: "Gauge rounding", content: "Body 30" }),
		...toolCall("mem_get_observation", { id: 12 }, { id: 12, type: "decision", title: "Use rulesets", content: "Body 12" }),
		...toolCall("mem_context", {}, { context: "again" }),
	];
	const { text } = await shown({}, { branch });
	const card = cardOf(text(), "Recalled this session");
	assert.deepEqual(
		card.map((row) => row.replace(/ +/g, " ")),
		["│ ◆ context loaded │", "│ #12 Use rulesets │", "│ #30 Gauge rounding │", '│ ⌕ "nothing here" 0 hits │', '│ ⌕ "sidebar tabs" 3 hits │'],
	);
	assert.match(card[3], /"nothing here" +0 hits │$/, "the hits flush right");
});

test("empty session: Nothing saved yet, Nothing recalled yet", async () => {
	const { text, rows } = await shown();
	assert.equal(cardOf(text(), "Saved this session").length, 1);
	assert.match(cardOf(text(), "Saved this session")[0], /^│ Nothing saved yet +│$/);
	assert.match(cardOf(text(), "Recalled this session")[0], /^│ Nothing recalled yet +│$/);
	assert.ok(painted(rows().join(""), "dim", "Nothing saved yet"));
	assert.equal(scanSession(undefined).saved.length, 0);
});

// A ctx.ui.custom that records the pop-up and builds its component as Pi does.
function fakeUi() {
	const opened = [];
	const tui = { terminal: { rows: 40, columns: 120 }, requestRender: () => {} };
	const ui = { custom: (factory, options) => { opened.push({ factory, options }); return new Promise(() => {}); } };
	const component = async (index = -1) => {
		const c = opened.at(index).factory(tui, theme, {}, () => {});
		await c.ready;
		return c;
	};
	return { ui, opened, component };
}

test("a click on a saved or recalled memory opens it read-only in the pop-up, with its text from Engram", async () => {
	const branch = [
		...toolCall("mem_save", { title: "Fixed the gauge rounding", type: "bugfix", content: "From the call" }, { id: 41 }),
		...toolCall("mem_get_observation", { id: 12 }, { id: 12, type: "decision", title: "Use rulesets", content: "From the result" }),
		...toolCall("mem_search", { query: "tabs" }, [{ id: 1 }]),
	];
	const observations = { 41: { id: 41, type: "bugfix", title: "Fixed the gauge rounding", content: "**What**: the gauge\n\n- rounded down" } };
	const fake = fakeUi();
	const { click, calls } = await shown({ observations }, { branch, ui: fake.ui });
	assert.equal(await click(/bugfix Fixed the gauge rounding/), true);
	assert.equal(fake.opened.length, 1);
	assert.ok(calls.fetch.includes("http://127.0.0.1:7437/observations/41"), "read from the local API");
	let out = (await fake.component()).render(80).map(plain);
	assert.match(out[1], /^▏ Read-only — Memory +▕$/);
	assert.match(out[2], /^▏ #41 · bugfix · Fixed the gauge rounding +▕$/);
	const body = out.slice(4, -2).join("\n");
	assert.match(body, /What: the gauge/, "rendered Markdown, no ** markers");
	assert.match(body, /rounded down/);
	assert.doesNotMatch(out.at(-2), /e edit/, "no editor for a memory");
	const preview = await fake.component();
	preview.handleInput("e");

	// The API knows nothing of #12: the tool result's text is shown.
	await click(/#12 Use rulesets/);
	out = (await fake.component()).render(80).map(plain);
	assert.match(out[2], /#12 · decision · Use rulesets/);
	assert.ok(out.some((row) => /From the result/.test(row)));

	const before = fake.opened.length;
	assert.equal(await click(/"tabs"/), false, "a search row opens nothing");
	assert.equal(fake.opened.length, before);
	assert.ok(!calls.fetch.some((url) => /\/observations\/1$/.test(url)));
	assert.ok(calls.fetch.every((url) => !/mark_reviewed|judge|passive/.test(url)), "only reads (fetchJson is a GET)");
	assert.ok(calls.run.every((call) => call[1] === "search"), "no engram command but the handoff search");
});

test("the Engram card shows pending reviews and conflicts in one warning row, only when there are some", async () => {
	const some = await shown({ review: { count: 3, observations: [{}, {}, {}] }, conflicts: { by_judgment_status: { judged: 4, pending: 1 } } });
	assert.ok(some.calls.fetch.includes("http://127.0.0.1:7437/review?project=my-app&limit=100"));
	assert.ok(some.calls.fetch.includes("http://127.0.0.1:7437/conflicts/stats?project=my-app"));
	assert.ok(some.text().some((row) => /│ ⚑ 3 to review · 1 conflict +│/.test(row)));
	assert.ok(painted(some.rows().join(""), "warning", "⚑ 3 to review · 1 conflict"));
	const conflictsOnly = await shown({ review: { count: 0, observations: [] }, conflicts: { by_judgment_status: { pending: 2 } } });
	assert.ok(conflictsOnly.text().some((row) => /│ ⚑ 2 conflicts +│/.test(row)));
	const none = await shown({ review: { count: 0, observations: [] }, conflicts: { by_judgment_status: { judged: 4 } } });
	assert.ok(!none.text().some((row) => /⚑/.test(row)));
	assert.ok(!(await shown()).text().some((row) => /⚑/.test(row)), "no answer: no row");
});

test("without gentle-engram the Engram and handoff cards are left out", async () => {
	const files = { ...PACKAGES };
	delete files["/agent/npm/node_modules/gentle-engram/package.json"];
	const { text, calls } = await shown({ files }, { tools: ["read"] });
	assert.ok(!text().some((row) => /Engram:|Active Handoff/.test(row)));
	assert.ok(text().some((row) => /Saved this session/.test(row)));
	assert.ok(text().some((row) => /Recalled this session/.test(row)));
	assert.ok(!calls.fetch.length, "no Engram calls");
	assert.ok(!text().some((row) => /Persistent Memory/.test(row)), "no persistent memory card without ~/.memory/memories.db");
});

test("with the outline off the same rows are clickable, and the wheel is left to the column", async () => {
	const { click, text, tab } = await shown({}, { outline: false });
	assert.match(text()[0], /^ M Engram: my-app/);
	assert.ok(text().some((row) => /^ Database \(all projects\) +21\.9 MB$/.test(row)));
	await click(/^ M Engram/);
	assert.ok(text().some((row) => /● 27 memories · 21\.9 MB/.test(row)));
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
	await click(/Engram: my-app/);
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
	assert.ok(painted(tab.render(WIDTH, 40).join(""), "warning", "○ Unreachable"));
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
		while (Date.now() - started < 3000 && !tab.render(WIDTH, 40).map(plain).some((row) => /○ Offline/.test(row))) await new Promise((resolve) => setTimeout(resolve, 50));
		const out = tab.render(WIDTH, 40).map(plain);
		assert.ok(out.some((row) => /○ Offline/.test(row)), "the hanging server times out to Offline");
		assert.equal(await deps.statSize(path.join(dir, "nothing.db")), undefined);
		writeFileSync(path.join(dir, "sized.db"), "x".repeat(1500));
		assert.equal(await deps.statSize(path.join(dir, "sized.db")), 1500);
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
