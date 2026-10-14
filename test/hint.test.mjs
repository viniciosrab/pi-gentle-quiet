import assert from "node:assert/strict";
import { test } from "node:test";
import { load, lines, picker, readConfig, theme, writeConfig } from "./helpers.mjs";

const text = (value) => ({ content: [{ type: "text", text: value }] });
const HINT = /ctrl\+o to expand/;

/** Draws finished bash calls in order and returns each summary row as rendered now. */
function calls(tool, ids) {
	const renderers = tool("bash", { renderCall() {}, renderResult() {} });
	const components = ids.map((id) => renderers.renderResult(text("a\nb\nc"), {}, theme, { toolCallId: id, args: { command: "x" } }));
	return () => components.map((component) => lines(component, 70)[0]);
}

test("by default only the most recent call carries the expand hint", async () => {
	const { tool } = await load();
	const rows = calls(tool, ["c1", "c2", "c3"]);
	assert.deepEqual(rows().map((row) => HINT.test(row)), [false, false, true]);
});

test("the hint moves to a newer call when one finishes", async () => {
	const { tool } = await load();
	const first = calls(tool, ["c1"]);
	assert.ok(HINT.test(first()[0]));
	const second = calls(tool, ["c2"]);
	assert.ok(!HINT.test(first()[0]), "older call loses the hint on its next render");
	assert.ok(HINT.test(second()[0]));
});

test("redrawing an older call does not take the hint back", async () => {
	const { tool } = await load();
	calls(tool, ["c1", "c2"]);
	const again = calls(tool, ["c1"]); // e.g. a theme change re-runs renderResult for c1
	assert.ok(!HINT.test(again()[0]));
});

test("running calls do not take the hint from the last finished one", async () => {
	const { tool } = await load();
	const done = calls(tool, ["c1"]);
	tool("bash", {}).renderResult(text("x"), { isPartial: true }, theme, { toolCallId: "c2", args: {} });
	assert.ok(HINT.test(done()[0]));
});

test("Expand hint cycles last → all → never and is saved", async () => {
	writeConfig({});
	const { select, seen } = picker(/^Expand hint/);
	const { tool, commands, ctx } = await load({ select });
	await commands["gentle-quiet"].handler("", ctx);
	assert.ok(seen[0].items.includes("Expand hint: last"));
	assert.equal(readConfig().quiet.hint, "all");
	assert.deepEqual(calls(tool, ["a1", "a2"])().map((row) => HINT.test(row)), [true, true]);
});

test("Expand hint never hides it everywhere", async () => {
	writeConfig({});
	const { select } = picker(/^Expand hint/, /^Expand hint/);
	const { tool, commands, ctx } = await load({ select });
	await commands["gentle-quiet"].handler("", ctx);
	assert.equal(readConfig().quiet.hint, "never");
	assert.deepEqual(calls(tool, ["n1", "n2"])().map((row) => HINT.test(row)), [false, false]);
});
