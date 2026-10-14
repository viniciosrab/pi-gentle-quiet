import assert from "node:assert/strict";
import { test } from "node:test";
import { load, lines, theme } from "./helpers.mjs";

const row = (text) => ({ render: () => [text] });

test("gentle tool rows get Pi's margin and their group icon", async () => {
	const { tool } = await load();
	const draw = (name, text) => lines(tool(name, { renderCall: () => row(text) }).renderCall({}, theme))[0];
	assert.equal(draw("todo", "✿ todo · write"), " ≡ todo · write");
	assert.equal(draw("subagent_run", "❀ agent run"), " ◈ agent run");
	assert.equal(draw("ask_user_choice", "✿ question"), " › question");
});

test("without gentle-engram installed, memory tools keep their own renderers", async () => {
	const { tool } = await load();
	const base = { renderCall() {}, renderResult() {} };
	assert.equal(tool("mem_search", base), base);
});

test("tools outside gentle-pi, memory and quiet tools are left alone", async () => {
	const { tool } = await load();
	const base = { renderCall() {} };
	assert.equal(tool("mcp__context7__query-docs", base), base);
});

test("sent user messages get the prompt icon; other messages do not", async () => {
	const { markdown } = await load();
	const [transform] = markdown;
	assert.equal(transform("hi", { messageType: "user" }), " ❯ hi");
	assert.equal(transform("hi", { messageType: "assistant" }), "hi");
	assert.equal(transform("  ", { messageType: "user" }), "  ");
});

test("the editor shows the prompt icon on its first line only", async () => {
	const { editor } = await load({ mode: "tui" });
	const factory = editor();
	assert.ok(factory, "editor installed in tui mode");
	const instance = factory({}, {}, {});
	assert.equal(instance.getPaddingX(), 0, "reported padding excludes the icon");
	const [, first, second] = instance.render(20);
	assert.equal(first, " [❯] hello", "icon painted with the editor border color");
	assert.equal(second, "   world");
});
