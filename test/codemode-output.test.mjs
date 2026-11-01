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

test("the script's output shows under the summary, without Pi's bookkeeping header", async () => {
	const out = await draw(finished('{"ok":"ok"}'));
	assert.match(out[0], /^ └ ✓ 1 call · bash +ctrl\+o to expand$/);
	assert.deepEqual(out.slice(1), ['   {"ok":"ok"}']);
});

test("only the first lines are shown, with a count of the rest", async () => {
	const out = await draw(finished("a\nb\nc\nd\ne"));
	assert.deepEqual(out.slice(1), ["   a", "   b", "   c", "   … 2 more lines"]);
});

test("the number of output lines is configurable, and 0 hides them", async () => {
	assert.deepEqual((await draw(finished("a\nb\nc"), { quiet: { codemodeOutput: 1 } })).slice(1), ["   a", "   … 2 more lines"]);
	assert.equal((await draw(finished("a\nb\nc"), { quiet: { codemodeOutput: 0 } })).length, 1);
});

test("an empty output shows no rows", async () => {
	assert.equal((await draw(finished(""))).length, 1);
});

test("failed calls are listed before the output", async () => {
	const result = finished("done", { details: { calls: [{ name: "read", status: "error", error: "ENOENT" }] } });
	const out = await draw(result);
	assert.deepEqual(out.slice(1), ["   ✗ read ENOENT", "   done"]);
});

test("a script that threw shows its error in the summary only", async () => {
	const result = { content: [{ type: "text", text: "Script failed\nWall time 0.1 seconds\nOutput:\nboom" }], details: { calls: [] }, isError: true };
	const out = await draw(result, {}, { isError: true });
	assert.equal(out.length, 1, "no output rows: the error is already the summary");
	assert.match(out[0], /✗ Script failed/);
});

test("Codemode output cycles 3 → 5 → 10 → 0 → 3 and is saved", async () => {
	writeConfig({});
	const { select, seen } = picker(/^Tool rows ›$/, /^Codemode output/);
	const { commands, ctx } = await load({ select });
	await commands["gentle-quiet"].handler("", ctx);
	assert.ok(seen[1].items.includes("Codemode output lines: 3"));
	assert.equal(readConfig().quiet.codemodeOutput, 5);
});
