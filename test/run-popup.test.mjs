import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import * as realFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configFile, load, painted, plain, theme } from "./helpers.mjs";
import { FinishedRecords, findActivityFile, findJobLog, findSessionByCalls, finishedRowStatus, JobLogs, jobRows, parseActivity, presenceDir, readActivity, readTail, readTaskRecord, recordSessionPath, rowRecord, rowTask, SessionFinder, SessionLog, SessionTail, sessionHash, sessionsDir, tasksDir } from "../extensions/sidebar/run-data.ts";
import { fallbackThreadItem, openAgentPopup, openJobPopup, sessionLines } from "../extensions/sidebar/run-popup.ts";

const KEYS = { up: "\x1b[A", down: "\x1b[B", pageUp: "\x1b[5~", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F", escape: "\x1b" };
const hash = (id) => createHash("sha256").update(id).digest("hex");
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

// Stand-ins for gentle-pi's thread renderer (lib/agents-thread-view.ts) and task header (lib/agents-view.ts),
// installed where Pi keeps npm packages, as gentle-pi draws them: a label row, then the content indented.
const agentDir = path.dirname(configFile);
const lib = path.join(agentDir, "npm/node_modules/gentle-pi/lib");
mkdirSync(lib, { recursive: true });
writeFileSync(path.join(lib, "agents-thread-view.ts"), `
export function renderThreadItem(item, theme, width) {
	const cut = (text) => text.slice(0, width);
	if (item.kind === "tool") return [theme.fg(item.isError ? "error" : "accent", cut("Tool · " + item.name + " · " + (item.running ? "Running" : "Complete"))), ...(item.output ? [theme.fg("muted", cut("  Output")), ...item.output.split("\\n").map((line) => theme.fg("muted", cut("    " + line)))] : [])];
	const label = { text: "Text", thinking: "Thinking", note: "Note" }[item.kind];
	return [theme.fg("customMessageLabel", label), ...item.text.split("\\n").map((line) => theme.fg(item.kind === "thinking" ? "dim" : "text", cut("  " + line)))];
}
`);
writeFileSync(path.join(lib, "agents-view.ts"), `
export function taskHeader(task, now) {
	const elapsed = task.startedAt === null ? "" : Math.floor(((task.endedAt ?? now) - task.startedAt) / 1000) + "s";
	return [task.agent, task.status, task.model, elapsed].filter(Boolean).join(" · ");
}
`);
const realLib = {
	renderThreadItem: (await import(path.join(lib, "agents-thread-view.ts"))).renderThreadItem,
	taskHeader: (await import(path.join(lib, "agents-view.ts"))).taskHeader,
};

const now = Date.now();
const summary = (id, agent, label, status, extra = {}) => ({ id, agent, label, status, model: "claude-bridge/claude-opus-5-5", createdAt: now - 80_000, startedAt: status === "queued" ? null : now - 72_000, endedAt: null, lastActivityAt: now - 1000, ...extra });
const thread = (items, dropped = 0) => ({ version: items.length, dropped, items });
const ITEMS = [
	{ kind: "note", text: "gentle-agents: requested tools missing in child: mcp" },
	{ kind: "thinking", text: "I'm going to begin by reading the spec." },
	{ kind: "tool", callId: "t1", name: "bash", output: " M odd/tasks/sidebar-tabs.md\nf461ca4 style(sidebar)", running: false, isError: false },
	{ kind: "text", text: "Spec read. Writing the tests first." },
	{ kind: "tool", callId: "t2", name: "read", output: "", running: true, isError: false },
];
const TASKS = [
	{ summary: summary("w1", "gentle-ai-worker", "subagent popup from Agents card", "running"), thread: thread(ITEMS, 3) },
	{ summary: summary("q1", "gentle-ai-explore", "map the presence files", "queued"), thread: thread([]) },
];

// A presence folder for `sessionId`: one header per incarnation, each with its own activity file.
function presence(dir, sessionId, incarnations) {
	mkdirSync(dir, { recursive: true });
	const sh = hash(sessionId);
	for (const { incarnation, heartbeat, tasks } of incarnations) {
		writeFileSync(path.join(dir, `${sh}.${incarnation}.header.json`), JSON.stringify({ schema: 1, sessionHash: sh, incarnation, label: "worktree", heartbeat, generation: 1, counts: {}, digest: "x", unavailable: null }));
		if (tasks) writeActivity(path.join(dir, `${sh}.${incarnation}.activity.json`), sh, incarnation, tasks);
	}
	return path.join(dir, `${sh}.${incarnations.at(-1).incarnation}.activity.json`);
}
function writeActivity(file, sh, incarnation, tasks, generation = 1) {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify({ schema: 1, sessionHash: sh, incarnation, generation, activity: { tasks } }));
	renameSync(tmp, file); // atomic, as gentle-pi writes it
}

// ---------------------------------------------------------------------------
// run-data.ts
// ---------------------------------------------------------------------------

test("the session's activity file is picked by sha256(session id) and the newest heartbeat", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gq-presence-"));
	assert.equal(sessionHash("abc"), hash("abc"));
	presence(dir, "other-session", [{ incarnation: "zzz", heartbeat: now + 99_999, tasks: [] }]);
	presence(dir, "s1", [
		{ incarnation: "old", heartbeat: now - 60_000, tasks: [] },
		{ incarnation: "new", heartbeat: now, tasks: TASKS },
		{ incarnation: "older", heartbeat: now - 120_000, tasks: [] },
	]);
	assert.equal(findActivityFile(dir, "s1"), path.join(dir, `${hash("s1")}.new.activity.json`));
	assert.equal(findActivityFile(dir, "nobody"), undefined, "no header for the session");
	assert.equal(findActivityFile(path.join(dir, "missing"), "s1"), undefined, "no presence folder");
	assert.equal(findActivityFile(dir, undefined), undefined, "no session id");
	assert.equal(presenceDir("/home/u/.pi/agent"), "/home/u/.pi/agent/gentle-agents/presence");
});

test("a header whose activity file is missing is skipped for the next newest", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gq-presence-"));
	presence(dir, "s1", [{ incarnation: "kept", heartbeat: now - 5000, tasks: [] }, { incarnation: "gone", heartbeat: now }]);
	assert.equal(findActivityFile(dir, "s1"), path.join(dir, `${hash("s1")}.kept.activity.json`));
});

test("tasks are parsed with their summary and thread; malformed files give nothing", () => {
	const tasks = parseActivity(JSON.stringify({ schema: 1, activity: { tasks: TASKS } }));
	assert.equal(tasks.length, 2);
	assert.equal(tasks[0].id, "w1");
	assert.equal(tasks[0].agent, "gentle-ai-worker");
	assert.equal(tasks[0].label, "subagent popup from Agents card");
	assert.equal(tasks[0].status, "running");
	assert.equal(tasks[0].model, "claude-bridge/claude-opus-5-5");
	assert.equal(tasks[0].thread.dropped, 3);
	assert.equal(tasks[0].thread.items.length, 5);
	assert.equal(tasks[1].startedAt, null);
	assert.equal(parseActivity("{not json"), undefined);
	assert.equal(parseActivity(JSON.stringify({ activity: {} })), undefined);
	assert.deepEqual(parseActivity(JSON.stringify({ activity: { tasks: [{ summary: { agent: "no id" } }] } })), [], "a task without an id is dropped");
	const dirty = parseActivity(JSON.stringify({ activity: { tasks: [{ summary: { id: "x", agent: "a" }, thread: { dropped: 0, items: [{ kind: "text", text: "a\x1b[31mred\x07" }] } }] } }));
	assert.ok(!dirty[0].thread.items[0].text.includes("\x1b"), "control characters never reach the terminal");
});

test("readActivity reads a file or says why it cannot", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gq-presence-"));
	const file = presence(dir, "s1", [{ incarnation: "a", heartbeat: now, tasks: TASKS }]);
	assert.equal(readActivity(file).tasks.length, 2);
	assert.ok(readActivity(path.join(dir, "missing.json")).error);
	writeFileSync(path.join(dir, "bad.json"), "{");
	assert.ok(readActivity(path.join(dir, "bad.json")).error);
});

test("an Agents row is matched to its task by agent and label; the newest wins a tie; finished or unknown rows match nothing", () => {
	const tasks = parseActivity(JSON.stringify({ activity: { tasks: [
		...TASKS,
		{ summary: summary("w0", "gentle-ai-worker", "subagent popup from Agents card", "running", { createdAt: now - 200_000, startedAt: now - 190_000 }), thread: thread([]) },
		{ summary: summary("w2", "gentle-ai-worker", "other work", "running", { startedAt: now - 1000 }), thread: thread([]) },
	] } }));
	assert.equal(rowTask("◔ gentle-ai-worker   subagent popup from Agents card   claude-opus-5-5 · 1m12s", tasks), "w1", "the newest of two same tasks");
	assert.equal(rowTask("◐ gentle-ai-worker   subagent popup from Agen…  claude-opus-5-5 · 1m12s", tasks), "w1", "a label cut by gentle-pi");
	assert.equal(rowTask("◔ gentle-ai-worker   other work   1s", tasks), "w2");
	assert.equal(rowTask("○ gentle-ai-explore  map the presence files   queued", tasks), "q1");
	assert.equal(rowTask("✓ gentle-ai-worker   subagent popup from Agents card   1m12s", tasks), undefined, "a finished row");
	assert.equal(rowTask("◔ gentle-ai-review   subagent popup from Agents card   1m12s", tasks), undefined, "an agent not in the file");
	assert.equal(rowTask("◈ Agents ▾ Collapse  2 active", tasks), undefined, "the title");
	assert.equal(rowTask("… 2 more", tasks), undefined);
	assert.equal(rowTask("◔ gentle-ai-explore   12k · 1m12s", tasks), undefined, "a running row of an agent that is only queued");
	assert.equal(rowTask("○ gentle-ai-explore   · queued", tasks), "q1", "a narrow row without its label: agent and status");
});

// ---------------------------------------------------------------------------
// The popup (run-popup.ts)
// ---------------------------------------------------------------------------

// A ctx whose ui.custom records the overlay, and a TUI as tall as `rows`.
function fakeCtx(rows = 30) {
	const calls = { custom: [], done: [], renders: [] };
	const tui = { terminal: { rows, columns: 120 }, requestRender: (force) => calls.renders.push(force === true) };
	const ctx = { hasUI: true, ui: { custom: (factory, options) => (calls.custom.push({ factory, options }), new Promise(() => {})) } };
	const component = () => calls.custom.at(-1).factory(tui, theme, {}, (value) => calls.done.push(value));
	return { ctx, tui, calls, component };
}

function popup({ tasks = TASKS, rows = 30, lib: given = realLib, taskId = "w1" } = {}) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gq-presence-"));
	const file = presence(dir, "s1", [{ incarnation: "a", heartbeat: now, tasks }]);
	const fake = fakeCtx(rows);
	const opened = openAgentPopup(fake.ctx, { file, taskId, lib: given, interval: 60_000 });
	const component = opened ? fake.component() : undefined;
	const text = (width = 80) => component.render(width).map(plain);
	const update = (next, generation = 2) => writeActivity(file, hash("s1"), "a", next, generation);
	return { ...fake, opened, component, file, text, update };
}

test("the popup asks Pi for a centered overlay sized like the file preview", () => {
	const { calls, opened } = popup();
	assert.equal(opened, true);
	const { options } = calls.custom[0];
	assert.equal(options.overlay, true);
	const { width, ...rest } = options.overlayOptions();
	assert.deepEqual(rest, { anchor: "center", minWidth: 60, maxHeight: "85%" });
	assert.equal(width, 78, "65% of 120 columns");
});

test("the popup draws the task header, its label, the dropped line and the thread with gentle-pi's renderer", () => {
	const { text, component } = popup();
	const out = text(80);
	assert.ok(out.every((row) => [...row].length === 80), "every row as wide as the overlay");
	assert.match(out[0], /^🭽▔+🭾$/u);
	assert.match(out.at(-1), /^🭼▁+🭿$/u);
	assert.match(out[1], /^▏ gentle-ai-worker · running · claude-bridge\/claude-opus-5-5 · 7\ds +▕$/);
	assert.match(out[2], /^▏ subagent popup from Agents card +▕$/);
	const body = out.slice(4, -2).map((row) => row.slice(2, -2).trimEnd());
	const start = body.indexOf("… 3 earlier items not kept");
	assert.ok(start >= 0, "the dropped items line");
	assert.deepEqual(body.slice(start, start + 12), [
		"… 3 earlier items not kept",
		"Note",
		"  gentle-agents: requested tools missing in child: mcp",
		"Thinking",
		"  I'm going to begin by reading the spec.",
		"Tool · bash · Complete",
		"  Output",
		"     M odd/tasks/sidebar-tabs.md",
		"    f461ca4 style(sidebar)",
		"Text",
		"  Spec read. Writing the tests first.",
		"Tool · read · Running",
	]);
	assert.equal(out.length, 25, "85% of 30 rows, whatever the thread's length");
	assert.match(out.at(-2), /^▏ Esc close · ↑↓ PgUp\/PgDn Home\/End · following +▕$/);
	const raw = component.render(80);
	assert.ok(painted(raw[1], "toolTitle"), "the header in the title color");
	assert.ok(painted(raw[2], "muted", "subagent popup"));
	assert.ok(raw.some((row) => painted(row, "accent", "Tool · bash")), "gentle-pi's renderer paints the thread");
});

test("without gentle-pi's renderer the thread is drawn by the fallback, the same way", () => {
	const { text } = popup({ lib: null });
	const out = text(80);
	assert.match(out[1], /^▏ gentle-ai-worker · running · claude-bridge\/claude-opus-5-5 · 1m1\ds +▕$/);
	const body = out.map((row) => row.slice(2, -2).trimEnd());
	for (const row of ["Thinking", "  I'm going to begin by reading the spec.", "Tool · bash · Complete", "  Output", "    f461ca4 style(sidebar)", "Tool · read · Running"]) assert.ok(body.includes(row), row);
	assert.deepEqual(fallbackThreadItem({ kind: "tool", name: "x", output: "", running: false, isError: true }, theme, 40).map(plain), ["Tool · x · Error"]);
	assert.deepEqual(fallbackThreadItem({ kind: "weird" }, theme, 40), []);
});

const longThread = (count) => Array.from({ length: count }, (_, i) => ({ kind: "text", text: `line ${i + 1}` }));
const LONG = [{ summary: summary("w1", "gentle-ai-worker", "long job", "running"), thread: thread(longThread(30)) }];

test("the popup follows the end; scrolling up stops following, End or f resumes", () => {
	const { component, text } = popup({ tasks: LONG });
	const shown = () => text(80).slice(4, -2).map((row) => row.slice(2, -2).trimEnd()).filter(Boolean);
	const lastLine = () => shown().filter((row) => row.startsWith("  line")).at(-1);
	assert.equal(shown().at(-1), "  line 30", "the end of the thread");
	assert.match(text(80).at(-2), /following/);
	component.handleInput(KEYS.up);
	assert.equal(lastLine(), "  line 29", "one row up");
	assert.match(text(80).at(-2), /f follow/);
	component.handleInput(KEYS.pageUp);
	component.handleInput(KEYS.home);
	assert.equal(shown()[0], "Text", "the top of the thread");
	component.handleInput(KEYS.down);
	assert.equal(shown()[0], "  line 1");
	component.handleInput(KEYS.end);
	assert.equal(shown().at(-1), "  line 30");
	assert.match(text(80).at(-2), /following/);
	component.handleMouse({ type: "wheel", wheelDelta: -1, x: 3, y: 5 });
	assert.equal(lastLine(), "  line 28", "the wheel scrolls three rows");
	assert.match(text(80).at(-2), /f follow/);
	component.handleInput(KEYS.up);
	component.handleInput("f");
	assert.equal(shown().at(-1), "  line 30");
	assert.match(text(80).at(-2), /following/);
});

test("the popup re-reads the file and redraws: it keeps following the end, or keeps its place when scrolled up", () => {
	const { component, text, update, calls } = popup({ tasks: LONG });
	const shown = () => text(80).slice(4, -2).map((row) => row.slice(2, -2).trimEnd()).filter(Boolean);
	update([{ ...LONG[0], thread: thread(longThread(34)) }]);
	const before = calls.renders.length;
	component.refresh();
	assert.ok(calls.renders.length > before, "a change asks for a redraw");
	assert.equal(shown().at(-1), "  line 34", "new items while following");
	component.handleInput(KEYS.pageUp);
	const kept = shown();
	update([{ ...LONG[0], thread: thread(longThread(40)) }], 3);
	component.refresh();
	assert.deepEqual(shown(), kept, "scrolled up: the view stays where it was");
	component.handleInput("f");
	assert.equal(shown().at(-1), "  line 40");
});

test("the popup polls the file on its own while open, and stops once closed", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gq-presence-"));
	const file = presence(dir, "s1", [{ incarnation: "a", heartbeat: now, tasks: LONG }]);
	const fake = fakeCtx(30);
	openAgentPopup(fake.ctx, { file, taskId: "w1", lib: realLib, interval: 10 });
	const component = fake.component();
	writeActivity(file, hash("s1"), "a", [{ ...LONG[0], thread: thread(longThread(31)) }], 2);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.ok(component.render(80).map(plain).some((row) => row.includes("line 31")));
	component.handleInput("q");
	writeActivity(file, hash("s1"), "a", [{ ...LONG[0], thread: thread(longThread(32)) }], 3);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.ok(!component.render(80).map(plain).some((row) => row.includes("line 32")), "no reads after closing");
});

test("when the task leaves the file the popup keeps its last thread and says finished", () => {
	const { component, text, update, file } = popup();
	update([TASKS[1]]);
	component.refresh();
	const out = text(80);
	assert.match(out[1], /^▏ gentle-ai-worker · finished · claude-bridge\/claude-opus-5-5 · /);
	assert.ok(out.some((row) => row.includes("Spec read. Writing the tests first.")), "the last thread stays");
	rmSync(file, { force: true });
	component.refresh();
	assert.match(text(80)[1], /finished/, "still finished, still open");
});

test("a file that cannot be read for a moment keeps the last thread as it was", () => {
	const { component, text, file } = popup();
	writeFileSync(file, "{ half written");
	component.refresh();
	assert.match(text(80)[1], / · running · /);
	assert.ok(text(80).some((row) => row.includes("Spec read.")));
});

test("Esc and q close the popup and repaint behind it", () => {
	for (const key of [KEYS.escape, "q"]) {
		const { component, calls } = popup();
		component.handleInput(key);
		assert.equal(calls.done.length, 1);
		assert.ok(calls.renders.includes(true));
	}
});

test("the popup does not open, and says so, without an overlay UI or when the task is not in the file", () => {
	assert.equal(popup({ taskId: "nope" }).opened, false);
	assert.equal(openAgentPopup({ hasUI: true, ui: {} }, { file: "/x", taskId: "w1" }), false);
	assert.equal(openAgentPopup(undefined, { file: "/x", taskId: "w1" }), false);
	const dir = mkdtempSync(path.join(os.tmpdir(), "gq-presence-"));
	assert.equal(openAgentPopup(fakeCtx().ctx, { file: path.join(dir, "missing.json"), taskId: "w1" }), false);
});

test("render never throws, even with a renderer that does", () => {
	const { text } = popup({ lib: { renderThreadItem: () => { throw new Error("boom"); }, taskHeader: () => { throw new Error("boom"); } } });
	const out = text(80);
	assert.equal(out.length, 25);
	assert.match(out[1], /gentle-ai-worker · running/, "the fallback header");
});

// A TUI routing the mouse as Pi 1.4.0 does (see tree-preview.test.mjs): an overlay gets a press only inside
// its box; the release and the click go to whatever answered the press.
class MouseTui {
	constructor(rows = 30) {
		this.terminal = { rows, columns: 120 };
		this.overlays = [];
		this.layoutEvents = [];
		this.renders = [];
	}
	requestRender(force) {
		this.renders.push(force === true);
	}
	getTopmostVisibleOverlay() {
		return this.overlays.at(-1);
	}
	dispatchMouseToOverlay(event) {
		for (const layout of [...this.overlays].reverse()) {
			if (event.screenX < layout.col || event.screenX >= layout.col + layout.width || event.screenY < layout.row || event.screenY >= layout.row + layout.height) continue;
			const result = layout.component.handleMouse?.({ ...event, x: event.screenX - layout.col, y: event.screenY - layout.row });
			return result ? { hit: true, result: { ...result, target: { component: layout.component } } } : { hit: true };
		}
		return { hit: false };
	}
	layout(event) {
		this.layoutEvents.push(event.type);
		return { handled: true, target: { component: { handleMouse: (e) => (this.layoutEvents.push(e.type), { handled: true }) } } };
	}
	click(x, y) {
		const event = (kind) => ({ type: kind, button: "left", x, y, screenX: x, screenY: y, width: this.terminal.columns, height: this.terminal.rows });
		const overlay = this.dispatchMouseToOverlay(event("press"));
		const result = overlay.result ?? (overlay.hit ? undefined : this.layout(event("press")));
		if (!result) return;
		for (const kind of ["release", "click"]) result.target.component.handleMouse?.(event(kind));
	}
}

test("a click outside the popup closes it and reaches nothing under it; inside it stays open", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gq-presence-"));
	const file = presence(dir, "s1", [{ incarnation: "a", heartbeat: now, tasks: TASKS }]);
	const tui = new MouseTui(30);
	const done = [];
	const ctx = { hasUI: true, ui: { custom: (factory) => {
		const entry = { col: 30, row: 2, width: 60, height: 20 };
		entry.component = factory(tui, theme, {}, (value) => {
			done.push(value);
			tui.overlays = tui.overlays.filter((other) => other !== entry);
		});
		tui.overlays.push(entry);
		return new Promise(() => {});
	} } };
	assert.equal(openAgentPopup(ctx, { file, taskId: "w1", lib: realLib, interval: 60_000 }), true);
	tui.click(50, 10);
	assert.equal(done.length, 0, "inside");
	tui.click(5, 10);
	assert.equal(done.length, 1, "outside closes");
	assert.deepEqual(tui.layoutEvents, [], "that click reaches nothing");
	assert.ok(!Object.hasOwn(tui, "dispatchMouseToOverlay"), "Pi's own routing is back");
});

// ---------------------------------------------------------------------------
// The Agents card above the editor (gentle-quiet.ts)
// ---------------------------------------------------------------------------

const presenceRoot = presenceDir(agentDir);
// gentle-pi's Agents card as gentle-agents draws it: title, one row per task with its metadata right-aligned
// in the same column, then "… N more". Its own clicks only act on the title row.
const CARD = [
	"   ❀ Agents ▾ Collapse  1 active · 1 queued · 1 done",
	"   ◐  gentle-ai-worker   subagent popup from Agents card    claude-opus-5-5 · high · 12k · 1m12s",
	"   ○  gentle-ai-explore  map the presence files                                         queued",
	"   ✓  gentle-ai-explore  map files                          claude-opus-5-5 · high · 12k · 1m11s",
	"   … 1 more",
];

async function agentsCard(sessionId, { tasks = TASKS, custom } = {}) {
	if (tasks) presence(presenceRoot, sessionId, [{ incarnation: "i1", heartbeat: now, tasks }]);
	const opened = [];
	const loaded = await load({ mode: "tui", session: { id: sessionId }, custom: custom !== undefined ? custom : ((factory, options) => (opened.push({ factory, options }), new Promise(() => {}))) });
	const seen = [];
	loaded.ui.setWidget("gentle-agents", () => ({ render: () => CARD, handleMouse: (event) => (seen.push(event), { handled: true, from: "gentle-pi" }) }));
	const tui = { terminal: { rows: 30, columns: 120 }, requestRender() {} };
	const card = loaded.widgets["gentle-agents"](tui, theme);
	card.render(100); // the first draw asks for the presence file
	await settle();
	const rows = () => card.render(100).map(plain);
	const mouse = (type, y, button = "left") => card.handleMouse({ type, button, x: 10, y, width: 100, height: 8, screenX: 10, screenY: y });
	return { ...loaded, card, rows, mouse, seen, opened, tui };
}

test("the running and queued rows of the Agents card end with ↗; the title, finished and more rows do not", async () => {
	const { rows, card } = await agentsCard("card-1");
	const out = rows();
	assert.ok(out.every((row) => [...row].length === 100), "no row wider than the card");
	assert.match(out[2], /^│ ◔ gentle-ai-worker .* 1m12s ↗ +│$/);
	assert.match(out[3], /^│ ○ gentle-ai-explore .* queued ↗ +│$/);
	assert.doesNotMatch(out[1], /↗/, "the title");
	assert.doesNotMatch(out[4], /↗/, "a finished task");
	assert.doesNotMatch(out[5], /↗/, "… 1 more");
	assert.ok(painted(card.render(100)[2], "accent", "↗"), "the ↗ in the accent color");
	// The metadata keeps its column: the rows read as they do with nothing running.
	const { rows: bare } = await agentsCard("card-empty", { tasks: [] });
	assert.deepEqual(out.map((row) => row.replace(" ↗", "  ")), bare(), "only trailing padding was replaced");
});

test("a row as wide as the card gives its last column to the ↗ and never grows", async () => {
	const { card } = await agentsCard("card-full");
	const out = card.render(60).map(plain);
	assert.ok(out.every((row) => [...row].length === 60), "no row wider than the card");
	assert.match(out[2], /^│ ◔ gentle-ai-worker .*…↗ │$/, "a cut row ends in the ↗");
	assert.doesNotMatch(out[4], /↗/);
});

test("a left click on a ↗ row opens the popup for that task and is not passed on; other clicks reach gentle-pi", async () => {
	const { mouse, seen, opened, sent } = await agentsCard("card-click");
	for (const type of ["press", "release", "click"]) assert.equal(mouse(type, 2)?.handled, true);
	assert.equal(opened.length, 1, "one popup");
	assert.deepEqual(seen, [], "gentle-pi saw none of it");
	assert.deepEqual(sent, []);
	const tui = { terminal: { rows: 30, columns: 120 }, requestRender() {} };
	const popupRows = opened[0].factory(tui, theme, {}, () => {}).render(80).map(plain);
	assert.match(popupRows[1], /gentle-ai-worker · running/);
	mouse("click", 3);
	assert.equal(opened.length, 2, "the queued row opens its own popup");
	assert.match(plain(opened[1].factory(tui, theme, {}, () => {}).render(80)[1]), /gentle-ai-explore · queued/);
	assert.equal(mouse("click", 1)?.from, "gentle-pi", "the title row still collapses the card");
	assert.equal(mouse("click", 4)?.from, "gentle-pi", "a finished row");
	assert.equal(mouse("click", 2, "right")?.from, "gentle-pi", "another button");
	assert.equal(mouse("wheel", 2)?.from, "gentle-pi");
	assert.equal(opened.length, 2);
});

test("a click on a ↗ row whose task has left the file opens gentle-pi's list instead", async () => {
	const { mouse, opened, sent } = await agentsCard("card-gone");
	presence(presenceRoot, "card-gone", [{ incarnation: "i1", heartbeat: now, tasks: [] }]);
	mouse("click", 2);
	assert.equal(opened.length, 0);
	assert.deepEqual(sent, [["/gentle:agents", { expandPromptTemplates: true }]]);
});

test("without a presence file the running rows still get ↗ and a click opens gentle-pi's list", async () => {
	const { rows, mouse, opened, sent, seen } = await agentsCard("card-nofile", { tasks: null });
	const out = rows();
	assert.match(out[2], /1m12s ↗ +│$/);
	assert.match(out[3], /queued ↗ +│$/);
	assert.doesNotMatch(out[4], /↗/);
	mouse("click", 2);
	assert.equal(opened.length, 0);
	assert.deepEqual(seen, []);
	assert.deepEqual(sent, [["/gentle:agents", { expandPromptTemplates: true }]]);
});

test("without an overlay UI a click on a ↗ row opens gentle-pi's list", async () => {
	const { mouse, sent } = await agentsCard("card-noui", { custom: null });
	mouse("click", 2);
	assert.deepEqual(sent, [["/gentle:agents", { expandPromptTemplates: true }]]);
});

// ---------------------------------------------------------------------------
// Jobs (T31): the job's log found through /proc, its popup, the ↗ on the Jobs card
// ---------------------------------------------------------------------------

// A /proc/self/fd listing: fd -> link target, or an Error for a link that cannot be read.
function fds(links) {
	return {
		readdir: () => Object.keys(links),
		readlink: (file) => {
			const target = links[path.basename(file)];
			if (target instanceof Error) throw target;
			return target;
		},
	};
}

test("the fd scan picks the log of the exact job id; other links, unreadable fds and other systems give nothing", () => {
	const proc = fds({
		0: "/dev/pts/3",
		3: "socket:[12345]",
		4: "/tmp/gentle-jobs-Ab12/job-10.log",
		5: new Error("EACCES"),
		6: "/tmp/gentle-jobs-Ab12/job-1.log",
		7: "/tmp/other/job-2.log",
		8: "/tmp/gentle-jobs-Ab12/job-3.log (deleted)",
	});
	assert.equal(findJobLog("job-1", proc), "/tmp/gentle-jobs-Ab12/job-1.log", "job-1, not job-10");
	assert.equal(findJobLog("job-10", proc), "/tmp/gentle-jobs-Ab12/job-10.log");
	assert.equal(findJobLog("job-2", proc), undefined, "outside a gentle-jobs folder");
	assert.equal(findJobLog("job-3", proc), undefined, "a deleted file");
	assert.equal(findJobLog("job-1", { ...proc, platform: "darwin" }), undefined, "no /proc off Linux");
	assert.equal(findJobLog("job-1", { readdir: () => { throw new Error("ENOENT"); }, readlink: () => "" }), undefined);
	assert.equal(findJobLog("job.1", fds({ 4: "/tmp/gentle-jobs-Ab12/jobx1.log" })), undefined, "the id is matched literally");
});

test("a job's log path is remembered once seen, and its folder serves jobs whose stream has closed", () => {
	const links = { 4: "/tmp/gentle-jobs-Ab12/job-1.log" };
	const existing = new Set(["/tmp/gentle-jobs-Ab12/job-1.log", "/tmp/gentle-jobs-Ab12/job-5.log"]);
	const logs = new JobLogs({ ...fds(links), exists: (file) => existing.has(file) });
	assert.equal(logs.find("job-1"), "/tmp/gentle-jobs-Ab12/job-1.log");
	delete links[4]; // the job finished: gentle-pi closed its stream
	assert.equal(logs.find("job-1"), "/tmp/gentle-jobs-Ab12/job-1.log", "the remembered path");
	assert.equal(logs.find("job-5"), "/tmp/gentle-jobs-Ab12/job-5.log", "a log in the remembered folder");
	assert.equal(logs.find("job-6"), undefined, "no such log there");
	assert.equal(new JobLogs({ ...fds({}), exists: () => true }).find("job-1"), undefined, "nothing seen yet");
});

test("the log tail reads only the end of a big file, drops its cut first line and every escape sequence", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gq-tail-"));
	const file = path.join(dir, "job-1.log");
	writeFileSync(file, "\x1b[32mgreen\x1b[39m done\n\ttabbed\nprogress 10%\rprogress 100%\n\x1b]8;;http://x\x07link\x1b]8;;\x07 bell\x07\n");
	const tail = readTail(file);
	assert.deepEqual(tail.lines, ["green done", "    tabbed", "progress 100%", "link bell"]);
	assert.equal(tail.cut, false);
	assert.ok(tail.stamp);
	writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`).join("\n") + "\n");
	const cut = readTail(file, 95); // the last 95 bytes: part of a line, then the last ten
	assert.equal(cut.cut, true);
	assert.deepEqual(cut.lines, Array.from({ length: 10 }, (_, i) => `line ${String(91 + i).padStart(3, "0")}`), "the partial first line is dropped");
	assert.ok(readTail(path.join(dir, "missing.log")).error);
	writeFileSync(file, "");
	assert.deepEqual(readTail(file).lines, []);
});

test("job rows are matched to running jobs by label, the newest first, each job once", () => {
	const jobs = [
		{ id: "job-1", label: "npm run build", startedAt: now - 12_000 },
		{ id: "job-2", label: "npm test", startedAt: now - 3_000 },
		{ id: "job-3", label: "npm test", startedAt: now - 1_000 },
		{ id: "job-4", label: "done", startedAt: now - 9_000, status: "exited", endedAt: now - 1000, exitCode: 0 },
	];
	assert.deepEqual(jobRows(["⧗ Jobs ▾ Collapse  4 jobs", "", "⠋ npm test   1s", "⠙ npm test   3s", "⠹ npm run build   12s", "✓ done   8s", "… 1 more"], jobs), [undefined, undefined, "job-3", "job-2", "job-1", undefined, undefined]);
	assert.deepEqual(jobRows(["⧗ Jobs", "⠋ npm run b…   12s"], jobs), [undefined, "job-1"], "a label cut by the card");
	assert.deepEqual(jobRows(["⧗ Jobs", "⠋ npm lint   12s"], jobs), [undefined, undefined], "a job that is not running");
});

function jobPopup({ job, log = "first\nsecond\n", rows = 30 } = {}) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gentle-jobs-"));
	const file = path.join(dir, `${job.id}.log`);
	writeFileSync(file, log);
	let current = job;
	const fake = fakeCtx(rows);
	const opened = openJobPopup(fake.ctx, { file, id: job.id, job: () => current, interval: 60_000 });
	const component = opened ? fake.component() : undefined;
	const text = (width = 80) => component.render(width).map(plain);
	const body = (width = 80) => text(width).slice(4, -2).map((row) => row.slice(2, -2).trimEnd()).filter(Boolean);
	return { ...fake, opened, component, file, text, body, set: (next) => (current = next) };
}

test("the job popup shows label · id, running and the elapsed time, and the log's tail", () => {
	const { opened, calls, text, body, component } = jobPopup({ job: { id: "job-2", label: "npm test", startedAt: now - 3_000 } });
	assert.equal(opened, true);
	assert.deepEqual(calls.custom[0].options.overlayOptions().width, 78, "sized like the other pop-ups");
	const out = text(80);
	assert.ok(out.every((row) => [...row].length === 80));
	assert.match(out[1], /^▏ npm test · job-2 +▕$/);
	assert.match(out[2], /^▏ running · [34]s +▕$/);
	assert.deepEqual(body(), ["first", "second"]);
	assert.match(out.at(-2), /Esc close · ↑↓ PgUp\/PgDn Home\/End · following/);
	assert.ok(painted(component.render(80)[1], "toolTitle"));
});

test("the job popup follows the log as it grows, scrolls, and shows finished with the exit code", () => {
	const lines = Array.from({ length: 40 }, (_, i) => `out ${i + 1}`).join("\n") + "\n";
	const job = { id: "job-1", label: "npm run build", startedAt: now - 12_000 };
	const { component, body, text, file, set } = jobPopup({ job, log: lines });
	assert.equal(body().at(-1), "out 40", "the end of the log");
	writeFileSync(file, `${lines}out 41\n`);
	component.refresh();
	assert.equal(body().at(-1), "out 41", "the new line, followed");
	component.handleInput(KEYS.pageUp);
	assert.match(text().at(-2), /f follow/);
	component.handleInput("f");
	assert.equal(body().at(-1), "out 41");
	set({ ...job, status: "failed", endedAt: now - 2_000, exitCode: 1 });
	component.refresh();
	assert.match(text()[2], /^▏ finished · exit 1 · 10s +▕$/);
	set(undefined); // the card dropped the finished job
	component.refresh();
	assert.match(text()[2], /finished · exit 1 · 10s/, "the last known state stays");
	component.handleInput("\x1b");
	assert.equal(component.closed, true);
});

test("a long log line is cut to the popup's width; an empty log says so", () => {
	const { text } = jobPopup({ job: { id: "job-1", label: "x", startedAt: now }, log: `${"y".repeat(300)}\n` });
	assert.match(text(80)[4], /^▏ y+… ▕$/);
	const empty = jobPopup({ job: { id: "job-1", label: "x", startedAt: now }, log: "" });
	assert.deepEqual(empty.body(), ["(no output yet)"]);
});

// The side column with the Jobs card, as jobs-card.test.mjs builds it: gentle-pi's jobs files stand-ins and
// Gentle Shell off in settings.json.
writeFileSync(path.join(lib, "jobs-sidebar-state.ts"), `
export const JOBS_SIDEBAR_EVENT = "gentle-ai:jobs-sidebar";
export const jobsCollapseKey = () => "ctrl+shift+j";
export const isJobsSidebarSnapshot = (value) => Array.isArray(value?.jobs);
`);
writeFileSync(path.join(lib, "jobs-widget.ts"), `
export function renderJobsCard(jobs, theme, width, now, options) {
	const running = jobs.filter((job) => job.status === undefined).sort((a, b) => b.startedAt - a.startedAt);
	const shown = [...running, ...jobs.filter((job) => job.status !== undefined)];
	if (shown.length === 0) return [];
	const mark = (job) => (job.status === undefined ? theme.fg("accent", "⧗") : job.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗"));
	const row = (job) => {
		const elapsed = Math.round(((job.status === undefined ? now : job.endedAt) - job.startedAt) / 1000) + "s";
		const head = "⧗  " + job.label;
		return "   " + mark(job) + head.slice(1) + " ".repeat(Math.max(1, width - 5 - head.length - elapsed.length)) + theme.fg("dim", elapsed);
	};
	const listed = options.collapsed ? [shown[0]] : shown;
	const control = options.collapseControl ? (options.collapsed ? " ▸ Expand" : " ▾ Collapse") : "";
	return ["   ⧗ Jobs" + control + "  " + shown.length + " jobs", ...listed.map(row)];
}
`);
writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:gentle-pi", extensions: ["-extensions/gentle-shell.ts"] }] }));

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
async function jobsColumn(custom) {
	const opened = [];
	const loaded = await load({ mode: "tui", session: { id: "jobs-session", cwd: "/srv/app" }, custom: custom !== undefined ? custom : (factory, options) => (opened.push({ factory, options }), new Promise(() => {})) });
	const native = { type: "vstack", entries: [] };
	const root = { render: () => [], [NODE]: () => native };
	const tui = { terminal: { columns: 180, rows: 40 }, mode: "fullscreen", layoutRoot: root, requestRender() {} };
	loaded.footer()?.(tui, theme, { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} });
	const todoClicks = [];
	loaded.ui.setWidget("gentle-todo", () => ({ render: (width) => ["   ❀ Todos  0 of 1", "   ○ Test it"].map((row) => row.padEnd(width)), handleMouse: (event) => (event.type === "click" ? (todoClicks.push(event.y), { handled: true }) : undefined) }));
	loaded.widgets["gentle-todo"](tui, theme);
	const rail = () => root[NODE]().entries?.[1]?.component?.[NODE]?.().entries?.[2]?.component;
	const rows = () => rail()?.render(60).map(plain) ?? [];
	const mouse = (type, y) => rail().handleMouse({ type, button: "left", x: 10, y, width: 60, height: 30, screenX: 130, screenY: y });
	const publish = (jobs) => loaded.events.emit("gentle-ai:jobs-sidebar", { sessionId: "jobs-session", snapshot: { jobs } });
	return { ...loaded, rows, mouse, publish, opened, todoClicks, tui };
}

// A real gentle-jobs folder with the job's log held open by this process, as gentle-pi's WriteStream holds it.
function runningLog(id, text) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gentle-jobs-"));
	const file = path.join(dir, `${id}.log`);
	writeFileSync(file, text);
	return { file, fd: openSync(file, "a") };
}

test("running job rows of the Jobs card end with ↗ without widening them; the title, a blank row and finished rows do not", async () => {
	const { publish, rows } = await jobsColumn();
	// The card counts from the clock it draws with, not the file's load time: under a loaded suite they differ.
	const at = Date.now();
	publish([{ id: "job-7", label: "npm run build", startedAt: at - 12_000 }, { id: "job-8", label: "npm test", startedAt: at - 9_000, status: "exited", endedAt: at - 1_000, exitCode: 0 }]);
	const out = rows();
	assert.ok(out.slice(0, 6).every((row) => [...row].length === [...out[0]].length), "every row as wide as the card");
	assert.match(out[1], /^│ ⧗ Jobs ▾ Collapse {2}2 jobs +│$/u);
	assert.doesNotMatch(out[1], /↗/);
	assert.match(out[3], /^│ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] npm run build +1[23]s ?↗ │$/u, "in the padding past the elapsed time");
	assert.match(out[4], /^│ ✓ npm test +8s +│$/u, "a finished job keeps its row");
	assert.doesNotMatch(out[4], /↗/);
	const end = (row) => { const m = /\d+s/.exec(row); return m.index + m[0].length; };
	assert.equal(end(out[3]), end(out[4]), "the elapsed column does not move");
});

test("a click on a running job row opens its popup; the title still collapses; the Todos card still gets its clicks", async (t) => {
	const { file, fd } = runningLog("job-21", "compiling\nlinking\n");
	t.after(() => closeSync(fd));
	const { publish, rows, mouse, opened, sent, todoClicks } = await jobsColumn();
	publish([{ id: "job-21", label: "npm run build", startedAt: now - 12_000 }, { id: "job-22", label: "done", startedAt: now - 9_000, status: "exited", endedAt: now - 1_000, exitCode: 0 }]);
	rows();
	for (const type of ["press", "release", "click"]) assert.equal(mouse(type, 3)?.handled, true, type);
	assert.equal(opened.length, 1, "one popup");
	assert.deepEqual(sent, []);
	const popupRows = opened[0].factory({ terminal: { rows: 30, columns: 120 }, requestRender() {} }, theme, {}, () => {}).render(80).map(plain);
	assert.match(popupRows[1], /npm run build · job-21/);
	assert.match(popupRows[2], /running · 1\ds/);
	assert.ok(popupRows.some((row) => row.includes("linking")), `the log of ${file}`);
	assert.match(rows()[1], /Jobs ▾ Collapse/, "a row click is not the collapse control");
	assert.equal(mouse("click", 4)?.handled, undefined, "a finished row does nothing");
	assert.equal(opened.length, 1);
	const todoTitle = rows().findIndex((row) => row.includes("Todos"));
	assert.equal(mouse("click", todoTitle)?.handled, true, "the Todos title");
	assert.equal(todoClicks.length, 1);
	assert.equal(mouse("click", 1)?.handled, true);
	assert.match(rows()[1], /Jobs ▸ Expand/, "the title still collapses the card");
});

test("a running job without a log the Pi process holds opens gentle-pi's jobs list", async () => {
	const { publish, rows, mouse, opened, sent } = await jobsColumn();
	publish([{ id: "job-404", label: "npm run lint", startedAt: now - 2_000 }]);
	rows();
	assert.equal(mouse("click", 3)?.handled, true);
	assert.equal(opened.length, 0);
	assert.deepEqual(sent, [["/gentle:jobs", { expandPromptTemplates: true }]]);
});

test("without an overlay UI a running job row opens gentle-pi's jobs list", async (t) => {
	const { fd } = runningLog("job-31", "x\n");
	t.after(() => closeSync(fd));
	const { publish, rows, mouse, sent } = await jobsColumn(null);
	publish([{ id: "job-31", label: "npm run build", startedAt: now - 2_000 }]);
	rows();
	mouse("click", 3);
	assert.deepEqual(sent, [["/gentle:jobs", { expandPromptTemplates: true }]]);
});

// ---------------------------------------------------------------------------
// T34 (S16): the subagent's own session file, drawn in the quiet tool look
// ---------------------------------------------------------------------------

// A child Pi session as gentle-agents writes it (<agent dir>/gentle-agents/sessions/<time>_<uuid>.jsonl): a header,
// model changes, the system prompt, the task prompt, then assistant messages with thinking, text and tool calls, and
// one toolResult message per call. `p` prefixes the tool call ids, so each test has its own.
const message = (msg, id) => JSON.stringify({ type: "message", id, parentId: null, timestamp: new Date(now).toISOString(), message: msg });
const sessionEntries = (p) => [
	JSON.stringify({ type: "session", version: "3", id: `child-${p}`, timestamp: new Date(now).toISOString(), cwd: "/srv/app" }),
	JSON.stringify({ type: "model_change", id: "m1", parentId: null, provider: "claude-bridge", modelId: "claude-opus-5-5" }),
	message({ role: "system", sections: { preamble: "You are…" } }, "e0"),
	message({ role: "user", content: [{ type: "text", text: "Implement T34\nRead the spec first." }] }, "e1"),
	message({ role: "assistant", content: [{ type: "thinking", thinking: "Reading the spec first." }, { type: "toolCall", id: `${p}1`, name: "bash", arguments: { command: "git status --short" } }] }, "e2"),
	message({ role: "toolResult", toolCallId: `${p}1`, toolName: "bash", content: [{ type: "text", text: " M a.ts\n M b.ts" }], isError: false, durationMs: 1200 }, "e3"),
	message({ role: "assistant", content: [{ type: "text", text: "Spec **read**. Writing the tests." }, { type: "toolCall", id: `${p}2`, name: "read", arguments: { path: "/srv/app/a.ts", offset: 1, limit: 2 } }, { type: "toolCall", id: `${p}3`, name: "bash", arguments: { command: "false" } }] }, "e4"),
	message({ role: "toolResult", toolCallId: `${p}2`, toolName: "read", content: [{ type: "text", text: "x\ny" }], isError: false }, "e5"),
	message({ role: "toolResult", toolCallId: `${p}3`, toolName: "bash", content: [{ type: "text", text: "boom\nCommand exited with code 1" }], isError: true }, "e6"),
	message({ role: "assistant", content: [{ type: "toolCall", id: `${p}4`, name: "bash", arguments: { command: "sleep 5" } }] }, "e7"),
];
const sessionText = (p) => `${sessionEntries(p).join("\n")}\n`;
function agentRoot() {
	const root = mkdtempSync(path.join(os.tmpdir(), "gq-agents-"));
	mkdirSync(sessionsDir(root), { recursive: true });
	mkdirSync(tasksDir(root), { recursive: true });
	return { root, sessions: sessionsDir(root), tasks: tasksDir(root) };
}
const writeSession = (dir, name, text) => {
	const file = path.join(dir, name);
	writeFileSync(file, text);
	return file;
};
const taskRecord = (task, items = []) => JSON.stringify({ task: { mode: "background", prompt: "Implement T34", model: "claude-bridge/claude-opus-5-5", tokens: 0, cost: 0, error: null, ...task }, thread: { version: items.length, dropped: 0, items } });
const writeRecord = (dir, task, items) => writeFileSync(path.join(dir, `${task.id}.json`), taskRecord(task, items));
// fs with every read counted, for the tests that check what is read and how much.
function countingFs() {
	const counts = { readdir: 0, readFile: 0, read: [] };
	const files = {
		...realFs,
		readdirSync: (...args) => (counts.readdir++, realFs.readdirSync(...args)),
		readFileSync: (...args) => (counts.readFile++, realFs.readFileSync(...args)),
		readSync: (fd, buffer, offset, length, position) => {
			const bytes = realFs.readSync(fd, buffer, offset, length, position);
			counts.read.push({ position, bytes });
			return bytes;
		},
	};
	return { files, counts };
}

test("a finished task's session file is its record's sessionPath, only inside the sessions folder and when it exists", () => {
	const { sessions, tasks } = agentRoot();
	assert.equal(sessionsDir("/a"), path.join("/a", "gentle-agents", "sessions"));
	assert.equal(tasksDir("/a"), path.join("/a", "gentle-agents", "tasks"));
	const file = writeSession(sessions, "2026-10-31T03-23-19-560Z_aaa.jsonl", sessionText("r"));
	writeRecord(tasks, { id: "d1", agent: "gentle-ai-explore", label: "map files", status: "completed", parentSessionId: "p1", sessionPath: file, createdAt: now - 90_000, startedAt: now - 89_000, endedAt: now - 1000 });
	const record = readTaskRecord(tasks, "d1");
	assert.equal(record.agent, "gentle-ai-explore");
	assert.equal(record.label, "map files");
	assert.equal(record.status, "completed");
	assert.equal(record.parentSessionId, "p1");
	assert.equal(record.endedAt, now - 1000);
	assert.equal(recordSessionPath(record, sessions), file);
	for (const sessionPath of ["/etc/hosts", path.join(sessions, "..", "outside.jsonl"), path.join(sessions, "missing.jsonl"), null, 42]) {
		assert.equal(recordSessionPath({ ...record, sessionPath }, sessions), undefined, String(sessionPath));
	}
	assert.equal(readTaskRecord(tasks, "nope"), undefined);
	assert.equal(readTaskRecord(tasks, "../tasks/d1"), undefined, "an id is a file name, never a path");
	writeFileSync(path.join(tasks, "bad.json"), "{ half");
	assert.equal(readTaskRecord(tasks, "bad"), undefined);
});

test("a running task's session file is the one recent file holding one of its tool call ids; none or two give none", () => {
	const { sessions } = agentRoot();
	const since = now - 60_000;
	writeSession(sessions, "2026-10-31T03-00-00-000Z_other.jsonl", sessionText("other"));
	// Only as a result's toolCallId: not the call itself.
	writeSession(sessions, "2026-10-31T03-00-00-000Z_result.jsonl", `${message({ role: "toolResult", toolCallId: "toolu_x", toolName: "bash", content: [] }, "e")}\n`);
	const file = writeSession(sessions, "2026-10-31T03-00-00-000Z_mine.jsonl", sessionText("toolu_x"));
	writeFileSync(path.join(sessions, "notes.txt"), sessionText("toolu_x"));
	const old = writeSession(sessions, "2026-10-01T03-00-00-000Z_old.jsonl", sessionText("toolu_x"));
	utimesSync(old, new Date(since - 3_600_000), new Date(since - 3_600_000));
	assert.equal(findSessionByCalls(sessions, ["toolu_nope", "toolu_x2"], since), file, "one recent match");
	assert.equal(findSessionByCalls(sessions, ["toolu_nope"], since), undefined, "no match");
	assert.equal(findSessionByCalls(sessions, [], since), undefined, "no ids yet");
	assert.equal(findSessionByCalls(path.join(sessions, "missing"), ["toolu_x1"], since), undefined, "no folder");
	utimesSync(old, new Date(), new Date());
	assert.equal(findSessionByCalls(sessions, ["toolu_x1"], since), undefined, "two recent files hold it: neither");
});

test("the finder tries the task record first, then the tool call ids; it remembers a path and searches again only for new ids", () => {
	const { root, sessions, tasks } = agentRoot();
	const { files, counts } = countingFs();
	const finder = new SessionFinder({ agentDir: root, files });
	const task = { id: "w1", createdAt: now - 80_000, thread: { items: [{ kind: "tool", callId: "f1" }] } };
	assert.equal(finder.find(task), undefined, "nothing written yet");
	const searched = counts.readdir;
	assert.equal(finder.find(task), undefined);
	assert.equal(counts.readdir, searched, "the same ids are not searched again");
	const file = writeSession(sessions, "2026-10-31T03-00-00-000Z_mine.jsonl", sessionText("f"));
	assert.equal(finder.find({ ...task, thread: { items: [...task.thread.items, { kind: "text", text: "x" }, { kind: "tool", callId: "f2" }] } }), file, "a new id: found");
	assert.equal(finder.find({ ...task, thread: { items: [] } }), file, "remembered");
	const recorded = writeSession(sessions, "2026-10-31T03-00-00-000Z_rec.jsonl", sessionText("g"));
	writeRecord(tasks, { id: "d2", agent: "a", label: "b", status: "failed", parentSessionId: "p", sessionPath: recorded, createdAt: now });
	assert.equal(finder.find({ id: "d2", createdAt: now, thread: { items: [{ kind: "tool", callId: "f1" }] } }), recorded, "the record wins");
});

test("the session file is read incrementally: appended bytes only, a partial last line kept, a shrunk file read again", () => {
	const { sessions } = agentRoot();
	const lines = sessionEntries("i");
	const file = writeSession(sessions, "inc.jsonl", `${lines[0]}\n${lines[1]}\n${lines[3].slice(0, 20)}`);
	const { files, counts } = countingFs();
	const tail = new SessionTail(file, { files });
	let read = tail.read();
	assert.equal(read.reset, false);
	assert.deepEqual(read.entries.map((entry) => entry.type), ["session", "model_change"], "the partial line waits");
	const size = realFs.statSync(file).size;
	counts.read.length = 0;
	appendFileSync(file, `${lines[3].slice(20)}\nnot json\n${lines[4]}\n`);
	read = tail.read();
	assert.deepEqual(read.entries.map((entry) => entry.message?.role), ["user", "assistant"], "the completed line, the next one; garbage ignored");
	assert.equal(Math.min(...counts.read.map((r) => r.position)), size, "reading starts where the last read ended");
	counts.read.length = 0;
	assert.deepEqual(tail.read().entries, [], "nothing new");
	assert.equal(counts.read.length, 0, "and nothing read");
	truncateSync(file, 0);
	writeFileSync(file, `${lines[5]}\n`);
	read = tail.read();
	assert.equal(read.reset, true, "a shorter file starts over");
	assert.deepEqual(read.entries.map((entry) => entry.message?.role), ["toolResult"]);
	// A small chunk per read still gives every entry, in order, over several reads.
	const small = new SessionTail(writeSession(sessions, "chunks.jsonl", sessionText("c")), { chunk: 64 });
	const all = [];
	for (let i = 0; i < 200 && all.length < 10; i++) all.push(...small.read().entries);
	assert.equal(all.length, 10);
	assert.ok(new SessionTail(path.join(sessions, "missing.jsonl")).read().error);
});

test("session entries become the popup's items: the prompt, thinking, text and each tool call with its result", () => {
	const { sessions } = agentRoot();
	const file = writeSession(sessions, "log.jsonl", sessionText("l"));
	const log = new SessionLog(file);
	assert.equal(log.poll(), true);
	const shape = (item) => item.kind === "tool" ? [item.kind, item.id, item.name, JSON.stringify(item.args), item.result ? (item.isError ? "error" : "done") : "running"] : [item.kind, item.text];
	assert.deepEqual(log.items.map(shape), [
		["user", "Implement T34\nRead the spec first."],
		["thinking", "Reading the spec first."],
		["tool", "l1", "bash", JSON.stringify({ command: "git status --short" }), "done"],
		["text", "Spec **read**. Writing the tests."],
		["tool", "l2", "read", JSON.stringify({ path: "/srv/app/a.ts", offset: 1, limit: 2 }), "done"],
		["tool", "l3", "bash", JSON.stringify({ command: "false" }), "error"],
		["tool", "l4", "bash", JSON.stringify({ command: "sleep 5" }), "running"],
	]);
	assert.equal(log.items[2].durationMs, 1200);
	assert.equal(log.items[2].result.content[0].text, " M a.ts\n M b.ts");
	const version = log.version;
	assert.equal(log.poll(), false, "nothing new");
	appendFileSync(file, `${message({ role: "toolResult", toolCallId: "l4", toolName: "bash", content: [{ type: "text", text: "" }], isError: false }, "e8")}\n`);
	assert.equal(log.poll(), true);
	assert.ok(log.version > version);
	assert.ok(log.items[6].result, "the running call got its result");
	truncateSync(file, 0);
	writeFileSync(file, `${sessionEntries("l")[3]}\n`);
	assert.equal(log.poll(), true);
	assert.deepEqual(log.items.map((item) => item.kind), ["user"], "a shrunk file starts over");
});

// A stand-in for gentle-quiet's tool rows: what the popup hands each tool call to.
const stubTool = (item, t) => [t.fg("toolTitle", ` TOOL ${item.name} ${item.result ? (item.isError ? "error" : "done") : "running"}`)];

test("the session is drawn in order: the prompt folded and dim, thinking as one Thinking... row, text as Markdown, each tool by the drawing it is given", () => {
	const { sessions } = agentRoot();
	const log = new SessionLog(writeSession(sessions, "draw.jsonl", sessionText("d")));
	log.poll();
	const raw = sessionLines(log.items, theme, 60, stubTool);
	const rows = raw.map((row) => plain(row).trimEnd());
	assert.deepEqual(rows, [
		"› Implement T34 …",
		"",
		"Thinking...",
		"",
		"TOOL bash done",
		"",
		"Spec read. Writing the tests.",
		"",
		"TOOL read done",
		"",
		"TOOL bash error",
		"",
		"TOOL bash running",
	]);
	assert.ok(painted(raw[0], "dim"), "the prompt dim");
	assert.ok(painted(raw[2], "dim", "\x1b[3mThinking...") && plain(raw[2]) === "Thinking...", "thinking: one dim italic Thinking... row, as the main view");
	assert.ok(raw[6].includes("\x1b[1mread\x1b[22m"), "the text through Pi's Markdown");
	const broken = sessionLines(log.items, theme, 60, () => { throw new Error("boom"); }).map(plain);
	assert.ok(broken.some((row) => row.includes("bash")), "a failing drawing falls back to the tool's name");
});

function sessionPopup({ finder, record, tasks = TASKS, drawTool = stubTool, rows = 60 } = {}) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gq-presence-"));
	const file = presence(dir, "s1", [{ incarnation: "a", heartbeat: now, tasks }]);
	const fake = fakeCtx(rows);
	const opened = openAgentPopup(fake.ctx, { file: record ? undefined : file, taskId: "w1", lib: realLib, interval: 60_000, finder, record, drawTool });
	const component = opened ? fake.component() : undefined;
	const body = () => component.render(80).map(plain).slice(4, -2).map((row) => row.slice(2, -2).trimEnd()).filter(Boolean);
	return { ...fake, opened, component, body, file };
}

test("with the session file found, the popup draws it under the task header instead of the presence thread", () => {
	const { sessions } = agentRoot();
	const sessionFile = writeSession(sessions, "popup.jsonl", sessionText("p"));
	const { body, component } = sessionPopup({ finder: { find: () => sessionFile } });
	assert.match(plain(component.render(80)[1]), /gentle-ai-worker · running/);
	assert.deepEqual(body(), ["› Implement T34 …", "Thinking...", "TOOL bash done", "Spec read. Writing the tests.", "TOOL read done", "TOOL bash error", "TOOL bash running"]);
	appendFileSync(sessionFile, `${message({ role: "assistant", content: [{ type: "text", text: "All green." }] }, "e9")}\n`);
	component.refresh();
	assert.equal(body().at(-1), "All green.", "appended entries show on the next poll");
});

test("without a session file, or before it has entries, the popup draws the presence thread as before", () => {
	const none = sessionPopup({ finder: { find: () => undefined } });
	assert.ok(none.body().includes("Tool · bash · Complete"));
	const { sessions } = agentRoot();
	const empty = writeSession(sessions, "empty.jsonl", "");
	const early = sessionPopup({ finder: { find: () => empty } });
	assert.ok(early.body().includes("Tool · bash · Complete"), "no entries yet");
	writeFileSync(empty, sessionText("e"));
	early.component.refresh();
	assert.ok(early.body().includes("TOOL bash done"), "then the session");
	const failing = sessionPopup({ finder: { find: () => { throw new Error("boom"); } } });
	assert.ok(failing.body().includes("Tool · bash · Complete"), "a finder that fails");
});

test("a finished task's popup comes from its record: finished or failed in the header, its session below", () => {
	const { sessions } = agentRoot();
	const sessionFile = writeSession(sessions, "done.jsonl", sessionText("f"));
	const base = { id: "d1", agent: "gentle-ai-explore", label: "map files", model: "claude-bridge/claude-opus-5-5", parentSessionId: "p1", sessionPath: sessionFile, createdAt: now - 200_000, startedAt: now - 190_000, endedAt: now - 10_000 };
	const done = sessionPopup({ record: { ...base, status: "completed" }, finder: { find: () => sessionFile } });
	assert.equal(done.opened, true);
	const out = done.component.render(80).map(plain);
	assert.match(out[1], /^▏ gentle-ai-explore · finished · claude-bridge\/claude-opus-5-5 · 180s +▕$/);
	assert.match(out[2], /map files/);
	assert.ok(done.body().includes("TOOL bash error"));
	const failed = sessionPopup({ record: { ...base, status: "failed" }, finder: { find: () => sessionFile } });
	assert.match(failed.component.render(80).map(plain)[1], / · failed · /);
	const unreadable = sessionPopup({ record: { ...base, status: "completed" }, finder: { find: () => undefined } });
	assert.equal(unreadable.opened, false, "no session file: nothing to open");
});

test("finished Agents rows are matched to this session's task records by glyph, agent and label, the newest first", () => {
	assert.deepEqual(finishedRowStatus("✓ gentle-ai-explore  map files"), ["completed"]);
	assert.deepEqual(finishedRowStatus("✗ gentle-ai-explore  map files"), ["failed", "timed_out"]);
	assert.deepEqual(finishedRowStatus("– gentle-ai-explore  map files"), ["cancelled"]);
	assert.equal(finishedRowStatus("◔ gentle-ai-explore  map files"), undefined);
	const records = [
		{ id: "a", agent: "gentle-ai-explore", label: "map files", status: "completed", createdAt: 1, endedAt: 10 },
		{ id: "b", agent: "gentle-ai-explore", label: "map files", status: "completed", createdAt: 2, endedAt: 20 },
		{ id: "c", agent: "gentle-ai-explore", label: "map files", status: "failed", createdAt: 3, endedAt: 30 },
		{ id: "d", agent: "gentle-ai-worker", label: "other", status: "completed", createdAt: 4, endedAt: 40 },
	];
	assert.equal(rowRecord("✓ gentle-ai-explore  map files   1m11s", records), "b", "the newest completed");
	assert.equal(rowRecord("✗ gentle-ai-explore  map files   1m11s", records), "c");
	assert.equal(rowRecord("✓ gentle-ai-explore  map fi…   1m11s", records), "b", "a label cut by gentle-pi");
	assert.equal(rowRecord("– gentle-ai-explore  map files", records), undefined, "no cancelled record");
	assert.equal(rowRecord("◔ gentle-ai-explore  map files", records), undefined, "a working row");
	assert.equal(rowRecord("✓ gentle-ai-review  map files", records), undefined);
});

test("task records are listed per parent session, only with a readable session file, and read again only when they change", () => {
	const { root, sessions, tasks } = agentRoot();
	const sessionFile = writeSession(sessions, "rec.jsonl", sessionText("q"));
	writeRecord(tasks, { id: "r1", agent: "a", label: "one", status: "completed", parentSessionId: "p1", sessionPath: sessionFile, createdAt: 1, endedAt: 2 });
	writeRecord(tasks, { id: "r2", agent: "a", label: "two", status: "completed", parentSessionId: "p2", sessionPath: sessionFile, createdAt: 1, endedAt: 2 });
	writeRecord(tasks, { id: "r3", agent: "a", label: "gone", status: "completed", parentSessionId: "p1", sessionPath: path.join(sessions, "gone.jsonl"), createdAt: 1, endedAt: 2 });
	writeFileSync(path.join(tasks, "junk.json"), "nope");
	const { files, counts } = countingFs();
	const records = new FinishedRecords({ agentDir: root, files });
	assert.deepEqual(records.list("p1").map((record) => record.id), ["r1"]);
	const reads = counts.readFile;
	assert.deepEqual(records.list("p1").map((record) => record.id), ["r1"]);
	assert.equal(counts.readFile, reads, "unchanged files are not read again");
	writeRecord(tasks, { id: "r4", agent: "a", label: "new", status: "failed", parentSessionId: "p1", sessionPath: sessionFile, createdAt: 3, endedAt: 4 });
	assert.deepEqual(records.list("p1").map((record) => record.id).sort(), ["r1", "r4"]);
	assert.equal(counts.readFile, reads + 1, "only the new record is read");
	assert.deepEqual(records.list(undefined), []);
	assert.equal(records.get("r4").status, "failed");
});

// --- In gentle-quiet: the main view's own tool rows, and the ↗ on finished rows ---

const SESSIONS_ROOT = sessionsDir(agentDir);
const TASKS_ROOT = tasksDir(agentDir);
mkdirSync(SESSIONS_ROOT, { recursive: true });
mkdirSync(TASKS_ROOT, { recursive: true });

// The rows the main conversation draws for a call and its result (quietRenderers), without the expand hint,
// which only the newest finished call of the conversation shows.
function mainRows(tool, name, args, result, context = {}) {
	const renderers = tool(name, {});
	const call = renderers.renderCall(args, theme).render(76);
	const done = renderers.renderResult(result ?? { content: [] }, { isPartial: !result }, theme, { args, toolCallId: context.id, isError: context.isError, durationMs: context.durationMs }).render(76);
	return [...call, ...done].map((row) => popupEdge(plain(row).trimEnd().replace(/\s+ctrl\+o to expand$/, "")));
}
// The pop-up draws a row of the conversation without its one-column margin, at the header's column.
const popupEdge = (row) => row.replace(/^ /, "");

test("a running subagent's popup draws its session's tool calls with the main view's quiet rows", async () => {
	const items = [{ kind: "tool", callId: "toolu_main1", name: "bash", output: "", running: false, isError: false }];
	const tasks = [{ summary: summary("w1", "gentle-ai-worker", "subagent popup from Agents card", "running"), thread: thread(items) }, TASKS[1]];
	writeSession(SESSIONS_ROOT, "2026-10-31T03-00-00-000Z_main.jsonl", sessionText("toolu_main"));
	const { mouse, opened, tool } = await agentsCard("card-session", { tasks });
	mouse("click", 2);
	assert.equal(opened.length, 1);
	const popupTui = { terminal: { rows: 80, columns: 120 }, requestRender() {} };
	const out = opened[0].factory(popupTui, theme, {}, () => {}).render(80).map(plain);
	assert.match(out[1], /gentle-ai-worker · running/);
	const body = out.slice(4, -2).map((row) => row.slice(2, -2).trimEnd());
	const text = (value, extra = {}) => ({ content: [{ type: "text", text: value }], ...extra });
	const expected = [
		...mainRows(tool, "bash", { command: "git status --short" }, text(" M a.ts\n M b.ts"), { id: "toolu_main1", durationMs: 1200 }),
		...mainRows(tool, "read", { path: "/srv/app/a.ts", offset: 1, limit: 2 }, text("x\ny"), { id: "toolu_main2" }),
		...mainRows(tool, "bash", { command: "false" }, text("boom\nCommand exited with code 1", { isError: true }), { id: "toolu_main3", isError: true }),
		...mainRows(tool, "bash", { command: "sleep 5" }, undefined, { id: "toolu_main4" }),
	];
	const shown = body.filter((row) => expected.includes(row));
	assert.deepEqual(shown, expected, `the main view's rows, in order:\n${body.join("\n")}`);
	assert.ok(expected.includes("$ git status --short") && expected.includes("└ ✗ exit 1") && expected.includes("└ running…"), "the rows compared are the quiet ones");
	assert.ok(body.includes("Thinking..."), "thinking folded as the main view shows it");
	assert.ok(!body.some((row) => row.includes("Reading the spec first.")), "the thinking text itself is not shown");
	assert.ok(body.includes("Spec read. Writing the tests."), "text");
	assert.ok(!body.some((row) => row.startsWith("Tool · ")), "not the presence thread");
});

test("a finished Agents row with a task record of this session gets ↗ and opens its session popup", async () => {
	const sessionFile = writeSession(SESSIONS_ROOT, "2026-10-31T03-00-00-000Z_done.jsonl", sessionText("toolu_done"));
	const record = { agent: "gentle-ai-explore", label: "map files", status: "completed", sessionPath: sessionFile, createdAt: now - 200_000, startedAt: now - 190_000, endedAt: now - 119_000 };
	writeRecord(TASKS_ROOT, { ...record, id: "done-1", parentSessionId: "card-done" });
	writeRecord(TASKS_ROOT, { ...record, id: "done-other", parentSessionId: "another-session", endedAt: now, label: "map files" });
	const { rows, mouse, opened, seen, sent } = await agentsCard("card-done");
	const out = rows();
	assert.match(out[4], /^│ ✓ gentle-ai-explore .* 1m11s ↗ +│$/, "the finished row");
	assert.doesNotMatch(out[5], /↗/, "… 1 more");
	for (const type of ["press", "release", "click"]) assert.equal(mouse(type, 4)?.handled, true);
	assert.deepEqual(seen, []);
	assert.deepEqual(sent, []);
	assert.equal(opened.length, 1);
	const popupTui = { terminal: { rows: 80, columns: 120 }, requestRender() {} };
	const popupRows = opened[0].factory(popupTui, theme, {}, () => {}).render(80).map(plain);
	assert.match(popupRows[1], /gentle-ai-explore · finished · .* · 71s/, "this session's record, not the newer one of another session");
	assert.ok(popupRows.some((row) => row.includes("└ ✗ exit 1")), "its session in the quiet look");
});

test("a finished subagent's popup starts its prompt, tool rows and answer at the header's column", async () => {
	const p = "toolu_edge_";
	const sessionFile = writeSession(SESSIONS_ROOT, "2026-10-31T05-00-00-000Z_edge.jsonl", [
		...sessionEntries(p).slice(0, 3),
		message({ role: "user", content: [{ type: "text", text: "Test run only." }] }, "e1"),
		message({ role: "assistant", content: [{ type: "toolCall", id: `${p}1`, name: "read", arguments: { path: "/srv/app/package.json" } }] }, "e2"),
		message({ role: "toolResult", toolCallId: `${p}1`, toolName: "read", content: [{ type: "text", text: "a\nb" }], isError: false }, "e3"),
		message({ role: "assistant", content: [{ type: "text", text: "The package is pi-gentle-quiet." }] }, "e4"),
	].join("\n") + "\n");
	writeRecord(TASKS_ROOT, { id: "edge-1", agent: "gentle-ai-explore", label: "test run for display", status: "completed", sessionPath: sessionFile, parentSessionId: "card-edge", createdAt: now - 20_000, startedAt: now - 20_000, endedAt: now - 10_000 });
	const { rows, mouse, opened } = await agentsCard("card-edge");
	rows();
	mouse("click", 4);
	assert.equal(opened.length, 1);
	const popupTui = { terminal: { rows: 80, columns: 120 }, requestRender() {} };
	const out = opened[0].factory(popupTui, theme, {}, () => {}).render(80).map(plain).map((row) => row.slice(1, -1));
	const column = (row) => row.length - row.trimStart().length;
	assert.match(out[1], /gentle-ai-explore · finished/);
	const edge = column(out[1]);
	assert.equal(column(out[2]), edge, "the subtitle");
	const find = (pattern) => out.find((row) => pattern.test(row)) ?? assert.fail(`no ${pattern} in:\n${out.join("\n")}`);
	for (const pattern of [/› Test run only\./, /read .*package\.json/, /└ /, /The package is pi-gentle-quiet\./]) {
		assert.equal(column(find(pattern)), edge, `${pattern} at the header's column:\n${out.join("\n")}`);
	}
});

// ---------------------------------------------------------------------------
// T35 (S16, L34): web, memory and codemode calls in the popup as the main conversation draws them
// ---------------------------------------------------------------------------

// gentle-engram's chrome module, which gentle-quiet's memory rows draw with (as in memory.test.mjs).
const engramDir = path.join(agentDir, "npm/node_modules/gentle-engram");
mkdirSync(engramDir, { recursive: true });
realFs.copyFileSync(new URL("./fixtures/memory-tool-chrome.js", import.meta.url), path.join(engramDir, "memory-tool-chrome.js"));

// pi-web-access's own rows (as in web.test.mjs): the call as it draws it, a status line when done.
const webNative = {
	renderCall: (args) => ({ render: () => (args.url ? [`\x1b[1mfetch\x1b[22m ${args.url}`] : [`\x1b[1msearch\x1b[22m "${args.query}"`]) }),
	renderResult: (result, options) => ({ render: () => (options.isPartial ? ["  searching 1/1"] : [` ${result.details?.sources ?? 0} sources`, "  brief text…"]) }),
};
const T35_CALLS = [
	{ name: "web_search", arguments: { query: "pi tui overlay" }, result: { content: [{ type: "text", text: "found" }], details: { sources: 3 }, durationMs: 2100 } },
	{ name: "fetch_content", arguments: { url: "https://example.com" }, result: { content: [{ type: "text", text: "HTTP 404 not found" }], isError: true } },
	{ name: "mem_search", arguments: { query: "sidebar tabs" }, result: { content: [{ type: "text", text: "3 results" }], details: { data: { results: [1, 2, 3] } } } },
	{ name: "mem_save", arguments: { title: "Fixed popup", content: "…" }, result: { content: [{ type: "text", text: "saved" }], details: {} } },
	{ name: "codemode", arguments: { code: "const a = await mcp.x();\nreturn a;" }, result: { content: [{ type: "text", text: "Script completed\nWall time 1.2 seconds\nOutput:\nok" }], details: { calls: [{ name: "mcp__context7__query-docs", status: "done", durationMs: 800 }, { name: "mcp__codegraph__explore", status: "done", durationMs: 300 }] }, durationMs: 1300 } },
];
const t35Session = (p, calls = T35_CALLS) => [
	...sessionEntries(p).slice(0, 4),
	...calls.flatMap((call, i) => [
		message({ role: "assistant", content: [{ type: "toolCall", id: `${p}${i + 1}`, name: call.name, arguments: call.arguments }] }, `c${i}`),
		...(call.result ? [message({ role: "toolResult", toolCallId: `${p}${i + 1}`, toolName: call.name, isError: false, ...call.result }, `r${i}`)] : []),
	]),
].join("\n") + "\n";

// The rows the main conversation draws for a web call (webRenderers around pi-web-access's own), without the hint.
function mainWebRows(tool, name, args, result, isError) {
	const renderers = tool(name, webNative);
	const state = {};
	const call = renderers.renderCall(args, theme, { isPartial: false, isError, state }).render(76);
	const done = renderers.renderResult(result, { isPartial: false }, theme, { args, isError, state }).render(76);
	clearInterval(state.webBlink);
	return [...call, ...done].map((row) => popupEdge(plain(row).trimEnd().replace(/\s+ctrl\+o to expand$/, "")));
}

async function t35Popup(sessionId, p, calls) {
	const items = [{ kind: "tool", callId: `${p}1`, name: calls[0].name, output: "", running: false, isError: false }];
	const tasks = [{ summary: summary(p, "gentle-ai-worker", "subagent popup from Agents card", "running"), thread: thread(items) }, TASKS[1]];
	writeSession(SESSIONS_ROOT, `2026-10-31T04-00-00-000Z_${p}.jsonl`, t35Session(p, calls));
	const card = await agentsCard(sessionId, { tasks });
	const draw = async () => {
		card.rows(); // the ↗ rows as last drawn
		card.mouse("click", 2);
		await settle(); // gentle-pi's renderer loads once
		const popupTui = { terminal: { rows: 80, columns: 120 }, requestRender() {} };
		const out = card.opened.at(-1).factory(popupTui, theme, {}, () => {}).render(80);
		return { painted: out, body: out.map(plain).slice(4, -2).map((row) => row.slice(2, -2).trimEnd()) };
	};
	return { ...card, draw };
}

test("web, memory and codemode calls in the popup are the rows the main conversation draws for them", async () => {
	const { tool, draw } = await t35Popup("card-t35", "toolu_t35_", T35_CALLS);
	const [search, fetch, memSearch, memSave, codemode] = T35_CALLS;
	const expected = [
		...mainWebRows(tool, "web_search", search.arguments, search.result, false),
		...mainWebRows(tool, "fetch_content", fetch.arguments, fetch.result, true),
		...mainRows(tool, "mem_search", memSearch.arguments, memSearch.result),
		...mainRows(tool, "mem_save", memSave.arguments, memSave.result),
		...mainRows(tool, "codemode", codemode.arguments, codemode.result, { durationMs: codemode.result.durationMs }),
	];
	assert.ok(expected.includes('● search "pi tui overlay"') && expected.includes("  └ 3 sources"), `web rows: ${expected.join(" | ")}`);
	assert.ok(expected.includes("\u{100000} search “sidebar tabs”") && expected.includes("└ ✓ 3 results"), `memory rows: ${expected.join(" | ")}`);
	const { body, painted: rows } = await draw();
	const shown = body.filter((row) => expected.includes(row));
	assert.deepEqual(shown, expected, `the main view's rows, in order:\n${body.join("\n")}`);
	assert.ok(!body.some((row) => /^(web_search|fetch_content|mem_search|mem_save)$/.test(row)), "no bare tool name");
	assert.ok(rows.some((row) => row.includes("\x1b[38;2;78;186;101m●")), "the done web call's fixed green dot");
	assert.ok(rows.some((row) => row.includes("\x1b[38;2;255;107;128m●")), "the failed one's fixed red dot");
});

test("a running web call in the popup keeps a steady grey dot, and no call of the popup takes the main view's expand hint", async (t) => {
	const calls = [T35_CALLS[0], { name: "web_search", arguments: { query: "still going" } }];
	const { tool, draw } = await t35Popup("card-t35-run", "toolu_t35r_", calls);
	tool("web_search", webNative);
	// The main view's newest finished call shows the hint; the popup's finished calls must not take it.
	const main = tool("bash", {});
	const done = main.renderResult({ content: [{ type: "text", text: "x\ny\nz\nw" }] }, { isPartial: false }, theme, { args: { command: "ls" }, toolCallId: "main-last" });
	assert.match(plain(done.render(76)[0]).trimEnd(), /ctrl\+o to expand$/);
	const clock = t.mock.method(Date, "now", () => 600); // the main view's blink is off at 600 ms
	const { body, painted: rows } = await draw();
	clock.mock.restore();
	assert.ok(body.includes('● search "still going"'), body.join("\n"));
	assert.ok(rows.some((row) => painted(row, "dim", "●")), "the dot lit and grey");
	assert.ok(body.includes("  └ searching 1/1"), "pi-web-access's progress line");
	assert.ok(!body.some((row) => /ctrl\+o/.test(row)), "no expand hint in the popup");
	assert.match(plain(done.render(76)[0]).trimEnd(), /ctrl\+o to expand$/, "the main view keeps its hint");
});

test("a web call Pi has not drawn in the main view yet still gets the dot and its name in the popup", async () => {
	const { draw } = await t35Popup("card-t35-fresh", "toolu_t35f_", [{ name: "source_check", arguments: { query: "is pi fast" }, result: { content: [{ type: "text", text: "2 sources agree" }] } }]);
	const { body } = await draw();
	assert.ok(body.some((row) => /^● .*source.check.*is pi fast/.test(row)), body.join("\n"));
	assert.ok(body.includes("  └ 2 sources agree"), body.join("\n"));
});
