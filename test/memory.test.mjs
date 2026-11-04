import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { load, lines, painted, plain, theme } from "./helpers.mjs";

// gentle-quiet reads gentle-engram's chrome module from the agent dir's npm tree.
const engramDir = path.join(process.env.GENTLE_QUIET_TEST_AGENT_DIR, "npm/node_modules/gentle-engram");
mkdirSync(engramDir, { recursive: true });
copyFileSync(new URL("./fixtures/memory-tool-chrome.js", import.meta.url), path.join(engramDir, "memory-tool-chrome.js"));

test("memory calls are drawn like Pi's tool rows with the memory icon", async () => {
	const { tool } = await load();
	const renderers = tool("mem_search", { renderCall() {}, renderResult() {} });
	const call = renderers.renderCall({ query: "config" }, theme);
	assert.equal(lines(call)[0], " \u{100000} search “config”");
	assert.ok(call.render(80)[0].includes("\x1b[38;2;153;153;153m“config”"), "argument in Claude Code's argument grey");
	const result = { details: { data: { results: [1, 2, 3] } } };
	assert.equal(lines(renderers.renderResult(result, {}, theme, {}))[0], " └ ✓ 3 results");
});

test("memory errors keep their message in the error color", async () => {
	const { tool } = await load();
	const renderers = tool("mem_stats", { renderCall() {}, renderResult() {} });
	const out = renderers.renderResult({ content: [{ type: "text", text: "offline" }], isError: true }, {}, theme, { isError: true }).render(80)[0];
	assert.ok(painted(out, "error", "✗ offline"));
});

test("a memory call too long for the row stays on one row, cut with …", async () => {
	const { tool } = await load();
	const renderers = tool("mem_search", { renderCall() {}, renderResult() {} });
	const rows = renderers.renderCall({ query: "where did we decide the quiet tool rows marks and the cd prefix" }, theme).render(40).map((row) => plain(row));
	assert.equal(rows.length, 1, rows.join("\n"));
	assert.ok(rows[0].startsWith(" \u{100000} search “where") && rows[0].endsWith("…") && [...rows[0]].length <= 40, rows[0]);
});
