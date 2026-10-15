import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { load, lines, painted, theme } from "./helpers.mjs";

// gentle-quiet reads gentle-engram's chrome module from the agent dir's npm tree.
const engramDir = path.join(process.env.GENTLE_QUIET_TEST_AGENT_DIR, "npm/node_modules/gentle-engram");
mkdirSync(engramDir, { recursive: true });
copyFileSync(new URL("./fixtures/memory-tool-chrome.js", import.meta.url), path.join(engramDir, "memory-tool-chrome.js"));

test("memory calls are drawn like Pi's tool rows with the memory icon", async () => {
	const { tool } = await load();
	const renderers = tool("mem_search", { renderCall() {}, renderResult() {} });
	const call = renderers.renderCall({ query: "config" }, theme);
	assert.equal(lines(call)[0], " \u{100000} search “config”");
	assert.ok(painted(call.render(80)[0], "accent", "“config”"));
	const result = { details: { data: { results: [1, 2, 3] } } };
	assert.equal(lines(renderers.renderResult(result, {}, theme, {}))[0], " └ ✓ 3 results");
});

test("memory errors keep their message in the error color", async () => {
	const { tool } = await load();
	const renderers = tool("mem_stats", { renderCall() {}, renderResult() {} });
	const out = renderers.renderResult({ content: [{ type: "text", text: "offline" }], isError: true }, {}, theme, { isError: true }).render(80)[0];
	assert.ok(painted(out, "error", "✗ offline"));
});
