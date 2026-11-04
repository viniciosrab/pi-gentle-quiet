import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { painted, plain, theme } from "./helpers.mjs";
import { changeBlocks, parseFileDiff } from "../extensions/sidebar/diff-preview.ts";
import { openPreview, previewDeps } from "../extensions/sidebar/tree-preview.ts";
import * as scrollbarModule from "../extensions/sidebar/scrollbar.ts";

// The scrollbar's glide, its frames driven by hand: settle() runs them until no glide runs.
const clock = { timers: new Map(), next: 1 };
Object.assign(scrollbarModule.scrollbarDeps ?? {}, {
	setInterval: (fn) => {
		const id = clock.next++;
		clock.timers.set(id, fn);
		return { id, unref() {} };
	},
	clearInterval: (handle) => clock.timers.delete(handle?.id),
});
const frame = () => [...clock.timers.values()].forEach((fn) => fn());
function settle() {
	for (let i = 0; clock.timers.size && i < 1000; i++) frame();
}

function file(name, content) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gq-diff-"));
	const full = path.join(dir, name);
	writeFileSync(full, content);
	return full;
}

// The pop-up of `target` opened as the GIT tab opens it, with `changes`, on a terminal `rows` tall.
async function opened(target, changes, { rows = 30, relPath = path.basename(target), with: painter = theme } = {}) {
	const calls = { custom: [], done: [], edits: 0 };
	const tui = { terminal: { rows, columns: 120 }, requestRender() {} };
	const ctx = { hasUI: true, ui: { custom: (factory, options) => (calls.custom.push({ factory, options }), new Promise(() => {})) } };
	assert.equal(openPreview(ctx, { file: target, relPath, onEdit: () => calls.edits++, changes }), true);
	const component = calls.custom[0].factory(tui, painter, {}, (value) => calls.done.push(value));
	await component.ready;
	return { component, calls, draw: (width = 80) => component.render(width), text: (width = 80) => component.render(width).map(plain) };
}

const header = (name) => [`diff --git a/${name} b/${name}`, "index 1111111..2222222 100644", `--- a/${name}`, `+++ b/${name}`];
const SMALL = [...header("src/a.ts"), "@@ -1,6 +1,6 @@", " one", "-two", "+TWO", "+two and a half", " three", " four", "-five", " six", ""].join("\n");

// 60 lines; line 30 replaced, line 50 removed: 61 rows, changes at rows 29-30 and 50.
const L = (n) => `L${n}`;
const LONG = [
	...header("long.ts"),
	"@@ -1,60 +1,59 @@",
	...Array.from({ length: 29 }, (_, i) => ` ${L(i + 1)}`),
	`-${L(30)}`,
	"+X30",
	...Array.from({ length: 19 }, (_, i) => ` ${L(i + 31)}`),
	`-${L(50)}`,
	...Array.from({ length: 10 }, (_, i) => ` ${L(i + 51)}`),
	"",
].join("\n");

test("parseFileDiff: the whole file as rows, removed lines where they were, old and new line numbers", () => {
	const parsed = parseFileDiff(SMALL);
	assert.deepEqual(parsed.rows, [
		{ sign: " ", text: "one", old: 1, number: 1 },
		{ sign: "-", text: "two", old: 2 },
		{ sign: "+", text: "TWO", number: 2 },
		{ sign: "+", text: "two and a half", number: 3 },
		{ sign: " ", text: "three", old: 3, number: 4 },
		{ sign: " ", text: "four", old: 4, number: 5 },
		{ sign: "-", text: "five", old: 5 },
		{ sign: " ", text: "six", old: 6, number: 6 },
	]);
	assert.equal(parsed.added, 2);
	assert.equal(parsed.removed, 2);
	assert.deepEqual(changeBlocks(parsed.rows), [1, 6], "where each run of changed rows starts");
});

test("parseFileDiff: a removed line that looks like a header, CRLF, no-newline marks; nothing for binary or empty diffs", () => {
	const parsed = parseFileDiff([...header("x"), "@@ -1,2 +1,1 @@", "--- not a header\r", " kept\r", "\\ No newline at end of file", ""].join("\n"));
	assert.deepEqual(parsed.rows, [{ sign: "-", text: "-- not a header", old: 1 }, { sign: " ", text: "kept", old: 2, number: 1 }]);
	const deleted = parseFileDiff(["diff --git a/x b/x", "deleted file mode 100644", "--- a/x", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-a", "-b", ""].join("\n"));
	assert.deepEqual(deleted.rows.map((row) => row.sign), ["-", "-"]);
	assert.equal(parseFileDiff("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n"), undefined);
	assert.equal(parseFileDiff(""), undefined);
	assert.equal(parseFileDiff(undefined), undefined);
});

test("a changed file shows its changes inline as VS Code's: the line number, then the sign, then the code", async () => {
	const target = file("a.ts", "one\nTWO\ntwo and a half\nthree\nfour\nsix\n");
	const { text, draw } = await opened(target, { diff: Promise.resolve(SMALL) }, { relPath: "src/a.ts" });
	const out = text(70);
	assert.match(out[1], /^▏ Read-only — TypeScript · changes +▕$/);
	assert.match(out[2], /^▏ src\/a\.ts +▕$/);
	assert.deepEqual(out.slice(4, 12).map((row) => row.slice(2).trimEnd().replace(/ ▕$/, "").trimEnd()), [
		"1   one",
		"  − two",
		"2 + TWO",
		"3 + two and a half",
		"4   three",
		"5   four",
		"  − five",
		"6   six",
	]);
	assert.match(out.at(-2), /^▏ Esc close · e edit · n\/N change · \+2 −2 · 1-8 \/ 8 +▕$/, "the scroll keys left out where they do not fit");
	assert.match(out.at(-3), /^▏ +▕$/, "a blank row between the content and the footer");
	assert.match(text(90).at(-2), /^▏ Esc close · e edit · n\/N change · \+2 −2 · ↑↓ PgUp\/PgDn Home\/End · 1-8 \/ 8 +▕$/);
	const raw = draw(70);
	assert.ok(painted(raw[5], "toolDiffRemoved", "−") && painted(raw[6], "toolDiffAdded", "+"), "the sign in the diff color");
	assert.ok(!painted(raw[5], "toolDiffRemoved", "two") && !painted(raw[6], "toolDiffAdded", "TWO"), "the code keeps its own color");
	assert.ok(painted(raw[6], "dim", "2") && !painted(raw[5], "dim", "2"), "numbers dim, none on a removed row");
	assert.ok(painted(raw[4], "dim", "1") && !painted(raw[4], "toolDiffAdded"), "unchanged rows carry no diff color");
	assert.ok(painted(raw.at(-2), "toolDiffAdded", "+2") && painted(raw.at(-2), "toolDiffRemoved", "−2"), "the summary in diff colors");
});

// A truecolor theme as Pi's: fg/getFgAnsi in 38;2, bg roles in 48;2, dark.
const RGB = { toolDiffAdded: [100, 200, 40], toolDiffRemoved: [200, 40, 40], dim: [90, 90, 90], toolTitle: [1, 2, 3], muted: [4, 5, 6], border: [7, 8, 9], warning: [10, 11, 12] };
const fgOf = (name) => `\x1b[38;2;${(RGB[name] ?? [250, 250, 250]).join(";")}m`;
const truecolor = {
	fg: (name, text) => `${fgOf(name)}${text}\x1b[39m`,
	bg: (name, text) => `\x1b[48;2;9;9;9m${text}\x1b[49m`,
	getFgAnsi: fgOf,
	getBgAnsi: () => "\x1b[48;2;9;9;9m",
	getColorMode: () => "truecolor",
	appearance: "dark",
	bold: (text) => text,
};
// A theme of 256-color indices (the "system" theme where the terminal reports no palette): tints from its bg roles.
const BG = { toolSuccessBg: 22, toolErrorBg: 52 };
const indexed = {
	fg: theme.fg,
	bold: theme.bold,
	bg: (name, text) => `\x1b[48;5;${BG[name]}m${text}\x1b[49m`,
	getBgAnsi: (name) => `\x1b[48;5;${BG[name]}m`,
	getFgAnsi: (name) => theme.fg(name, "").replace(/\x1b\[39m$/, ""),
	getColorMode: () => "256color",
};
const ADDED_TINT = "\x1b[48;2;25;50;10m"; // 25% of (100,200,40) over black
const REMOVED_TINT = "\x1b[48;2;50;10;10m"; // 25% of (200,40,40) over black
// The part of `row` under the tint opened at its first `open`, up to the bg reset.
const tinted = (row, open) => row.slice(row.indexOf(open), row.indexOf("\x1b[49m", row.indexOf(open)));

test("a changed row is tinted across the whole pop-up width with the theme's diff color blended over its background", async () => {
	const target = file("a.ts", "x\n");
	const { draw } = await opened(target, { diff: Promise.resolve(SMALL) }, { with: truecolor });
	const raw = draw(70);
	assert.ok(raw[5].includes(REMOVED_TINT), "removed: red over black");
	assert.ok(raw[6].includes(ADDED_TINT) && raw[7].includes(ADDED_TINT), "added: green over black");
	assert.ok(!/\x1b\[48;/.test(raw[4]) && !/\x1b\[48;/.test(raw[8]), "no tint on unchanged rows");
	assert.equal(visibleWidth(tinted(raw[6], ADDED_TINT)), 68, "from the left border to the right one");
	assert.ok(plain(raw[6]).startsWith("▏ 2 + TWO"));
	assert.ok(raw[6].endsWith(`\x1b[49m${fgOf("border")}▕\x1b[39m`), "the bg reset before the right border");
	const codes = raw.join("").match(/\x1b\[48;2;[\d;]+m/g);
	assert.deepEqual([...new Set(codes)].sort(), [ADDED_TINT, REMOVED_TINT].sort(), "only the two derived tints");
	// A light theme blends toward white.
	const light = await opened(target, { diff: Promise.resolve(SMALL) }, { with: { ...truecolor, appearance: "light" } });
	assert.ok(light.draw(70)[6].includes("\x1b[48;2;216;241;201m"), "25% of (100,200,40) over white");
});

test("a monochrome theme, whose added and removed colors are both gray, still tells them apart: removed rows darker and faded", async (t) => {
	const saved = { ...previewDeps };
	t.after(() => Object.assign(previewDeps, saved));
	previewDeps.getLanguageFromPath = () => "typescript";
	previewDeps.highlightCode = (code) => code.split("\n").map((line) => `\x1b[38;5;99m${line}\x1b[39m`);
	const GRAY = { ...RGB, toolDiffAdded: [180, 180, 180], toolDiffRemoved: [170, 170, 172] };
	const grayFg = (name) => `\x1b[38;2;${(GRAY[name] ?? [250, 250, 250]).join(";")}m`;
	const mono = { ...truecolor, fg: (name, text) => `${grayFg(name)}${text}\x1b[39m`, getFgAnsi: grayFg };
	const target = file("a.ts", "x\n");
	const raw = (await opened(target, { diff: Promise.resolve(SMALL) }, { with: mono })).draw(70);
	assert.ok(raw[6].includes("\x1b[48;2;45;45;45m"), "added: 25% of (180,180,180) over black");
	assert.ok(raw[5].includes("\x1b[48;2;21;21;22m"), "removed: half as much, 12.5% of (170,170,172)");
	assert.ok(raw[6].includes("\x1b[38;5;99mTWO"), "added rows keep their syntax colors");
	assert.ok(!raw[5].includes("\x1b[38;5;99m") && raw[5].includes(`${grayFg("dim")}two`), "removed rows: the plain code in dim");
	assert.equal(visibleWidth(tinted(raw[5], "\x1b[48;2;21;21;22m")), 68, "still across the whole width");
	// A colored theme is drawn as before: the removed row keeps its syntax colors and its full tint.
	const colored = (await opened(target, { diff: Promise.resolve(SMALL) }, { with: truecolor })).draw(70);
	assert.ok(colored[5].includes(REMOVED_TINT) && colored[5].includes("\x1b[38;5;99mtwo"));
});

test("a theme of indexed colors tints changed rows with its toolSuccessBg / toolErrorBg roles", async () => {
	const target = file("a.ts", "x\n");
	for (const painter of [indexed, { ...truecolor, bg: indexed.bg, getBgAnsi: indexed.getBgAnsi, getColorMode: () => "256color" }]) {
		const raw = (await opened(target, { diff: Promise.resolve(SMALL) }, { with: painter })).draw(70);
		assert.ok(raw[5].includes("\x1b[48;5;52m") && raw[6].includes("\x1b[48;5;22m"));
		assert.ok(!raw.join("").includes("\x1b[48;2;"), "no truecolor tint in a 256-color mode");
		assert.equal(visibleWidth(tinted(raw[6], "\x1b[48;5;22m")), 68);
	}
});

test("syntax colors stay on changed rows, removed ones too, and the tint comes back after every inner reset", async (t) => {
	const saved = { ...previewDeps };
	t.after(() => Object.assign(previewDeps, saved));
	const seen = [];
	previewDeps.getLanguageFromPath = () => "typescript";
	previewDeps.highlightCode = (code) => (seen.push(code), code.split("\n").map((line) => `\x1b[38;5;0m\x1b[38;5;99m${line}\x1b[0m!\x1b[49m?`));
	const target = file("a.ts", "x\n");
	const raw = (await opened(target, { diff: Promise.resolve(SMALL) }, { with: truecolor })).draw(70);
	assert.deepEqual(seen.sort(), ["one\nTWO\ntwo and a half\nthree\nfour\nsix", "one\ntwo\nthree\nfour\nfive\nsix"].sort(), "the new file and the old one, each whole");
	assert.ok(raw[6].includes("\x1b[38;5;99mTWO") && raw[5].includes("\x1b[38;5;99mtwo"), "highlighted, added and removed");
	assert.ok(raw[6].includes(`\x1b[0m${ADDED_TINT}!`) && raw[5].includes(`\x1b[0m${REMOVED_TINT}!`), "the tint again after a full reset");
	assert.ok(raw[6].includes(`!\x1b[49m${ADDED_TINT}?`), "and after a background reset");
	assert.ok(raw[6].includes("\x1b[38;5;0m\x1b[38;5;99m"), "a color whose index is 0 is not a reset");
	assert.ok(raw[4].includes("\x1b[38;5;99mone"));
});

test("every color of the changes view comes from the theme's roles: no fixed truecolor codes", async () => {
	const target = file("a.ts", "x\n");
	const used = new Set();
	const recording = { fg: (name, text) => (used.add(name), theme.fg(name, text)), bold: theme.bold };
	const calls = [];
	const ctx = { hasUI: true, ui: { custom: (factory) => (calls.push(factory), new Promise(() => {})) } };
	openPreview(ctx, { file: target, relPath: "src/a.ts", onEdit() {}, changes: { diff: Promise.resolve(SMALL) } });
	const component = calls[0]({ terminal: { rows: 30, columns: 120 }, requestRender() {} }, recording, {}, () => {});
	await component.ready;
	const rows = component.render(70);
	for (const role of ["toolDiffAdded", "toolDiffRemoved", "dim"]) assert.ok(used.has(role), role);
	for (const row of rows) assert.doesNotMatch(row, /\x1b\[(38|48);2;/, "no truecolor from a theme that has none");
	for (const row of rows) assert.doesNotMatch(row.replace(/\x1b\[38;5;\d+m|\x1b\[39m|\x1b\[22m|\x1b\[1m/g, ""), /\x1b\[/, "only the theme's escapes");
	// Another theme paints the same rows in its own codes.
	const other = { fg: (name, text) => `<${name}>${text}</>`, bold: (text) => text };
	const again = [];
	openPreview({ hasUI: true, ui: { custom: (factory) => (again.push(factory), new Promise(() => {})) } }, { file: target, relPath: "src/a.ts", changes: { diff: Promise.resolve(SMALL) } });
	const repainted = again[0]({ terminal: { rows: 30, columns: 120 }, requestRender() {} }, other, {}, () => {});
	await repainted.ready;
	const out = repainted.render(70);
	assert.ok(out[5].includes("<toolDiffRemoved>") && out[6].includes("<toolDiffAdded>"));
});

test("the pop-up opens at the first change, and n/N ] [ jump between change blocks", async () => {
	const target = file("long.ts", "x\n");
	const { component, text } = await opened(target, { diff: Promise.resolve(LONG) }, { rows: 30 });
	const range = () => text(80).at(-2).match(/(\d+)-(\d+) \/ (\d+)/).slice(1).map(Number);
	assert.deepEqual(range(), [27, 44, 61], "three rows of context above the first change");
	assert.ok(text(80).some((row) => /^▏    − L30 /.test(row)) && text(80).some((row) => /^▏ 30 \+ X30 /.test(row)));
	assert.equal(component.handleInput("n"), true);
	assert.deepEqual(range(), [44, 61, 61], "the next block, as far as the end allows");
	assert.ok(text(80).some((row) => /^▏    − L50 /.test(row)));
	assert.equal(component.handleInput("n"), false, "no block after the last");
	component.handleInput("N");
	assert.deepEqual(range(), [27, 44, 61]);
	component.handleInput("]");
	assert.deepEqual(range(), [44, 61, 61]);
	component.handleInput("[");
	assert.deepEqual(range(), [27, 44, 61]);
	assert.equal(component.handleInput("N"), false, "no block before the first");
	component.handleInput("g");
	assert.deepEqual(range(), [1, 18, 61]);
	component.handleInput("n");
	assert.deepEqual(range(), [27, 44, 61], "from the top, n goes to the first block");
	component.handleInput("G");
	component.handleInput("N");
	assert.deepEqual(range(), [27, 44, 61], "from the end, N goes to the block above the view's top");
	assert.match(text(80).at(-2), /n\/N change · \+1 −2 ·/);
});

test("a long changed line wraps: the rest under its code, tinted, with no numbers or sign", async () => {
	const long = "word ".repeat(30).trim();
	const diff = [...header("w.ts"), "@@ -1,2 +1,2 @@", " one", `-old ${long}`, `+new ${long}`, ""].join("\n");
	const { text, draw } = await opened(file("w.ts", "x\n"), { diff: Promise.resolve(diff) }, { with: truecolor });
	const out = text(60);
	assert.match(out[5], /^▏   − old word/);
	assert.match(out[6], /^▏     word/, "the removed line goes on, under its code");
	const added = out.findIndex((row) => /^▏ 2 \+ new word/.test(row));
	assert.ok(added > 6);
	assert.match(out[added + 1], /^▏     word/);
	const raw = draw(60);
	assert.ok(raw[6].includes(REMOVED_TINT) && raw[added + 1].includes(ADDED_TINT), "the wrapped rows keep the tint");
	assert.ok(!out.join("").includes("…"));
	assert.match(out.at(-2), /· 1-3 \/ 3 +▕$/);
});

test("an untracked file shows every line added", async () => {
	const target = file("new.txt", "alpha\nbeta\n");
	const { text, draw } = await opened(target, { untracked: true }, { with: truecolor });
	const out = text(70);
	assert.match(out[1], /Read-only — Text · changes/);
	assert.match(out[4], /^▏ 1 \+ alpha +▕$/, "one number column");
	assert.match(out[5], /^▏ 2 \+ beta +▕$/);
	assert.match(out.at(-2), / \+2 −0 · /);
	assert.ok(draw(70)[4].includes(ADDED_TINT));
});

test("Markdown with changes is shown as source with its diff, never rendered, and m does nothing", async () => {
	const md = [...header("README.md"), "@@ -1,3 +1,3 @@", " # Title", "-**old** words", "+**new** words", " - item", ""].join("\n");
	const target = file("README.md", "# Title\n**new** words\n- item\n");
	const { component, text } = await opened(target, { diff: Promise.resolve(md) });
	const check = () => {
		const out = text(70);
		assert.match(out[1], /Read-only — Markdown · changes/);
		assert.match(out[4], /^▏ 1   # Title +▕$/);
		assert.match(out[5], /^▏   − \*\*old\*\* words +▕$/);
		assert.match(out[6], /^▏ 2 \+ \*\*new\*\* words +▕$/);
		assert.doesNotMatch(out.at(-2), / m (source|rendered)/);
	};
	check();
	assert.equal(component.handleInput("m"), false);
	check();
});

test("Markdown from the GIT tab with no diff to show is its plain numbered source", async () => {
	const target = file("README.md", "# Title\n\n**bold**\n");
	const { component, text } = await opened(target, { diff: Promise.resolve("") });
	assert.match(text(70)[1], /^▏ Read-only — Markdown +▕$/, "no changes marker");
	assert.match(text(70)[4], /^▏ 1 # Title +▕$/);
	component.handleInput("m");
	assert.match(text(70)[4], /^▏ 1 # Title +▕$/);
});

test("a git failure, a binary diff or no changes fall back to the plain preview without throwing", async () => {
	const target = file("a.ts", "const a = 1;\n");
	for (const diff of [() => Promise.resolve(undefined), () => Promise.reject(new Error("git died")), () => Promise.resolve("Binary files a/a.ts and b/a.ts differ\n")]) {
		const { text } = await opened(target, { diff: diff() });
		assert.match(text(70)[1], /^▏ Read-only — TypeScript +▕$/);
		assert.match(text(70)[4], /^▏ 1 const a = 1; +▕$/);
		assert.match(text(70).at(-2), /^▏ Esc close · e edit · ↑↓/);
	}
});

test("e still opens the editor and Esc closes, in the changes view", async () => {
	const target = file("a.ts", "x\n");
	const edit = await opened(target, { diff: Promise.resolve(SMALL) });
	edit.component.handleInput("e");
	assert.equal(edit.calls.done.length, 1);
	assert.equal(edit.calls.edits, 1);
	const esc = await opened(target, { diff: Promise.resolve(SMALL) });
	esc.component.handleInput("\x1b");
	assert.equal(esc.calls.done.length, 1);
	assert.equal(esc.calls.edits, 0);
});

// The cell just before the right stroke of each body row: the overview ruler, which is the scrollbar too, as VS Code's.
const rulerCells = (out, count) => out.slice(4, 4 + count).map((row) => [...row].at(-2));
const THUMB = "\u{1FB75}";
const HELD = "\u{1FB88}";
// The stub theme with Pi's scrollbar roles and a selectedBg background of their own.
const SHADE = "\x1b[48;5;99m";
const barTheme = { ...theme, fg: (name, text) => (name === "scrollbarThumb" ? `\x1b[38;5;201m${text}\x1b[39m` : theme.fg(name, text)), getBgAnsi: (name) => (name === "selectedBg" ? SHADE : "") };

// The slider over the ruler, as VS Code's scrollbarSlider: the theme's scrollbarThumb at 60% over what is behind it,
// the terminal's background (as tints guesses it) for the cell, the mark's own color for a mark.
const blend = (under, over) => under.map((channel, i) => Math.round(channel + (over[i] - channel) * 0.6));
// A mark under the thumb: halfway toward the thumb cell's own background, so the slider covers it, dimmed.
const covered = (mark, cell) => mark.map((channel, i) => Math.round(channel + (cell[i] - channel) * 0.5));
// The thumb is two columns, the blank gap before the ruler and the ruler cell: the gap a space on the thumb's background.
const gapOn = (bg) => `${bg} \x1b[49m${bg}`;
// The added mark: a right three-quarters block, so the slider shows in the cell's left quarter beside it, as VS Code's lane.
const ADDED = "\u{1FB8A}";
const bgOf = (rgb) => `\x1b[48;2;${rgb.join(";")}m`;
const fgRgb = (rgb) => `\x1b[38;2;${rgb.join(";")}m`;
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];
const THUMB_RGB = [150, 150, 155];
// A truecolor theme whose scrollbarThumb is a truecolor gray, and one whose selectedBg is a truecolor shade.
const sliderFg = (name) => (name === "scrollbarThumb" ? fgRgb(THUMB_RGB) : fgOf(name));
const slider = { ...truecolor, fg: (name, text) => `${sliderFg(name)}${text}\x1b[39m`, getFgAnsi: sliderFg };
const SHADE_RGB = [50, 50, 50];
const TRUE_SHADE = `\x1b[48;2;${SHADE_RGB.join(";")}m`;
// No rgb for scrollbarThumb (an index): the slider cannot be blended.
const indexThumbFg = (name) => (name === "scrollbarThumb" ? "\x1b[38;5;201m" : fgOf(name));
const shaded = { ...truecolor, fg: (name, text) => `${indexThumbFg(name)}${text}\x1b[39m`, getFgAnsi: indexThumbFg, getBgAnsi: (name) => (name === "selectedBg" ? TRUE_SHADE : "\x1b[48;2;9;9;9m") };
const BOTH = [...header("m.ts"), "@@ -1,7 +1,7 @@", "-a", "+b", " c", " d", " e", " f", " g", " h", ""].join("\n");

test("a file longer than the view gets an overview ruler at the right edge: every change marked where it sits in the file, the view as its scrollbar's thumb", async () => {
	const target = file("long.ts", "x\n");
	const { component, text, draw } = await opened(target, { diff: Promise.resolve(LONG) }, { rows: 30, with: barTheme });
	// 61 rows over the 18 rows of the view: row i stands for rows [i*61/18, (i+1)*61/18) of the file.
	// −L30 is row 29 (cell 8), +X30 row 30 (cell 9), −L50 row 50 (cell 15). The view's top is row 26: Pi's thumb,
	// round(18*18/61) = 5 cells at round(26/43*13) = 8, is cells 8-12.
	const cells = () => rulerCells(text(80), 18).join("");
	assert.equal(cells(), `        ▒${ADDED}     ▒  `, "added a ¾ block at the right of the cell, removed a shaded one");
	const raw = draw(80);
	assert.ok(painted(raw[4 + 8], "toolDiffRemoved", "▒") && painted(raw[4 + 9], "toolDiffAdded", ADDED) && painted(raw[4 + 15], "toolDiffRemoved", "▒"), "removed red, added green");
	assert.ok([8, 9, 10, 11, 12].every((cell) => raw[4 + cell].includes(SHADE)), "the thumb's cells shaded, marks or not");
	assert.ok(![7, 13, 15].some((cell) => raw[4 + cell].includes(SHADE)), "no shade outside it");
	assert.ok(raw[4 + 10].includes(`${SHADE} \x1b[49m`) && !raw[4 + 10].includes(THUMB), "a thumb cell with no change: only the shade, no thumb glyph over it");
	assert.ok(text(80).slice(4, 22).every((row) => [...row].at(-3) === " "), "a blank column keeps the code off the ruler");
	assert.ok([8, 9, 10, 11, 12].every((cell) => raw[4 + cell].includes(`${gapOn(SHADE)}`)), "the thumb two columns wide: the gap shaded too");
	assert.ok([7, 13, 15].every((cell) => !raw[4 + cell].includes(`${SHADE} `)), "outside the thumb the gap blank as before");
	component.handleInput("g");
	assert.equal(cells(), `        ▒${ADDED}     ▒  `, "the change marks stay");
	assert.ok([0, 1, 2, 3, 4].every((cell) => draw(80)[4 + cell].includes(SHADE)) && !draw(80)[4 + 8].includes(SHADE), "the shade follows the scroll");
	assert.ok(text(80).slice(1, -1).every((row) => [...row].length === [...text(80)[1]].length), "every row between the strokes as wide as the others");
});

test("the ruler's marks are in full color outside the thumb; the thumb is a 60% see-through gray over them, as VS Code's slider", async () => {
	const { component, draw } = await opened(file("long.ts", "x\n"), { diff: Promise.resolve(LONG) }, { rows: 30, with: slider });
	const raw = draw(80);
	// The thumb is cells 8-12: −L30 (cell 8) and +X30 (cell 9) under it, −L50 (cell 15) outside.
	const SLID = bgOf(blend(BLACK, THUMB_RGB));
	assert.equal(SLID, "\x1b[48;2;90;90;93m", "60% of (150,150,155) over black, about VS Code's 97 gray");
	assert.ok(raw[4 + 15].includes(`${fgOf("toolDiffRemoved")}▒\x1b[39m`) && !raw[4 + 15].includes(SLID), "outside: the plain role, nothing behind it");
	assert.equal(fgRgb(covered(RGB.toolDiffRemoved, blend(BLACK, THUMB_RGB))), "\x1b[38;2;145;65;67m");
	assert.ok(raw[4 + 8].endsWith(`${gapOn(SLID)}\x1b[38;2;145;65;67m▒\x1b[39m\x1b[49m${fgOf("border")}▕\x1b[39m`), "under the thumb: the mark halfway to the slider, on the slider, the gap slid too");
	assert.ok(raw[4 + 9].endsWith(`${gapOn(SLID)}\x1b[38;2;95;145;67m${ADDED}\x1b[39m\x1b[49m${fgOf("border")}▕\x1b[39m`), "an added mark under the thumb, covered, the slider in its left quarter");
	assert.ok(raw[4 + 10].endsWith(`${gapOn(SLID)} \x1b[49m${fgOf("border")}▕\x1b[39m`) && !raw[4 + 10].includes(THUMB), "a thumb cell with no mark: the slider behind two spaces");
	assert.ok([7, 13, 14, 16, 17].every((cell) => !raw[4 + cell].includes(SLID)), "no slider outside the thumb");
	component.handleInput("g"); // the thumb at the top, cells 0-4: every mark outside it
	const top = draw(80);
	assert.ok(top[4 + 8].includes(`${fgOf("toolDiffRemoved")}▒\x1b[39m`) && !top[4 + 8].includes(SLID), "the same mark, off the thumb, in full color");
	assert.ok(top[4 + 9].includes(`${fgOf("toolDiffAdded")}${ADDED}\x1b[39m`), "the added mark is the ¾ block off the thumb too");
	assert.ok([0, 1, 2, 3, 4].every((cell) => top[4 + cell].includes(`${gapOn(SLID)} \x1b[49m`)), "the slider follows the scroll, two columns");
	// A light theme's slider is over white.
	const light = (await opened(file("long.ts", "x\n"), { diff: Promise.resolve(LONG) }, { rows: 30, with: { ...slider, appearance: "light" } })).draw(80);
	assert.equal(bgOf(blend(WHITE, THUMB_RGB)), "\x1b[48;2;192;192;195m");
	assert.equal(fgRgb(covered(RGB.toolDiffRemoved, blend(WHITE, THUMB_RGB))), "\x1b[38;2;196;116;118m");
	assert.ok(light[4 + 8].includes(`${gapOn("\x1b[48;2;192;192;195m")}\x1b[38;2;196;116;118m▒\x1b[39m\x1b[49m`));
	assert.ok(light[4 + 10].includes(`${gapOn("\x1b[48;2;192;192;195m")} \x1b[49m`));
	assert.ok(light[4 + 15].includes(`${fgOf("toolDiffRemoved")}▒\x1b[39m`));
});

test("the ruler's thumb is two columns, the gap before the ruler and the ruler cell; a changed row keeps its tint up to the gap", async () => {
	const { component, draw, text } = await opened(file("long.ts", "x\n"), { diff: Promise.resolve(LONG) }, { rows: 30, with: slider });
	// Top 20: the thumb at round(20/43*13) = 6, cells 6-10. Body rows 9 (−L30) and 10 (+X30) are changed rows under
	// it; the ruler's cells 8 (▒) and 9 (the added mark) are marks under it. (The first render opens at the change.)
	draw(80);
	component.scrollTo(20);
	const raw = draw(80);
	const SLID = bgOf(blend(BLACK, THUMB_RGB));
	const end = (cell) => `${gapOn(SLID)}${cell}\x1b[49m${fgOf("border")}▕\x1b[39m`;
	assert.ok(raw[4 + 10].includes(ADDED_TINT) && raw[4 + 10].endsWith(`\x1b[49m${end(" ")}`), "the added row's tint closed before the gap, the last two cells on the slider");
	assert.equal(visibleWidth(tinted(raw[4 + 10], ADDED_TINT)), 76, "the tint from the left stroke's padding up to the gap");
	assert.ok(raw[4 + 9].includes(REMOVED_TINT) && raw[4 + 9].endsWith(`\x1b[49m${end(`\x1b[38;2;95;145;67m${ADDED}\x1b[39m`)}`), "a tinted row with a mark under the thumb");
	assert.equal(visibleWidth(tinted(raw[4 + 9], REMOVED_TINT)), 76);
	assert.ok(raw[4 + 8].endsWith(end(`\x1b[38;2;145;65;67m▒\x1b[39m`)), "an untinted row with a mark under the thumb");
	assert.ok(raw[4 + 6].endsWith(end(" ")), "a thumb row with no mark: two spaces on the slider");
	assert.ok([0, 5, 11, 17].every((cell) => !raw[4 + cell].includes(SLID)), "outside the thumb nothing on the gap");
	assert.ok(text(80).every((row) => visibleWidth(row) === 80), "every row as wide");
	assert.ok(text(80).slice(4, 22).every((row) => [...row].at(-3) === " "), "the code never on the gap");
	// Outside the thumb a changed row is tinted through the gap, as before.
	component.scrollTo(26); // the thumb at cells 8-12; −L30 is body row 3
	const off = draw(80);
	assert.equal(visibleWidth(tinted(off[4 + 3], REMOVED_TINT)), 77, "the gap inside the tint");
});

test("without a truecolor slider to blend, the thumb is the selectedBg shade behind plain marks", async () => {
	// scrollbarThumb with no rgb: the shade behind the thumb's cells, the marks their role's color.
	const noRgb = (await opened(file("long.ts", "x\n"), { diff: Promise.resolve(LONG) }, { rows: 30, with: shaded })).draw(80);
	assert.ok(noRgb[4 + 8].includes(`${gapOn(TRUE_SHADE)}${fgOf("toolDiffRemoved")}▒\x1b[39m\x1b[49m`), "under the thumb: the shade on both columns, the plain role");
	assert.ok(noRgb[4 + 10].includes(`${gapOn(TRUE_SHADE)} \x1b[49m`));
	assert.ok(!noRgb[4 + 15].includes(`${TRUE_SHADE} `), "the gap blank outside the thumb");
	assert.ok(noRgb[4 + 15].includes(`${fgOf("toolDiffRemoved")}▒`) && !noRgb[4 + 15].includes(TRUE_SHADE));
	// A 256-color theme: no blend, even with a truecolor scrollbarThumb.
	for (const painter of [indexed, { ...slider, getBgAnsi: shaded.getBgAnsi, getColorMode: () => "256color" }]) {
		const raw = (await opened(file("long.ts", "x\n"), { diff: Promise.resolve(LONG) }, { rows: 30, with: painter })).draw(80);
		const removed = painter === indexed ? theme.fg("toolDiffRemoved", "▒") : `${fgOf("toolDiffRemoved")}▒\x1b[39m`;
		assert.ok(raw[4 + 15].includes(removed) && raw[4 + 8].includes(removed), "the plain role, in and out of the thumb");
		if (painter !== indexed) assert.ok(raw[4 + 8].includes(`${gapOn(TRUE_SHADE)}${removed}\x1b[49m`), "the shade under the thumb, two columns");
		assert.doesNotMatch(raw.join(""), /\x1b\[4?8;2;(90;90;93|145;65;67)m/, "nothing blended");
	}
});

test("a ruler cell that stands for both an added and a removed row is a ▞ in the removed color, on nothing of its own", async () => {
	// 8 rows in a 3-row view: the 2-cell thumb at the top, over the cell of both.
	const { draw, text } = await opened(file("m.ts", "x\n"), { diff: Promise.resolve(BOTH) }, { rows: 12, with: slider });
	assert.equal(text(70)[4].at(-2), "▞");
	assert.ok(draw(70)[4].includes(`${gapOn(bgOf(blend(BLACK, THUMB_RGB)))}${fgRgb(covered(RGB.toolDiffRemoved, blend(BLACK, THUMB_RGB)))}▞\x1b[39m\x1b[49m`), "the removed color under the slider");
	assert.ok(!draw(70)[4].includes("\x1b[48;2;100;200;40m"), "no added background");
	const plainTheme = await opened(file("m.ts", "x\n"), { diff: Promise.resolve(BOTH) }, { rows: 12 });
	assert.equal(plainTheme.text(70)[4].at(-2), "▞");
	assert.ok(painted(plainTheme.draw(70)[4], "toolDiffRemoved", "▞"), "without a theme background, still marked");
});

test("in a monochrome theme the ruler tells removed from added as its rows do: removed in dim gray, added in the theme's color", async () => {
	const GRAY = { ...RGB, toolDiffAdded: [180, 180, 180], toolDiffRemoved: [170, 170, 172], scrollbarThumb: THUMB_RGB };
	const grayFg = (name) => `\x1b[38;2;${(GRAY[name] ?? [250, 250, 250]).join(";")}m`;
	const mono = { ...slider, fg: (name, text) => `${grayFg(name)}${text}\x1b[39m`, getFgAnsi: grayFg };
	const SLID = bgOf(blend(BLACK, THUMB_RGB));
	const raw = (await opened(file("long.ts", "x\n"), { diff: Promise.resolve(LONG) }, { rows: 30, with: mono })).draw(80);
	assert.ok(raw[4 + 15].includes(`${grayFg("dim")}▒\x1b[39m`) && !raw[4 + 15].includes(grayFg("toolDiffRemoved")), "removed: a dim ▒");
	assert.equal(fgRgb(covered(GRAY.dim, blend(BLACK, THUMB_RGB))), "\x1b[38;2;90;90;92m");
	assert.ok(raw[4 + 8].endsWith(`${gapOn(SLID)}\x1b[38;2;90;90;92m▒\x1b[39m\x1b[49m${grayFg("border")}▕\x1b[39m`), "removed under the thumb: dim, covered by the slider");
	assert.ok(raw[4 + 9].endsWith(`${gapOn(SLID)}\x1b[38;2;135;135;137m${ADDED}\x1b[39m\x1b[49m${grayFg("border")}▕\x1b[39m`), "added: a ¾ block halfway from 180 to the 90 slider, darker than outside");
	assert.ok(raw[4 + 15].endsWith(`${grayFg("dim")}▒\x1b[39m${grayFg("border")}▕\x1b[39m`) && !raw[4 + 15].includes(`${SLID} `), "outside the thumb: the gap blank, the mark in full");
	const split = (await opened(file("m.ts", "x\n"), { diff: Promise.resolve(BOTH) }, { rows: 12, with: mono })).draw(70);
	assert.ok(split[4].includes(`${gapOn(SLID)}${fgRgb(covered(GRAY.dim, blend(BLACK, THUMB_RGB)))}▞`), "both: a dim ▞");
	assert.ok(!split[4].includes("\x1b[48;2;180;180;180m"), "on no added background");
	// A colored theme keeps the removed color.
	const colored = (await opened(file("long.ts", "x\n"), { diff: Promise.resolve(LONG) }, { rows: 30, with: slider })).draw(80);
	assert.ok(colored[4 + 15].includes(`${fgOf("toolDiffRemoved")}▒`));
});

test("a file that fits the view has no ruler; the plain preview of a long file has the scrollbar", async () => {
	const short = await opened(file("a.ts", "x\n"), { diff: Promise.resolve(SMALL) }, { rows: 30 });
	assert.ok(short.text(70).slice(4, 12).every((row) => row.endsWith(" ▕")), "the whole file is in view: nothing to point at");
	const plainView = await opened(file("b.ts", Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n")), undefined, { rows: 20 });
	// No changes: the plain preview, 80 lines in 10 rows, its 2-row thumb at the top.
	assert.deepEqual(rulerCells(plainView.text(70), 10), [THUMB, THUMB, ...Array(8).fill(THUMB)]);
	assert.ok(!plainView.text(70).slice(4, 14).some((row) => /[█▒▞\u{1FB8A}]/u.test(row)), "no change marks");
});

test("the ruler takes press and drag as a scrollbar: the shade follows, the marks stay", async () => {
	const { component, text, draw } = await opened(file("long.ts", "x\n"), { diff: Promise.resolve(LONG) }, { rows: 30, with: barTheme });
	const top = () => Number(text(80).at(-2).match(/(\d+)-\d+ \/ \d+/)[1]);
	assert.equal(top(), 27);
	// A press on cell 2, off the thumb: its middle (5 / 2 = 2 cells above the pointer) goes there, offset 0 → the top.
	assert.deepEqual(component.handleMouse({ type: "press", button: "left", x: 78, y: 4 + 2 }), { handled: true, capture: true, render: true });
	settle();
	assert.equal(top(), 1);
	assert.equal(rulerCells(text(80), 18).join(""), `        ▒${ADDED}     ▒  `);
	assert.ok([0, 1, 2, 3, 4].every((cell) => draw(80)[4 + cell].includes(SHADE)), "the shade at the top, cells 0-4");
	component.handleMouse({ type: "drag", button: "left", x: 78, y: 4 + 2 + 13 }); // offset 13 of 13: the end
	settle();
	assert.equal(top(), 44);
	assert.ok([13, 14, 15, 16, 17].every((cell) => draw(80)[4 + cell].includes(SHADE)) && !draw(80)[4 + 12].includes(SHADE), "the shade at the end, cells 13-17");
	assert.ok(painted(draw(80)[4 + 15], "toolDiffRemoved", "▒"), "a mark under the shade keeps its color");
	component.handleMouse({ type: "release", button: "left", x: 78, y: 19 });
	assert.ok(!rulerCells(text(80), 18).includes(HELD), "never the held glyph over the ruler");
	// No hover there: the ruler has no glyph thumb to grow.
	assert.equal(component.handleMouse({ type: "move", x: 78, y: 4 + 3 }), undefined, "a move over the ruler is the pop-up's");
	assert.ok(!rulerCells(text(80), 18).includes(HELD));
	// A press and release in place: Pi then sends a click, which the ruler takes.
	component.handleMouse({ type: "press", button: "left", x: 78, y: 4 + 15 });
	component.handleMouse({ type: "release", button: "left", x: 78, y: 4 + 15 });
	assert.equal(component.handleMouse({ type: "click", button: "left", x: 78, y: 4 + 15 })?.handled, true, "the click after it swallowed");
});

test("a press or drag on the gap column inside the thumb's track works as one on the ruler cell", async () => {
	const { component, text } = await opened(file("long.ts", "x\n"), { diff: Promise.resolve(LONG) }, { rows: 30, with: barTheme });
	const top = () => Number(text(80).at(-2).match(/(\d+)-\d+ \/ \d+/)[1]);
	assert.equal(top(), 27);
	assert.deepEqual(component.handleMouse({ type: "press", button: "left", x: 77, y: 4 + 2 }), { handled: true, capture: true, render: true }, "the gap is the scrollbar's too");
	settle();
	assert.equal(top(), 1, "the same jump as a press on the ruler cell");
	component.handleMouse({ type: "drag", button: "left", x: 77, y: 4 + 2 + 13 });
	settle();
	assert.equal(top(), 44, "and the same drag");
	component.handleMouse({ type: "release", button: "left", x: 77, y: 19 });
	assert.equal(component.handleMouse({ type: "press", button: "left", x: 76, y: 4 + 2 }), undefined, "the column before the gap is the pop-up's");
	settle();
	assert.equal(top(), 44);
});

test("the ruler glides the view as the scrollbar does: a third of the way left each frame, then line by line", async () => {
	const { component, text } = await opened(file("long.ts", "x\n"), { diff: Promise.resolve(LONG) }, { rows: 30, with: barTheme });
	const top = () => Number(text(80).at(-2).match(/(\d+)-\d+ \/ \d+/)[1]) - 1;
	assert.equal(top(), 26);
	component.handleMouse({ type: "press", button: "left", x: 78, y: 4 + 2 }); // toward the top
	assert.equal(top(), 26 - 9, "ceil(26 / 3) = 9 lines, not all the way");
	component.handleMouse({ type: "release", button: "left", x: 78, y: 4 + 2 });
	const tops = [];
	for (let i = 0; clock.timers.size && i < 100; i++) frame(), tops.push(top());
	assert.equal(tops.at(-1), 0, "it ends at the target");
	const moved = tops.map((at, i) => (i ? tops[i - 1] : 17) - at).filter(Boolean);
	assert.ok(moved.every((step, i) => !i || step <= moved[i - 1]) && moved.at(-1) === 1, moved.join(","));
	component.handleMouse({ type: "press", button: "left", x: 78, y: 4 + 17 }); // toward the end
	component.handleInput("n"); // the next change moves the view: the glide stops there
	const at = top();
	frame();
	assert.equal(top(), at);
	assert.equal(clock.timers.size, 0);
});
