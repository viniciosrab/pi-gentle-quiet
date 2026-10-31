import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { painted, plain, theme } from "./helpers.mjs";
import { changeBlocks, parseFileDiff } from "../extensions/sidebar/diff-preview.ts";
import { openPreview, previewDeps } from "../extensions/sidebar/tree-preview.ts";

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

test("a changed file shows its changes inline as VS Code's: old and new numbers, then the sign, then the code", async () => {
	const target = file("a.ts", "one\nTWO\ntwo and a half\nthree\nfour\nsix\n");
	const { text, draw } = await opened(target, { diff: Promise.resolve(SMALL) }, { relPath: "src/a.ts" });
	const out = text(70);
	assert.match(out[1], /^▏ Read-only — TypeScript · changes +▕$/);
	assert.match(out[2], /^▏ src\/a\.ts +▕$/);
	assert.deepEqual(out.slice(4, 12).map((row) => row.slice(2).trimEnd().replace(/ ▕$/, "").trimEnd()), [
		"1 1   one",
		"2   − two",
		"  2 + TWO",
		"  3 + two and a half",
		"3 4   three",
		"4 5   four",
		"5   − five",
		"6 6   six",
	]);
	assert.match(out.at(-2), /^▏ Esc close · e edit · n\/N change · \+2 −2 · 1-8 \/ 8 +▕$/, "the scroll keys left out where they do not fit");
	assert.match(text(90).at(-2), /^▏ Esc close · e edit · n\/N change · \+2 −2 · ↑↓ PgUp\/PgDn Home\/End · 1-8 \/ 8 +▕$/);
	const raw = draw(70);
	assert.ok(painted(raw[5], "toolDiffRemoved", "−") && painted(raw[6], "toolDiffAdded", "+"), "the sign in the diff color");
	assert.ok(!painted(raw[5], "toolDiffRemoved", "two") && !painted(raw[6], "toolDiffAdded", "TWO"), "the code keeps its own color");
	assert.ok(painted(raw[5], "dim", "2") && painted(raw[6], "dim", "2"), "numbers dim");
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
	assert.ok(plain(raw[6]).startsWith("▏   2 + TWO"));
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
	assert.deepEqual(range(), [27, 45, 61], "three rows of context above the first change");
	assert.ok(text(80).some((row) => /^▏ 30    − L30 /.test(row)) && text(80).some((row) => /^▏    30 \+ X30 /.test(row)));
	assert.equal(component.handleInput("n"), true);
	assert.deepEqual(range(), [43, 61, 61], "the next block, as far as the end allows");
	assert.ok(text(80).some((row) => /^▏ 50    − L50 /.test(row)));
	assert.equal(component.handleInput("n"), false, "no block after the last");
	component.handleInput("N");
	assert.deepEqual(range(), [27, 45, 61]);
	component.handleInput("]");
	assert.deepEqual(range(), [43, 61, 61]);
	component.handleInput("[");
	assert.deepEqual(range(), [27, 45, 61]);
	assert.equal(component.handleInput("N"), false, "no block before the first");
	component.handleInput("g");
	assert.deepEqual(range(), [1, 19, 61]);
	component.handleInput("n");
	assert.deepEqual(range(), [27, 45, 61], "from the top, n goes to the first block");
	component.handleInput("G");
	component.handleInput("N");
	assert.deepEqual(range(), [27, 45, 61], "from the end, N goes to the block above the view's top");
	assert.match(text(80).at(-2), /n\/N change · \+1 −2 ·/);
});

test("an untracked file shows every line added", async () => {
	const target = file("new.txt", "alpha\nbeta\n");
	const { text, draw } = await opened(target, { untracked: true }, { with: truecolor });
	const out = text(70);
	assert.match(out[1], /Read-only — Text · changes/);
	assert.match(out[4], /^▏   1 \+ alpha +▕$/, "no old number");
	assert.match(out[5], /^▏   2 \+ beta +▕$/);
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
		assert.match(out[4], /^▏ 1 1   # Title +▕$/);
		assert.match(out[5], /^▏ 2   − \*\*old\*\* words +▕$/);
		assert.match(out[6], /^▏   2 \+ \*\*new\*\* words +▕$/);
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
