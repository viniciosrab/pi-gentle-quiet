import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configFile, load, painted, plain, theme } from "./helpers.mjs";
import { findActivityFile, findJobLog, JobLogs, jobRows, parseActivity, presenceDir, readActivity, readTail, rowTask, sessionHash } from "../extensions/sidebar/run-data.ts";
import { fallbackThreadItem, openAgentPopup, openJobPopup } from "../extensions/sidebar/run-popup.ts";

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
	publish([{ id: "job-7", label: "npm run build", startedAt: now - 12_000 }, { id: "job-8", label: "npm test", startedAt: now - 9_000, status: "exited", endedAt: now - 1_000, exitCode: 0 }]);
	const out = rows();
	assert.ok(out.slice(0, 6).every((row) => [...row].length === [...out[0]].length), "every row as wide as the card");
	assert.match(out[1], /^│ ⧗ Jobs ▾ Collapse {2}2 jobs +│$/u);
	assert.doesNotMatch(out[1], /↗/);
	assert.match(out[3], /^│ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] npm run build +12s ?↗ │$/u, "in the padding past the elapsed time");
	assert.match(out[4], /^│ ✓ npm test +8s +│$/u, "a finished job keeps its row");
	assert.doesNotMatch(out[4], /↗/);
	assert.equal(out[3].indexOf("12s"), out[4].indexOf("8s") - 1, "the elapsed column does not move");
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
