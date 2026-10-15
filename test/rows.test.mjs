import assert from "node:assert/strict";
import { test } from "node:test";
import { load, lines, picker, theme } from "./helpers.mjs";

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
	assert.equal(transform("hi", { messageType: "user" }), "❯ hi");
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
	assert.equal(first, "[❯] hello", "icon flush with the margin, painted with the editor border color");
	assert.equal(second, "  world");
});

test("the prompt editor comes back after Pi resets the extension UI (resume, new session, reload)", async () => {
	const { ui, emit, editor } = await load({ mode: "tui" });
	const ours = editor();
	assert.ok(ours, "installed at start");
	ui.setEditorComponent(undefined); // what Pi's resetExtensionUI does before a session switch
	await emit("session_start");
	assert.equal(editor(), ours, "reinstalled on the next session start");
	ui.setEditorComponent(undefined);
	await emit("before_agent_start");
	assert.equal(editor(), ours, "also restored before the next prompt runs");
});

test("turning the input prompt icon off restores Pi's editor and keeps it off", async () => {
	const { select } = picker(/^Prompt icon in input/);
	const { commands, ctx, emit, editor } = await load({ mode: "tui", select });
	assert.ok(editor(), "installed at start");
	await commands["gentle-quiet"].handler("", ctx);
	assert.equal(editor(), undefined, "Pi's default editor is back");
	await emit("before_agent_start");
	assert.equal(editor(), undefined, "not reinstalled while the option is off");
});

test("Tool rows: original leaves gentle-pi and memory rows as their packages draw them", async () => {
	const { select } = picker(/^Tool rows/);
	const { tool, commands, ctx } = await load({ select });
	await commands["gentle-quiet"].handler("", ctx);
	const base = { renderCall() {}, renderResult() {} };
	assert.equal(tool("todo", base), base);
	assert.equal(tool("subagent_run", base), base);
	assert.equal(tool("mem_search", base), base);
});

test("sent user messages are a one-row bar: no blank padded rows above and below", async () => {
	await load();
	const { UserMessageComponent } = await import("@earendil-works/pi-coding-agent");
	const message = new UserMessageComponent("hi", 1);
	const [body] = message.children;
	assert.equal(body.paddingY, 0, "no blank row above or below the text");
	assert.equal(body.paddingX, 0, "the prompt icon sits flush with the margin");
	assert.equal(body.cachedText, undefined, "render cache built with the old padding is dropped");
	assert.equal(message.outputPad, 1, "Pi's own padding setting is left as it was");
});
