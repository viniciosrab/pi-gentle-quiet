import assert from "node:assert/strict";
import { test } from "node:test";
import { load, lines, role, theme } from "./helpers.mjs";

// Pi's edit diff format: "-<n> old", "+<n> new", " <n> context".
const result = (diff) => ({ content: [{ type: "text", text: "ok" }], details: { diff } });

async function draw(diff, width = 70) {
	const { tool } = await load();
	const renderers = tool("edit", { renderCall() {}, renderResult() {} });
	return renderers.renderResult(result(diff), {}, theme, { args: { path: "src/a.ts" } }).render(width);
}

test("edit shows the counts and its first two changed lines", async () => {
	const out = await draw(" 1 keep\n-2 const a = 1;\n+2 const a = 2;\n+3 const b = 3;\n 4 keep");
	const plainOut = lines({ render: () => out }).map((line) => line.trimEnd());
	assert.match(plainOut[0], /^ └ ✓ \+2 -1 +ctrl\+o to expand$/);
	assert.deepEqual(plainOut.slice(1), ["   -2 const a = 1;", "   +2 const a = 2;"]);
});

test("an edit with only two changed lines has nothing more to expand", async () => {
	const rendered = await draw("-1 old\n+1 new");
	assert.deepEqual(lines({ render: () => rendered }).map((line) => line.trimEnd()), [" └ ✓ +1 -1", "   -1 old", "   +1 new"]);
});

test("an edit without a diff keeps the plain summary", async () => {
	const rendered = await draw(undefined);
	assert.deepEqual(lines({ render: () => rendered }).map((line) => line.trimEnd()), [" └ ✓ edited"]);
});

// Pi's theme as an extension sees it: token escapes plus their concrete colors.
const hex = (value) => ({ kind: "rgb", r: parseInt(value.slice(1, 3), 16), g: parseInt(value.slice(3, 5), 16), b: parseInt(value.slice(5, 7), 16) });
function piTheme(tokens) {
	const ansi = (name) => {
		const { r, g, b } = hex(tokens[name]);
		return `\x1b[38;2;${r};${g};${b}m`;
	};
	return {
		fg: (name, text) => `${ansi(name)}${text}\x1b[39m`,
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
		getFgAnsi: ansi,
		colors: Object.fromEntries(Object.keys(tokens).map((name) => [name, hex(tokens[name])])),
	};
}
// Pi's system theme on Tokyo Night's palette, and on Omarchy's all-grey Vantablack Soft.
const COLORFUL = piTheme({ text: "#c0caf5", muted: "#949dc2", dim: "#777fa3", success: "#83af53", toolDiffContext: "#949dc2", toolDiffAdded: "#83af53", toolDiffRemoved: "#f06f88" });
const GREY = piTheme({ text: "#bcbcbc", muted: "#9d9d9d", dim: "#7f7f7f", success: "#9d9d9d", toolDiffContext: "#9d9d9d", toolDiffAdded: "#9d9d9d", toolDiffRemoved: "#9d9d9d" });

const rgbOf = (escape) => escape.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/).slice(1).map(Number);
/** The truecolor a row paints its text with (the last color before the given snippet). */
const colorBefore = (line, snippet) => rgbOf(line.slice(0, line.indexOf(snippet)).match(/\x1b\[38;2;\d+;\d+;\d+m(?!.*\x1b\[38;2;)/s)[0]);
const brightness = ([r, g, b]) => r + g + b;
const themeRgb = (t, name) => [t.colors[name].r, t.colors[name].g, t.colors[name].b];

async function drawWith(t, diff, width = 70) {
	const { tool } = await load();
	const renderers = tool("edit", { renderCall() {}, renderResult() {} });
	return renderers.renderResult(result(diff), {}, t, { args: { path: "src/a.ts" } }).render(width);
}

test("diff rows take the theme's added and removed colors", async () => {
	const out = await drawWith(COLORFUL, "-2 const a = 1;\n+2 const a = 2;");
	assert.deepEqual(colorBefore(out[1], "-2 const"), themeRgb(COLORFUL, "toolDiffRemoved"));
	assert.deepEqual(colorBefore(out[2], "+2 const"), themeRgb(COLORFUL, "toolDiffAdded"));
	// The summary's counts too.
	assert.deepEqual(colorBefore(out[0], "+1"), themeRgb(COLORFUL, "toolDiffAdded"));
	assert.deepEqual(colorBefore(out[0], "-1"), themeRgb(COLORFUL, "toolDiffRemoved"));
});

test("a grey theme still tells added from removed with its own colors: added brighter", async () => {
	const out = await drawWith(GREY, "-2 const a = 1;\n+2 const a = 2;");
	const removed = colorBefore(out[1], "-2 const");
	const added = colorBefore(out[2], "+2 const");
	assert.notDeepEqual(added, removed);
	assert.ok(brightness(added) > brightness(removed));
	const own = ["text", "muted", "dim"].map((name) => themeRgb(GREY, name));
	assert.ok(own.some((color) => color.join() === added.join()), `added ${added} is not a theme color`);
	assert.ok(own.some((color) => color.join() === removed.join()), `removed ${removed} is not a theme color`);
	// Removed lines stand apart from the unchanged context lines as well.
	assert.notDeepEqual(removed, themeRgb(GREY, "toolDiffContext"));
});

test("without truecolor theme colors the rows keep the theme's tokens, not a fixed red and green", async () => {
	const out = await drawWith(theme, "-2 const a = 1;\n+2 const a = 2;");
	assert.ok(out[1].includes(`${role("toolDiffRemoved")}  -2 const a = 1;`));
	assert.ok(out[2].includes(`${role("toolDiffAdded")}  +2 const a = 2;`));
	assert.ok(!out.join("").includes("\x1b[38;2;"));
});

// ctrl+o: Pi's own diff, its changed words in inverse.
async function expanded(t) {
	const { tool } = await load();
	const native = { render: () => ["\x1b[38;5;1m-2 const \x1b[7ma\x1b[27m = 1;\x1b[39m", "\x1b[38;5;2m+2 const \x1b[7mb\x1b[27m = 1;\x1b[39m", " 3 keep"], invalidate() {} };
	const renderers = tool("edit", { renderCall() {}, renderResult: () => native });
	return renderers.renderResult(result("-2 x\n+2 y"), { expanded: true }, t, { args: { path: "src/a.ts" }, state: {} }).render(70);
}

for (const [name, t] of [["colorful", COLORFUL], ["grey", GREY]]) {
	test(`expanded diff: changed words are brighter than their line (${name} theme)`, async () => {
		const out = await expanded(t);
		for (const [line, text, word] of [[out[0], "-2 const", "a"], [out[1], "+2 const", "b"]]) {
			const lineColor = colorBefore(line, text);
			const wordColor = colorBefore(line, `${word}\x1b`);
			assert.ok(brightness(wordColor) > brightness(lineColor), `${line}`);
		}
		assert.deepEqual(colorBefore(out[1], "+2 const"), name === "colorful" ? themeRgb(t, "toolDiffAdded") : themeRgb(t, "text"));
		assert.equal(out[2], "  3 keep");
	});
}

test("a theme switch repaints the diff rows without a reload", async () => {
	// Pi hands extensions one theme proxy that forwards to the current theme.
	let current = COLORFUL;
	const live = new Proxy({}, { get: (_target, key) => current[key] });
	const { tool } = await load();
	const component = tool("edit", { renderCall() {}, renderResult() {} }).renderResult(result("-2 a\n+2 b"), {}, live, { args: { path: "src/a.ts" } });
	assert.deepEqual(colorBefore(component.render(70)[2], "+2 b"), themeRgb(COLORFUL, "toolDiffAdded"));
	current = GREY;
	assert.deepEqual(colorBefore(component.render(70)[2], "+2 b"), themeRgb(GREY, "text"));
});
