import assert from "node:assert/strict";
import { test } from "node:test";
import { load, lines, theme } from "./helpers.mjs";

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
	// Fixed truecolor: monochrome palettes would paint both sides the same grey.
	assert.ok(out[1].includes("\x1b[38;2;185;135;150m  -2 const a = 1;"));
	assert.ok(out[2].includes("\x1b[38;2;125;170;130m  +2 const a = 2;"));
});

test("an edit with only two changed lines has nothing more to expand", async () => {
	const rendered = await draw("-1 old\n+1 new");
	assert.deepEqual(lines({ render: () => rendered }).map((line) => line.trimEnd()), [" └ ✓ +1 -1", "   -1 old", "   +1 new"]);
});

test("an edit without a diff keeps the plain summary", async () => {
	const rendered = await draw(undefined);
	assert.deepEqual(lines({ render: () => rendered }).map((line) => line.trimEnd()), [" └ ✓ edited"]);
});
