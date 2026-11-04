import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { plain, theme as baseTheme } from "./helpers.mjs";
import { openPreview } from "../extensions/sidebar/tree-preview.ts";
import { openLivePopup } from "../extensions/sidebar/run-popup.ts";
import { openMusicPicker } from "../extensions/sidebar/music-picker.ts";
import { openPicker } from "../extensions/sidebar/prof-picker.ts";
import * as scrollbarModule from "../extensions/sidebar/scrollbar.ts";

// The glide's frames, driven by hand: the scrollbar's timer functions replaced by a clock that runs them on frame().
const clock = { timers: new Map(), next: 1 };
const deps = scrollbarModule.scrollbarDeps ?? {};
Object.assign(deps, {
	setInterval: (fn) => {
		const id = clock.next++;
		clock.timers.set(id, fn);
		return { id, unref() {} };
	},
	clearInterval: (handle) => clock.timers.delete(handle?.id),
});
/** One frame of every glide running. */
const frame = () => [...clock.timers.values()].forEach((fn) => fn());
/** Frames until no glide runs. */
function settle() {
	for (let i = 0; clock.timers.size && i < 1000; i++) frame();
}

// The stub theme, plus Pi's scrollbar roles with codes of their own and a selectedBg background.
const BAR = { scrollbarTrack: "\x1b[38;5;200m", scrollbarThumb: "\x1b[38;5;201m" };
const theme = {
	...baseTheme,
	fg: (name, text) => (BAR[name] ? `${BAR[name]}${text}\x1b[39m` : baseTheme.fg(name, text)),
	getBgAnsi: (role) => (role === "selectedBg" ? "\x1b[48;5;99m" : ""),
};
const IDLE = "\u{1FB75}"; // the track, and the thumb while not dragged
const HELD = "\u{1FB88}"; // the thumb while dragged

/** The cell just before the right stroke of `row`, plain. */
const barCell = (row) => [...plain(row)].at(-2);
/** A body row's text between the left stroke's padding and the bar, trimmed. */
const content = (row) => [...plain(row)].slice(2, -2).join("").trim();
/** The cell before the bar's. */
const beforeBar = (row) => [...plain(row)].at(-3);
/** Each body row's bar cell as "t" (track), "T" (thumb), "D" (dragged thumb) or the plain character. */
function bar(rows) {
	return rows
		.map((row) => {
			if (row.includes(`${BAR.scrollbarThumb}${HELD}`)) return "D";
			if (row.includes(`${BAR.scrollbarThumb}${IDLE}`)) return "T";
			if (row.includes(`${BAR.scrollbarTrack}${IDLE}`)) return "t";
			return barCell(row);
		})
		.join("");
}
const mouse = (component, type, x, y) => component.handleMouse({ type, button: "left", x, y });

// A ctx whose ui.custom records the overlay; component() builds it as Pi does, on a TUI `rows` tall.
function fakeCtx(rows) {
	const calls = { custom: [], done: [] };
	// Pi's dispatchMouseToOverlay, which the pop-up wraps: `tui.route(event)` says what it hits, nothing by default.
	const tui = {
		terminal: { rows, columns: 120 },
		renders: 0,
		requestRender() {
			this.renders++;
		},
		route: () => ({ hit: false }),
		dispatchMouseToOverlay(event) {
			return this.route(event);
		},
	};
	const ctx = { hasUI: true, ui: { custom: (factory, options) => (calls.custom.push({ factory, options }), new Promise(() => {})) } };
	const component = () => calls.custom.at(-1).factory(tui, theme, {}, (value) => calls.done.push(value));
	return { ctx, calls, component, tui };
}

// The pointer over a thin bar grows its thumb, as Pi's own scrollbar does when hovered, and leaving it, inside the
// pop-up or out of it, gives the thumb back. `onBar` is a point on the bar's track, `idle` and `hovered` the bar.
function hovering({ component, body, tui }, { onBar, offBar, above, idle, hovered }) {
	const [x, y] = onBar;
	const move = (type, px, py) => component.handleMouse({ type, x: px, y: py });
	assert.equal(bar(body()), idle);
	assert.deepEqual(move("move", x, y), { handled: true, render: true }, "onto the bar: a render");
	assert.equal(bar(body()), hovered, "the thumb grows; the track stays");
	assert.deepEqual(move("move", x, y + 1), { handled: true }, "still on it: nothing to redraw");
	assert.deepEqual(move("move", ...offBar), { handled: true, render: true }, "off the bar, inside the pop-up: a render");
	assert.equal(bar(body()), idle);
	assert.equal(move("move", ...offBar), undefined, "a move that changes nothing is the pop-up's");
	assert.deepEqual(move("drag", x, y), { handled: true, render: true }, "a drag with no bar held hovers too");
	assert.equal(bar(body()), hovered);
	move("move", x, above);
	assert.equal(bar(body()), idle, "the bar's column above its track is not the bar");
	// Pi sends an overlay only the events inside its box: one that hits no overlay, or another one, ends the hover.
	move("move", x, y);
	const renders = tui.renders;
	assert.deepEqual(tui.dispatchMouseToOverlay({ type: "move", x: 0, y: 0 }), { hit: false }, "the miss is answered as Pi's");
	assert.equal(bar(body()), idle, "the pointer left the pop-up");
	assert.ok(tui.renders > renders, "and it is redrawn");
	move("move", x, y);
	tui.route = () => ({ hit: true }); // another overlay over the pop-up
	tui.dispatchMouseToOverlay({ type: "move", x: 0, y: 0 });
	assert.equal(bar(body()), idle, "another overlay took the pointer");
	move("move", x, y);
	tui.route = (event) => ({ hit: true, result: component.handleMouse({ ...event, x, y: y + 1 }) }); // the pop-up itself
	tui.dispatchMouseToOverlay({ type: "move", x: 0, y: 0 });
	assert.equal(bar(body()), hovered, "a move routed to the pop-up keeps it");
	tui.route = () => ({ hit: false });
	move("move", ...offBar);
}

// ---------------------------------------------------------------------------
// The TREE file preview (and MEM's text preview, the same pop-up)
// ---------------------------------------------------------------------------

async function preview(content, { rows = 30, text } = {}) {
	const fake = fakeCtx(rows);
	if (text !== undefined) openPreview(fake.ctx, { text, title: "memory" });
	else {
		const dir = mkdtempSync(path.join(os.tmpdir(), "gq-bar-"));
		const target = path.join(dir, "app.js");
		writeFileSync(target, content);
		openPreview(fake.ctx, { file: target, relPath: "app.js" });
	}
	const component = fake.component();
	await component.ready;
	const body = (width = 80) => component.render(width).slice(4, -3);
	const range = () => plain(component.render(80).at(-2)).match(/(\d+)-(\d+) \/ (\d+)/).slice(1).map(Number);
	body(); // Pi draws the pop-up before any click reaches it
	return { ...fake, component, body, range };
}
const source = (count) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

test("TREE preview: a file longer than the view has a scrollbar before the right stroke, its thumb sized and placed as Pi's", async () => {
	// 40 lines in an 18-row view: the thumb is round(18*18/40) = 8 rows; it moves over 18 - 8 = 10 rows as the top goes 0..22.
	const { component, body } = await preview(source(40));
	assert.equal(bar(body()), "TTTTTTTTtttttttttt", "at the top");
	for (let i = 0; i < 11; i++) component.handleInput("j");
	assert.equal(bar(body()), "tttttTTTTTTTTttttt", "top 11: thumb at round(11/22*10) = 5");
	component.handleInput("G");
	assert.equal(bar(body()), "ttttttttttTTTTTTTT", "at the end");
	assert.ok(body().every((row) => plain(row).length === plain(body()[0]).length), "every row as wide");
});

test("TREE preview: a file that fits has no scrollbar, the rows as before", async () => {
	const { body, component } = await preview(source(10));
	assert.ok(body().every((row) => plain(row).endsWith(" ▕")), body().map(plain).join("\n"));
	assert.equal(mouse(component, "press", 78, 4), undefined, "nothing to press");
});

test("TREE preview: the code keeps a blank column apart from the scrollbar", async () => {
	const { body } = await preview(`${"x".repeat(300)}\n${source(40)}`);
	const rows = body();
	assert.equal(barCell(rows[0]), IDLE);
	assert.ok(rows.every((row) => beforeBar(row) === " "), rows.map(plain).join("\n"));
});

test("TREE preview: a press on the track jumps there, takes the mouse, and its click is swallowed", async () => {
	const { component, range, calls } = await preview(source(40));
	// Body row 12 (y = 16): the thumb's middle (8 / 2 = 4 rows above the pointer) goes there: offset 8 of 10 → top round(0.8*22) = 18.
	assert.deepEqual(mouse(component, "press", 78, 16), { handled: true, capture: true, render: true });
	settle();
	assert.deepEqual(range(), [19, 36, 40]);
	assert.equal(mouse(component, "release", 78, 16)?.handled, true);
	assert.equal(mouse(component, "click", 78, 16)?.handled, true, "the click after it is taken");
	assert.deepEqual(range(), [19, 36, 40]);
	assert.equal(calls.done.length, 0, "nothing closed");
	assert.equal(mouse(component, "press", 10, 16), undefined, "a press off the bar does what it did");
	assert.equal(mouse(component, "press", 77, 16), undefined, "the thin bar is one column: the cell before it is not the bar");
});

test("TREE preview: dragging the thumb scrolls in proportion, clamps past the ends, and stops at the release", async () => {
	const { component, range, body } = await preview(source(40));
	assert.equal(mouse(component, "press", 78, 6)?.capture, true, "on the thumb (its row 2): the view stays");
	assert.deepEqual(range(), [1, 18, 40]);
	assert.equal(bar(body()), "DDDDDDDDtttttttttt", "the held thumb grows");
	mouse(component, "drag", 78, 11); // offset 5 of 10 → top 11
	settle();
	assert.deepEqual(range(), [12, 29, 40]);
	mouse(component, "drag", 200, 40); // past the end, outside the box
	settle();
	assert.deepEqual(range(), [23, 40, 40]);
	mouse(component, "drag", 78, -3);
	settle();
	assert.deepEqual(range(), [1, 18, 40]);
	mouse(component, "drag", 78, 11);
	mouse(component, "release", 78, 11);
	settle();
	assert.equal(bar(body()), "tttttTTTTTTTTttttt", "idle again");
	mouse(component, "drag", 78, 40);
	settle();
	assert.deepEqual(range(), [12, 29, 40], "a drag after the release does nothing");
	assert.equal(component.handleMouse({ type: "wheel", wheelDelta: 1, x: 3, y: 5 })?.handled, true);
	assert.deepEqual(range(), [15, 32, 40], "the wheel still scrolls, three lines");
});

test("TREE preview: the pointer over the bar grows its thumb as Pi's does; leaving the bar or the pop-up gives it back", async () => {
	const fake = await preview(source(40));
	hovering(fake, { onBar: [78, 4 + 12], offBar: [10, 10], above: 3, idle: "TTTTTTTTtttttttttt", hovered: "DDDDDDDDtttttttttt" });
	// A press still grabs, and the release keeps the pop-up open.
	const { component, calls } = fake;
	assert.equal(mouse(component, "press", 78, 6)?.capture, true);
	mouse(component, "release", 78, 6);
	assert.equal(calls.done.length, 0);
});

test("TREE preview: an outside press still closes the pop-up through the wrapped dispatch", async () => {
	const { component, tui, calls } = await preview(source(40));
	component.handleMouse({ type: "move", x: 78, y: 6 });
	const routed = tui.dispatchMouseToOverlay({ type: "press", button: "left", x: 0, y: 0, width: 120, height: 30 });
	assert.equal(routed.hit, true, "the press is taken");
	assert.equal(calls.done.length, 1, "and the pop-up closed");
});

test("MEM text preview: rendered text longer than the view has the scrollbar too", async () => {
	const { component, body } = await preview(undefined, { text: source(40) });
	assert.equal(bar(body()), "TTTTTTTTtttttttttt");
	mouse(component, "press", 78, 4 + 17); // the last track row: offset clamped to 10 → the end
	settle();
	assert.equal(content(body().at(-1)), "line 40");
});

// ---------------------------------------------------------------------------
// The live pop-up (subagents, jobs)
// ---------------------------------------------------------------------------

function live(count) {
	const fake = fakeCtx(30);
	const widths = [];
	const view = { title: "job · 1", subtitle: "running", key: "k", lines: (width) => (widths.push(width), Array.from({ length: count }, (_, i) => `row ${i + 1}`)) };
	openLivePopup(fake.ctx, { load: () => view, interval: 60_000 });
	const component = fake.component();
	const body = () => component.render(80).slice(4, -3);
	const footer = () => plain(component.render(80).at(-2));
	body();
	return { ...fake, component, body, footer, widths };
}

test("live pop-up: a body longer than the view has the scrollbar, drawn one column narrower; one that fits has none", (t) => {
	const { component, body, widths } = live(40);
	t.after(() => component.dispose());
	assert.equal(bar(body()), "ttttttttttTTTTTTTT", "following the end");
	assert.equal(widths.at(-1), 75, "the body drawn at inner - 1");
	component.handleInput("g");
	assert.equal(bar(body()), "TTTTTTTTtttttttttt");
	const short = live(5);
	t.after(() => short.component.dispose());
	assert.ok(short.body().every((row) => plain(row).endsWith(" ▕")));
	assert.equal(short.widths.at(-1), 76);
});

test("live pop-up: the scrollbar scrolls as scrollTo does: off the end stops following, back to the end follows", (t) => {
	const { component, body, footer, calls } = live(40);
	t.after(() => component.dispose());
	assert.deepEqual(mouse(component, "press", 78, 6), { handled: true, capture: true, render: true }); // track row 2: the top
	settle();
	assert.equal(content(body()[0]), "row 1");
	assert.match(footer(), /f follow/);
	mouse(component, "release", 78, 6);
	assert.equal(mouse(component, "click", 78, 6)?.handled, true);
	assert.equal(calls.done.length, 0);
	mouse(component, "press", 78, 5); // on the thumb (rows 0-7), its row 1
	mouse(component, "drag", 78, 4 + 1 + 10); // offset 10 of 10: the end
	settle();
	assert.match(footer(), /following/);
	assert.equal(bar(body()), "ttttttttttDDDDDDDD");
	mouse(component, "release", 78, 15);
});

test("live pop-up: the pointer over the bar grows its thumb; off it, or out of the pop-up, the thumb is idle again", (t) => {
	const fake = live(40);
	t.after(() => fake.component.dispose());
	hovering(fake, { onBar: [78, 4 + 2], offBar: [10, 10], above: 3, idle: "ttttttttttTTTTTTTT", hovered: "ttttttttttDDDDDDDD" });
});

// ---------------------------------------------------------------------------
// The music picker
// ---------------------------------------------------------------------------

function music(count, { name = (i) => `List ${i + 1}` } = {}) {
	const fake = fakeCtx(14); // 10 rows of categories
	const seen = { entered: 0, played: 0 };
	const playlists = Array.from({ length: count }, (_, i) => ({ provider: "cliamp", id: `p${i}`, name: name(i), tracks: 3 }));
	openMusicPicker(fake.ctx, { playlists, tracksOf: async () => (seen.entered++, []), onPlay: () => seen.played++ });
	const picker = fake.component();
	const body = () => picker.render(50).slice(2, -2);
	const first = () => content(body()[0]);
	body();
	return { ...fake, picker, body, first, seen };
}

test("music picker: more categories than rows get the scrollbar; a press on the track scrolls the view, not the cursor, and picks nothing", async () => {
	const { picker, body, first, seen, calls } = music(20);
	// 20 in 10 rows: a 5-row thumb over 5 rows as the top goes 0..10.
	assert.equal(bar(body()), "TTTTTttttt");
	assert.deepEqual(mouse(picker, "press", 48, 2 + 9), { handled: true, capture: true, render: true });
	settle();
	assert.match(first(), /^List 11 ·/);
	assert.equal(bar(body()), "tttttDDDDD");
	mouse(picker, "release", 48, 11);
	assert.equal(mouse(picker, "click", 48, 11)?.handled, true);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(seen.entered, 0, "the click after the press opens nothing");
	assert.equal(calls.done.length, 0);
	assert.match(plain(picker.render(50).at(-2)), /1\/20/, "the cursor stays on the first");
	mouse(picker, "click", 10, 2);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(seen.entered, 1, "a click on a row still opens it");
});

test("music picker: dragging the thumb moves the view in proportion and clamps; a list that fits has no bar", () => {
	const { picker, body, first } = music(20);
	mouse(picker, "press", 48, 2); // the thumb's first row
	mouse(picker, "drag", 48, 4); // offset 2 of 5 → top 4
	settle();
	assert.match(first(), /^List 5 ·/);
	assert.equal(bar(body()), "ttDDDDDttt");
	mouse(picker, "drag", 48, 50);
	settle();
	assert.match(first(), /^List 11 ·/);
	mouse(picker, "drag", 48, -10);
	settle();
	assert.match(first(), /^▸ List 1 ·/);
	mouse(picker, "release", 48, -10);
	assert.equal(bar(body()), "TTTTTttttt");
	const short = music(5);
	assert.ok(short.body().every((row) => plain(row).endsWith(" ▕")));
	const wide = music(20, { name: (i) => `${"Very long playlist name ".repeat(3)}${i}` });
	assert.ok(wide.body().every((row) => beforeBar(row) === " "), wide.body().map(plain).join("\n"));
});

test("music picker: the pointer over the bar grows its thumb; off it, or out of the pop-up, the thumb is idle again", () => {
	const fake = music(20);
	hovering({ ...fake, component: fake.picker }, { onBar: [48, 2 + 7], offBar: [10, 4], above: 1, idle: "TTTTTttttt", hovered: "DDDDDttttt" });
});

// ---------------------------------------------------------------------------
// The PROF model picker
// ---------------------------------------------------------------------------

function prof(count, { name = (i) => `model-${i + 1}` } = {}) {
	const fake = fakeCtx(17); // 12 rows of choices
	const picked = [];
	openPicker(fake.ctx, { title: "Model", choices: Array.from({ length: count }, (_, i) => name(i)), onPick: (choice) => picked.push(choice) });
	const picker = fake.component();
	const body = () => picker.render(55).slice(3, -2);
	const first = () => content(body()[0]);
	body();
	return { ...fake, picker, body, first, picked };
}

test("model picker: more choices than rows get the scrollbar; a track press scrolls the view only and its click picks nothing", () => {
	const { picker, body, first, picked, calls } = prof(30);
	// 30 in 12 rows: a 5-row thumb over 7 rows as the top goes 0..18.
	assert.equal(bar(body()), "TTTTTttttttt");
	assert.deepEqual(mouse(picker, "press", 53, 3 + 11), { handled: true, capture: true, render: true });
	settle();
	assert.equal(first(), "model-19");
	mouse(picker, "release", 53, 14);
	assert.equal(mouse(picker, "click", 53, 14)?.handled, true);
	assert.deepEqual(picked, [], "not picked");
	assert.equal(calls.done.length, 0, "not closed");
	assert.match(plain(picker.render(55).at(-2)), /1\/30/, "the cursor stays");
	mouse(picker, "click", 6, 3);
	assert.deepEqual(picked, ["model-19"], "a click on a choice still picks it");
});

test("model picker: dragging the thumb, the middle and the ends; a filtered list that fits has no bar", () => {
	const { picker, body, first } = prof(30);
	mouse(picker, "press", 53, 4); // the thumb's row 1
	mouse(picker, "drag", 53, 7); // offset 3 of 7 → top round(3/7*18) = 8
	settle();
	assert.equal(first(), "model-9");
	assert.equal(bar(body()), "tttDDDDDtttt");
	mouse(picker, "drag", 53, 99);
	settle();
	assert.equal(first(), "model-19");
	mouse(picker, "drag", 53, -99);
	settle();
	assert.equal(first(), "▸ model-1");
	mouse(picker, "release", 53, -99);
	mouse(picker, "drag", 53, 99);
	settle();
	assert.equal(first(), "▸ model-1", "released: no more dragging");
	for (const char of "model-1") picker.handleInput(char);
	assert.ok(body().every((row) => plain(row).endsWith(" ▕")), "11 matches fit");
	const wide = prof(30, { name: (i) => `${"a-very-long-provider/model-name-".repeat(3)}${i}` });
	assert.ok(wide.body().every((row) => beforeBar(row) === " "), wide.body().map(plain).join("\n"));
});

test("model picker: the pointer over the bar grows its thumb; off it, or out of the pop-up, the thumb is idle again", () => {
	const fake = prof(30);
	hovering({ ...fake, component: fake.picker }, { onBar: [53, 3 + 8], offBar: [6, 5], above: 2, idle: "TTTTTttttttt", hovered: "DDDDDttttttt" });
});

// ---------------------------------------------------------------------------
// The glide: a press on the track or a drag slides the view to where the pointer puts it, frame by frame
// ---------------------------------------------------------------------------

/** The tops `top()` takes on each frame until no glide runs. */
function glided(top) {
	const tops = [];
	for (let i = 0; clock.timers.size && i < 1000; i++) {
		frame();
		tops.push(top());
	}
	return tops;
}
/** The lines each step moved, from `from` over `tops`. */
const steps = (from, tops) => tops.map((at, i) => Math.abs(at - (i ? tops[i - 1] : from)));

test("TREE preview: a press on the track glides the view there, a third of the way left each frame, the last lines one by one", async () => {
	const { component, range } = await preview(source(40));
	const top = () => range()[0] - 1;
	mouse(component, "press", 78, 16); // the target: top 18
	assert.equal(top(), 6, "the press moves ceil(18 / 3) = 6 lines, not all the way");
	assert.equal(clock.timers.size, 1, "a glide runs");
	mouse(component, "release", 78, 16); // the release lets it finish
	const tops = glided(top);
	assert.equal(tops.at(-1), 18, "it ends exactly at the target");
	const moved = [6, ...steps(6, tops).filter(Boolean)];
	assert.deepEqual(moved, [6, 4, 3, 2, 1, 1, 1]);
	assert.ok(moved.every((step, i) => !i || step <= moved[i - 1]), "steps never grow");
	assert.equal(clock.timers.size, 0, "the timer is cleared at the target");
});

test("TREE preview: a drag during a glide retargets it", async () => {
	const { component, range } = await preview(source(40));
	const top = () => range()[0] - 1;
	mouse(component, "press", 78, 16); // toward 18
	frame();
	assert.equal(top(), 10);
	mouse(component, "drag", 78, 11); // grabbed at the thumb's middle (4): offset 3 of 10 → top round(0.3*22) = 7
	assert.equal(clock.timers.size, 1, "the same glide, retargeted");
	settle();
	assert.equal(top(), 7);
	mouse(component, "release", 78, 11);
});

test("TREE preview: the wheel or a key during a glide stops it where they put the view", async () => {
	const { component, range } = await preview(source(40));
	const top = () => range()[0] - 1;
	mouse(component, "press", 78, 16);
	mouse(component, "release", 78, 16);
	assert.equal(top(), 6);
	component.handleMouse({ type: "wheel", wheelDelta: 1, x: 3, y: 5 });
	assert.equal(top(), 9);
	frame();
	frame();
	assert.equal(top(), 9, "the wheel's scroll stays");
	assert.equal(clock.timers.size, 0, "the glide stopped");
	mouse(component, "press", 78, 4); // back toward 0: the thumb's middle at offset 0
	mouse(component, "release", 78, 4);
	assert.equal(top(), 6);
	component.handleInput("j");
	frame();
	assert.equal(top(), 7, "the key's line stays");
	assert.equal(clock.timers.size, 0);
});

test("TREE preview: closing the pop-up during a glide clears its timer: no more scrolling", async () => {
	for (const close of [(component) => component.handleInput("q"), (component) => component.dispose()]) {
		const { component } = await preview(source(40));
		mouse(component, "press", 78, 16);
		let scrolled = 0;
		const scrollTo = component.scrollTo.bind(component);
		component.scrollTo = (at) => (scrolled++, scrollTo(at));
		close(component);
		assert.equal(clock.timers.size, 0, "the timer is cleared");
		frame();
		assert.equal(scrolled, 0);
	}
});

test("live pop-up: a track press glides off the end, f stops the glide and follows again", (t) => {
	const { component, body, footer } = live(40);
	t.after(() => component.dispose());
	const top = () => Number(content(body()[0]).slice(4)) - 1;
	assert.equal(top(), 22, "following the end");
	mouse(component, "press", 78, 6); // track row 2: the thumb's middle above the top → 0
	mouse(component, "release", 78, 6);
	assert.equal(top(), 22 - 8, "ceil(22 / 3) = 8 lines");
	assert.match(footer(), /f follow/);
	frame();
	assert.equal(top(), 9);
	component.handleInput("f");
	frame();
	assert.equal(clock.timers.size, 0, "following stops the glide");
	assert.equal(top(), 22);
	assert.match(footer(), /following/);
	mouse(component, "press", 78, 6);
	mouse(component, "release", 78, 6);
	settle();
	assert.equal(top(), 0, "a glide to the top ends there");
	component.handleInput("q");
	assert.equal(clock.timers.size, 0);
});

test("live pop-up: closing it during a glide clears the timer", (t) => {
	const { component } = live(40);
	t.after(() => component.dispose());
	mouse(component, "press", 78, 6);
	assert.equal(clock.timers.size, 1);
	component.dispose();
	assert.equal(clock.timers.size, 0);
});

test("music picker: a track press glides the view, a key stops it, closing clears it", () => {
	const { picker, first } = music(20);
	mouse(picker, "press", 48, 2 + 9); // toward 10
	mouse(picker, "release", 48, 11);
	assert.match(first(), /^List 5 ·/, "ceil(10 / 3) = 4 lines");
	settle();
	assert.match(first(), /^List 11 ·/);
	mouse(picker, "press", 48, 2); // toward 0
	mouse(picker, "release", 48, 2);
	assert.match(first(), /^List 7 ·/);
	picker.handleInput("q");
	assert.equal(clock.timers.size, 0, "closed: no glide");
	frame();
	assert.match(first(), /^List 7 ·/);
});

test("model picker: a track press glides the view, the wheel stops it", () => {
	const { picker, first } = prof(30);
	mouse(picker, "press", 53, 3 + 11); // toward 18
	mouse(picker, "release", 53, 14);
	assert.equal(first(), "model-7", "ceil(18 / 3) = 6 lines");
	frame();
	assert.equal(first(), "model-11");
	settle();
	assert.equal(first(), "model-19");
	mouse(picker, "press", 53, 3); // toward 0
	mouse(picker, "release", 53, 3);
	assert.equal(first(), "model-13");
	picker.handleMouse({ type: "wheel", wheelDelta: -1, x: 6, y: 5 }); // the cursor up: the view to it, the top
	frame();
	assert.equal(clock.timers.size, 0, "the wheel stopped the glide");
	assert.equal(first(), "▸ model-1");
	picker.handleInput("\x1b");
	assert.equal(clock.timers.size, 0);
});
