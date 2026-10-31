import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { painted, plain, theme } from "./helpers.mjs";
import { languageOf, openPreview, previewLimits, previewWidthFor } from "../extensions/sidebar/tree-preview.ts";

const KEYS = { up: "\x1b[A", down: "\x1b[B", pageUp: "\x1b[5~", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F", escape: "\x1b" };

function file(name, content) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gq-preview-"));
	const full = path.join(dir, name);
	writeFileSync(full, content);
	return full;
}

// A ctx whose ui.custom records the overlay, and a TUI as tall as `rows`.
function fakeCtx(rows = 30) {
	const calls = { custom: [], done: [], renders: [], edits: 0 };
	const tui = { terminal: { rows, columns: 120 }, requestRender: (force) => calls.renders.push(force === true) };
	const ctx = {
		hasUI: true,
		ui: {
			custom: (factory, options) => {
				calls.custom.push({ factory, options });
				return new Promise(() => {});
			},
		},
	};
	// Builds the overlay's component like Pi does.
	const component = () => calls.custom.at(-1).factory(tui, theme, {}, (value) => calls.done.push(value));
	return { ctx, tui, calls, component };
}

async function preview(content, { name = "app.js", rows = 30, relPath = `src/${name}` } = {}) {
	const target = content === undefined ? path.join(os.tmpdir(), `gq-preview-missing-${Date.now()}`, name) : file(name, content);
	const fake = fakeCtx(rows);
	const opened = openPreview(fake.ctx, { file: target, relPath, onEdit: () => fake.calls.edits++ });
	assert.equal(opened, true);
	const component = fake.component();
	await component.ready;
	const draw = (width = 80) => component.render(width);
	return { ...fake, component, target, draw, text: (width) => draw(width).map(plain) };
}

const lines = (count) => Array.from({ length: count }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n") + "\n";

test("the overlay opens centered, 65% of the terminal wide but at most 125 columns, and asks Pi for an overlay", async () => {
	const { calls } = await preview("a\n");
	assert.equal(calls.custom.length, 1);
	const { options } = calls.custom[0];
	assert.equal(options.overlay, true);
	assert.equal(typeof options.overlayOptions, "function", "sized after the terminal it opens on");
	const sized = (columns) => previewWidthFor(columns);
	assert.equal(sized(220), 125, "capped on wide terminals");
	assert.equal(sized(150), 97);
	assert.equal(sized(80), 60, "never under 60");
	const { width, ...rest } = options.overlayOptions();
	assert.deepEqual(rest, { anchor: "center", minWidth: 60, maxHeight: "85%" });
	assert.ok(width >= 60 && width <= 125);
});

test("title, language, path, numbered lines and the footer range in a square outline", async () => {
	const { text, draw } = await preview(lines(168), { rows: 30 });
	const out = text(80);
	assert.ok(out.every((row) => [...row].length === 80), "every row as wide as the overlay");
	assert.match(out[0], /^🭽▔+🭾$/u, "outline strokes at the outer edge of the cells");
	assert.match(out.at(-1), /^🭼▁+🭿$/u);
	assert.match(out[1], /^▏ Read-only — JavaScript +▕$/);
	assert.match(out[2], /^▏ src\/app\.js +▕$/);
	assert.match(out[3], /^▏ +▕$/);
	assert.match(out[4], /^▏   1 const line1 = 1; +▕$/, "numbers right-aligned to the widest");
	assert.match(out[5], /^▏   2 const line2 = 2;/);
	// 30 rows * 85% = 25 rows for the overlay, 6 of them chrome: 19 lines of code.
	assert.equal(out.length, 25);
	assert.match(out.at(-2), /^▏ Esc close · e edit · ↑↓ PgUp\/PgDn Home\/End · 1-19 \/ 168 +▕$/);
	const raw = draw(80);
	assert.ok(painted(raw[0], "border", "🭽"), "outline in the border role");
	assert.ok(painted(raw[4], "border", "▏") && painted(raw[4], "border", "▕"), "sides in the border role");
	assert.ok(painted(raw.at(-1), "border", "🭼"));
	assert.ok(painted(raw[1], "toolTitle", theme.bold("Read-only — JavaScript")));
	assert.ok(painted(raw[2], "muted", "src/app.js"));
	assert.ok(painted(raw[4], "dim", "  1"), "line numbers dim");
	assert.ok(painted(raw.at(-2), "dim", "Esc close"));
});

test("scroll keys move the range: arrows, j/k, pages, Home/End and g/G", async () => {
	const { component, text, calls } = await preview(lines(168), { rows: 30 });
	const range = () => text(80).at(-2).match(/(\d+)-(\d+) \/ 168/).slice(1).map(Number);
	component.handleInput(KEYS.down);
	assert.deepEqual(range(), [2, 20]);
	component.handleInput("j");
	assert.deepEqual(range(), [3, 21]);
	component.handleInput("k");
	component.handleInput(KEYS.up);
	assert.deepEqual(range(), [1, 19]);
	component.handleInput(KEYS.up);
	assert.deepEqual(range(), [1, 19], "nothing above the first line");
	component.handleInput(KEYS.pageDown);
	assert.deepEqual(range(), [20, 38]);
	component.handleInput(KEYS.pageUp);
	assert.deepEqual(range(), [1, 19]);
	component.handleInput(KEYS.end);
	assert.deepEqual(range(), [150, 168]);
	assert.match(text(80).at(-3), /168 const line168 = 168;/);
	component.handleInput(KEYS.pageDown);
	assert.deepEqual(range(), [150, 168], "nothing below the last line");
	component.handleInput(KEYS.home);
	assert.deepEqual(range(), [1, 19]);
	component.handleInput("G");
	assert.deepEqual(range(), [150, 168]);
	component.handleInput("g");
	assert.deepEqual(range(), [1, 19]);
	assert.ok(calls.renders.length > 0, "keys ask for a redraw");
	assert.equal(calls.done.length, 0);
});

test("the mouse wheel scrolls three lines", async () => {
	const { component, text } = await preview(lines(168), { rows: 30 });
	assert.deepEqual(component.handleMouse({ type: "wheel", wheelDelta: 1, x: 3, y: 5 }), { handled: true, render: true });
	assert.match(text(80).at(-2), /4-22 \/ 168/);
	component.handleMouse({ type: "wheel", wheelDelta: -1, x: 3, y: 5 });
	assert.match(text(80).at(-2), /1-19 \/ 168/);
});

test("Esc and q close the overlay and repaint behind it", async () => {
	for (const key of [KEYS.escape, "q"]) {
		const { component, calls } = await preview("a\n");
		component.handleInput(key);
		assert.equal(calls.done.length, 1, `${JSON.stringify(key)} closes`);
		assert.ok(calls.renders.includes(true), "a full repaint after closing");
		assert.equal(calls.edits, 0);
	}
});

test("e closes the overlay and opens the file in the editor", async () => {
	const { component, calls } = await preview("a\n");
	component.handleInput("e");
	assert.equal(calls.done.length, 1);
	assert.equal(calls.edits, 1);
});

test("a short file is drawn whole and its footer counts all its lines", async () => {
	const { text } = await preview("one\n\ttwo\nthree", { name: "notes.txt", relPath: "notes.txt" });
	const out = text(70);
	assert.match(out[1], /Read-only — Text/);
	assert.match(out[4], /^▏ 1 one +▕$/);
	assert.match(out[5], /^▏ 2     two +▕$/, "a tab becomes spaces up to the next stop of 4");
	assert.match(out[6], /^▏ 3 three +▕$/);
	assert.match(out[7], /1-3 \/ 3 +▕$/);
	assert.equal(out.length, 9);
});

test("long lines are cut with an ellipsis instead of wrapping", async () => {
	const { text } = await preview(`${"x".repeat(200)}\nshort\n`, { name: "a.ts" });
	const out = text(60);
	assert.equal(out.length, 8);
	assert.match(out[4], /^▏ 1 x+… ▕$/);
	assert.ok(out.every((row) => [...row].length === 60));
});

test("a binary file, an empty file and a missing file get one row", async () => {
	const binary = await preview(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), { name: "logo.png" });
	assert.match(binary.text(70)[4], /^▏ Binary file — press e to open it in the editor +▕$/);
	assert.match(binary.text(70).at(-2), /^▏ Esc close · e edit +▕$/);

	const empty = await preview("", { name: "empty.md" });
	assert.match(empty.text(70)[1], /Read-only — Markdown/);
	assert.match(empty.text(70)[4], /^▏ \(empty file\) +▕$/);

	const missing = await preview(undefined, { name: "gone.ts" });
	assert.match(missing.text(70)[4], /ENOENT/);
	assert.ok(painted(missing.draw(70)[4], "warning"), "the error in the warning color");
	missing.component.handleInput("e");
	assert.equal(missing.calls.edits, 1, "e still opens the editor");
});

test("a file over the size limit is read up to it and says so", async (t) => {
	const saved = previewLimits.maxBytes;
	previewLimits.maxBytes = 64;
	t.after(() => (previewLimits.maxBytes = saved));
	const { text } = await preview(lines(40), { name: "big.js" });
	assert.match(text(80)[2], /src\/big\.js · first 64 bytes/);
	assert.ok(!text(80).at(-2).includes("/ 40"), "only what was read is counted");
});

test("control characters in the file never reach the terminal", async () => {
	const { draw } = await preview("a\x1b[31mred\x07\n", { name: "x.txt" });
	assert.ok(!draw(60)[4].includes("\x1b[31m"));
	assert.ok(!draw(60)[4].includes("\x07"));
});

test("languages by extension", () => {
	const cases = { "a.ts": "TypeScript", "a.tsx": "TypeScript", "a.mjs": "JavaScript", "a.cjs": "JavaScript", "a.js": "JavaScript", "a.json": "JSON", "README.md": "Markdown", "a.py": "Python", "a.go": "Go", "a.rs": "Rust", "a.sh": "Shell", "a.zsh": "Shell", "a.bash": "Shell", "a.css": "CSS", "a.html": "HTML", "a.yml": "YAML", "a.yaml": "YAML", "a.toml": "TOML", "Makefile": "Text", "a.weird": "Text" };
	for (const [name, language] of Object.entries(cases)) assert.equal(languageOf(name), language, name);
});

test("without an overlay UI openPreview declines and opens nothing", () => {
	const onEdit = () => assert.fail("not called");
	assert.equal(openPreview(undefined, { file: "/x", relPath: "x", onEdit }), false);
	assert.equal(openPreview({ hasUI: false, ui: { custom: () => {} } }, { file: "/x", relPath: "x", onEdit }), false);
	assert.equal(openPreview({ hasUI: true, ui: {} }, { file: "/x", relPath: "x", onEdit }), false);
	assert.equal(openPreview({ hasUI: true, ui: { custom: () => { throw new Error("no tui"); } } }, { file: "/x", relPath: "x", onEdit }), false);
});

const README = "# pi-gentle-quiet\n\nA **bold** claim and *soft* words with `code`.\n\n- one\n- two\n";

test("a Markdown file is shown rendered, without the raw markers or line numbers", async () => {
	const { text, draw } = await preview(README, { name: "README.md", relPath: "README.md" });
	const out = text(70);
	assert.ok(out.every((row) => [...row].length === 70), "every row as wide as the overlay");
	assert.match(out[1], /^▏ Read-only — Markdown +▕$/);
	assert.match(out[4], /^▏ pi-gentle-quiet +▕$/, "the heading without its #");
	const body = out.slice(4, -2).join("\n");
	assert.match(body, /A bold claim and soft words with code\./);
	assert.ok(!body.includes("**") && !body.includes("`") && !body.includes("# "), "no raw markers");
	assert.ok(!/▏ +\d+ /.test(body), "no line numbers");
	assert.match(out.at(-2), /^▏ Esc close · e edit · m source · ↑↓ PgUp\/PgDn Home\/End · 1-\d+ \/ \d+ +▕$/);
	assert.ok(draw(70)[4].includes(theme.bold("pi-gentle-quiet")), "the heading styled by the Markdown theme");
});

test("m toggles a Markdown file between rendered and numbered source", async () => {
	const { component, text } = await preview(README, { name: "notes.markdown", relPath: "notes.markdown" });
	assert.match(text(70)[1], /Read-only — Markdown/, ".markdown is Markdown too");
	assert.match(text(70)[4], /^▏ pi-gentle-quiet +▕$/);
	component.handleInput("m");
	let out = text(70);
	assert.match(out[4], /^▏ 1 # pi-gentle-quiet +▕$/, "the raw source, numbered");
	assert.match(out[6], /^▏ 3 A \*\*bold\*\* claim/);
	assert.match(out.at(-2), /^▏ Esc close · e edit · m rendered · ↑↓ PgUp\/PgDn Home\/End · 1-6 \/ 6 +▕$/);
	component.handleInput("m");
	out = text(70);
	assert.match(out[4], /^▏ pi-gentle-quiet +▕$/);
	assert.match(out.at(-2), / m source /);
});

test("toggling with m starts the other view from its top", async () => {
	const long = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}.\n`).join("\n");
	const { component, text } = await preview(long, { name: "long.md", rows: 30 });
	assert.match(text(90).at(-2), / m source · .* 1-19 \/ 159 /);
	component.handleInput("\x1b[6~");
	assert.match(text(90).at(-2), / 20-38 \/ 159 /, "the rendered rows scroll by pages");
	component.handleInput("m");
	assert.match(text(90).at(-2), / m rendered · .* 1-19 \/ 159 /);
	assert.match(text(90)[4], /^▏   1 Paragraph 1\. +▕$/);
});

test("without Markdown rendering a Markdown file falls back to its numbered source", async (t) => {
	globalThis.testMarkdownBroken = true;
	t.after(() => delete globalThis.testMarkdownBroken);
	const { component, text } = await preview(README, { name: "README.md", relPath: "README.md" });
	const out = text(70);
	assert.match(out[1], /Read-only — Markdown/);
	assert.match(out[4], /^▏ 1 # pi-gentle-quiet +▕$/);
	assert.match(out.at(-2), /^▏ Esc close · e edit · ↑↓/, "no m key when there is nothing to toggle");
	component.handleInput("m");
	assert.match(text(70)[4], /^▏ 1 # pi-gentle-quiet +▕$/, "m does nothing");
});

test("other languages keep their numbered source and no m key", async () => {
	const { component, text } = await preview("# not a heading\n", { name: "a.py" });
	assert.match(text(70)[4], /^▏ 1 # not a heading +▕$/);
	assert.doesNotMatch(text(70).at(-2), / m /);
	component.handleInput("m");
	assert.match(text(70)[4], /^▏ 1 # not a heading +▕$/);
});

test("given text instead of a file: its title on the path row, the body rendered as Markdown, and no e", async () => {
	const fake = fakeCtx(30);
	let body;
	const text = new Promise((resolve) => (body = resolve));
	assert.equal(openPreview(fake.ctx, { text, title: "#41 · bugfix · Gauge", label: "Memory" }), true);
	const component = fake.component();
	assert.match(plain(component.render(70)[4]), /Reading…/, "while the text is on its way");
	body("**What**: the gauge\n\n- rounded down\n");
	await component.ready;
	const out = component.render(70).map(plain);
	assert.match(out[1], /^▏ Read-only — Memory +▕$/);
	assert.match(out[2], /^▏ #41 · bugfix · Gauge +▕$/);
	assert.match(out[4], /^▏ What: the gauge +▕$/);
	assert.ok(!out.join("\n").includes("**"));
	assert.match(out.at(-2), /^▏ Esc close · m source · ↑↓/, "no e edit in the footer");
	component.handleInput("e");
	assert.equal(fake.calls.done.length, 0, "e does nothing");
	component.handleInput("m");
	assert.match(component.render(70).map(plain)[4], /^▏ 1 \*\*What\*\*: the gauge +▕$/);
	component.handleInput("\x1b");
	assert.equal(fake.calls.done.length, 1);
});

test("given empty or failed text: one row, never a file read", async () => {
	for (const [text, row] of [["", /\(empty\)/], [Promise.reject(new Error("gone")), /Cannot read: gone/]]) {
		const fake = fakeCtx(30);
		assert.equal(openPreview(fake.ctx, { text, title: "#1", label: "Memory" }), true);
		const component = fake.component();
		await component.ready;
		assert.match(plain(component.render(70)[4]), row);
	}
});

// A TUI routing the mouse as Pi 1.4.0 does (tui.ts handleMouseEvent, trimmed): an overlay gets a press only
// inside its box, else the layout under it does; the release and the click go to whatever answered the press.
class MouseTui {
	constructor(rows = 30) {
		this.terminal = { rows, columns: 120 };
		this.overlays = []; // { component, col, row, width, height }
		this.layoutEvents = []; // what reached the layout (a TREE row, the conversation)
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
	// One left click (press, release, click) at x, y; `type` "wheel" sends one wheel notch instead.
	click(x, y, { button = "left", type = "press" } = {}) {
		const event = (kind) => ({ type: kind, button, x, y, screenX: x, screenY: y, width: this.terminal.columns, height: this.terminal.rows, ...(kind === "wheel" ? { wheelDelta: 1 } : {}) });
		const overlay = this.dispatchMouseToOverlay(event(type));
		const result = overlay.result ?? (overlay.hit ? undefined : this.layout(event(type)));
		if (type !== "press" || !result) return;
		for (const kind of ["release", "click"]) result.target.component.handleMouse?.(event(kind));
	}
}

// The preview of a file mounted as Pi mounts an overlay: 60 columns wide from column 30, rows 2 to 21.
async function mounted() {
	const tui = new MouseTui(30);
	const done = [];
	const ctx = { hasUI: true, ui: { custom: (factory) => {
		const entry = { col: 30, row: 2, width: 60, height: 20 };
		entry.component = factory(tui, theme, {}, (value) => {
			done.push(value);
			tui.overlays = tui.overlays.filter((other) => other !== entry); // Pi hides it
		});
		tui.overlays.push(entry);
		return new Promise(() => {});
	} } };
	assert.equal(openPreview(ctx, { file: file("a.ts", lines(40)), relPath: "a.ts", onEdit: () => {} }), true);
	const component = tui.overlays[0].component;
	await component.ready;
	return { tui, done, component };
}

test("a click outside the pop-up closes it, and that click reaches nothing under it", async () => {
	const { tui, done } = await mounted();
	tui.click(5, 10); // on the conversation, left of the pop-up
	assert.equal(done.length, 1, "closed");
	assert.deepEqual(tui.layoutEvents, [], "no press, release or click reached the row under the pointer");
	assert.ok(tui.renders.includes(true), "a full repaint after closing");
	tui.click(100, 10);
	assert.deepEqual(tui.layoutEvents, ["press", "release", "click"], "once closed, clicks reach the layout again");
	assert.equal(done.length, 1);
});

test("outside the pop-up, any button's press closes it; the wheel there does not", async () => {
	for (const [x, y] of [[100, 5], [40, 0], [40, 25]]) {
		const { tui, done } = await mounted();
		tui.click(x, y, { button: "right" });
		assert.equal(done.length, 1, `a press at ${x},${y}`);
		assert.deepEqual(tui.layoutEvents, []);
	}
	const { tui, done } = await mounted();
	tui.click(100, 5, { type: "wheel" });
	assert.equal(done.length, 0, "the wheel scrolls what is under it and leaves the pop-up open");
	assert.deepEqual(tui.layoutEvents, ["wheel"]);
});

test("a click inside the pop-up keeps it open; its wheel still scrolls it", async () => {
	const { tui, done, component } = await mounted();
	tui.click(30, 2); // its top-left corner
	tui.click(89, 21); // its bottom-right corner
	tui.click(50, 10);
	assert.equal(done.length, 0);
	assert.deepEqual(tui.layoutEvents, []);
	tui.click(50, 10, { type: "wheel" });
	assert.match(plain(component.render(60).at(-2)), /4-\d+ \/ 40/);
});

test("Esc still closes the pop-up, and then clicks outside go where they used to", async () => {
	const { tui, done, component } = await mounted();
	component.handleInput("\x1b");
	assert.equal(done.length, 1);
	assert.ok(!Object.hasOwn(tui, "dispatchMouseToOverlay"), "Pi's own routing is back");
	tui.click(5, 10);
	assert.equal(done.length, 1);
	assert.deepEqual(tui.layoutEvents, ["press", "release", "click"]);
});

test("a click outside closes only the top overlay: another overlay over the pop-up keeps it open", async () => {
	const { tui, done } = await mounted();
	tui.overlays.push({ col: 0, row: 0, width: 10, height: 3, component: { handleMouse: () => undefined } });
	tui.click(100, 10);
	assert.equal(done.length, 0, "the pop-up is not the top overlay");
	assert.deepEqual(tui.layoutEvents, ["press", "release", "click"]);
});
