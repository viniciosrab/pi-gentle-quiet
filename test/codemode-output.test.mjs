import assert from "node:assert/strict";
import { test } from "node:test";
import { load, lines, picker, readConfig, theme, writeConfig } from "./helpers.mjs";

// What Pi returns for a finished script: a bookkeeping header, then the script's output.
const finished = (output, extra = {}) => ({
	content: [{ type: "text", text: `Script completed\nWall time 0.4 seconds\nOutput:\n${output}` }],
	details: { calls: [{ name: "bash", status: "ok", durationMs: 12 }] },
	...extra,
});

async function draw(result, config = {}, context = {}) {
	writeConfig(config);
	const { tool } = await load();
	const renderers = tool("codemode", { renderCall() {}, renderResult() {} });
	return lines(renderers.renderResult(result, {}, theme, { args: { code: "return 1;" }, ...context }), 70).map((line) => line.trimEnd());
}

test("by default the script's output stays hidden: the call and its summary take two rows, ctrl+o shows the rest", async () => {
	const out = await draw(finished('{"ok":"ok"}'));
	assert.equal(out.length, 1, "the summary alone under the call");
	assert.match(out[0], /^ └ ✓ 1 call · bash +ctrl\+o to expand$/);
});

test("with output lines turned on, the script's output shows under the summary, without Pi's bookkeeping header", async () => {
	const one = (await draw(finished('{"ok":"ok"}'), { quiet: { codemodeOutput: 3 } })).slice(1);
	assert.equal(one.length, 1);
	assert.match(one[0], /^   \{"ok":"ok"\} +ctrl\+o to expand$/, "the hint ends the block, on its last row");
	const many = (await draw(finished("a\nb\nc\nd\ne"), { quiet: { codemodeOutput: 3 } })).slice(1);
	assert.deepEqual(many.slice(0, 3), ["   a", "   b", "   c"]);
	assert.match(many[3], /^   … 2 more lines +ctrl\+o to expand$/);
});

test("the number of output lines is configurable, and 0 hides them", async () => {
	const rows = (await draw(finished("a\nb\nc"), { quiet: { codemodeOutput: 1 } })).slice(1);
	assert.equal(rows[0], "   a");
	assert.match(rows[1], /^   … 2 more lines +ctrl\+o to expand$/);
	assert.equal(rows.length, 2);
	assert.equal((await draw(finished("a\nb\nc"), { quiet: { codemodeOutput: 0 } })).length, 1);
});

test("an empty output shows no rows", async () => {
	assert.equal((await draw(finished(""))).length, 1);
});

test("failed calls are listed before the output", async () => {
	const result = finished("done", { details: { calls: [{ name: "read", status: "error", error: "ENOENT" }] } });
	const out = await draw(result, { quiet: { codemodeOutput: 3 } });
	assert.equal(out[1], "   ✗ read ENOENT");
	assert.match(out[2], /^   done +ctrl\+o to expand$/);
	assert.equal(out.length, 3);
});

test("a script that threw shows its error in the summary only", async () => {
	const result = { content: [{ type: "text", text: "Script failed\nWall time 0.1 seconds\nOutput:\nboom" }], details: { calls: [] }, isError: true };
	const out = await draw(result, {}, { isError: true });
	assert.equal(out.length, 1, "no output rows: the error is already the summary");
	assert.match(out[0], /✗ Script failed/);
});

test("Codemode output starts at 0 and cycles 0 → 3 → 5 → 10 → 0, saved", async () => {
	writeConfig({});
	const { select, seen } = picker(/^Tool rows ›$/, /^Codemode output/);
	const { commands, ctx } = await load({ select });
	await commands["gentle-quiet"].handler("", ctx);
	assert.ok(seen[1].items.includes("Codemode output lines: 0"));
	assert.equal(readConfig().quiet.codemodeOutput, 3);
});
