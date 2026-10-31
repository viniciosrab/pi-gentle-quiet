import assert from "node:assert/strict";
import { test } from "node:test";
import { load, lines, picker, plain, theme, writeConfig } from "./helpers.mjs";

const row = (text) => ({ render: () => [text] });

test("gentle tool rows get Pi's margin and their group icon", async () => {
	const { tool } = await load();
	const draw = (name, text) => lines(tool(name, { renderCall: () => row(text) }).renderCall({}, theme))[0];
	assert.equal(draw("todo", "✿ todo · write"), " ≡ todo · write");
	assert.equal(draw("subagent_run", "❀ agent run"), " ◈ agent run");
	assert.equal(draw("ask_user_choice", "✿ question"), " › question");
	// gentle-pi's orchestrator cards use a robot instead of a petal.
	assert.equal(draw("orchestrator_list", "🤖 Discover orchestrators · Advertised sessions"), " ◈ Discover orchestrators · Advertised sessions");
	// rdd tool rows use a rose; they get their own wrench icon.
	assert.equal(draw("gentle_review", "🌹 rdd assess"), " \u{100030} rdd assess");
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
	const { select } = picker(/^Prompt ›$/, /^Prompt icon in input/);
	const { commands, ctx, emit, editor } = await load({ mode: "tui", select });
	assert.ok(editor(), "installed at start");
	await commands["gentle-quiet"].handler("", ctx);
	assert.equal(editor(), undefined, "Pi's default editor is back");
	await emit("before_agent_start");
	assert.equal(editor(), undefined, "not reinstalled while the option is off");
});

test("Tool rows: original leaves gentle-pi and memory rows as their packages draw them", async () => {
	const { select } = picker(/^Tool rows ›$/, /^Tool rows:/);
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

test("a call component handed back by Pi is not flattened twice, so its rows do not drift right", async () => {
	writeConfig({});
	const { tool } = await load();
	const card = { render: () => ["   ✿ rdd start"] };
	const call = tool("todo", { renderCall: (_args, _theme, context) => context.lastComponent ?? card });
	const first = call.renderCall({}, theme, {});
	const second = call.renderCall({}, theme, { lastComponent: first });
	const third = call.renderCall({}, theme, { lastComponent: second });
	assert.equal(lines(first)[0], "    ≡ rdd start");
	assert.deepEqual(lines(third), lines(first));
});

test("the lone duration row that closes a finished call joins the row above it", async () => {
	writeConfig({});
	const { tool } = await load();
	const result = tool("todo", { renderResult: () => ({ render: () => ["medium · created", "                    9s"] }) });
	assert.deepEqual(lines(result.renderResult({}, {}, theme, {})), [" medium · created · 9s"]);
});

// gentle-pi's review cards as they arrive: float panel rows with accent bars, a rose, padding rows and the clock on its own row.
const nativeCall = (title) => ({ render: () => [" ▎" + " ".repeat(60), ` ▎ 🌹 ${title}${" ".repeat(30)} ctrl+o to expand   `], invalidate() {} });
const nativeResult = (...body) => ({ render: () => [" ▎ " + body[0], " ▎", ...body.slice(1).map((row) => ` ▎ ${row}`)], invalidate() {} });

test("rdd calls are drawn like the quiet bash row: a title line and a └ status line with the real status", async () => {
	writeConfig({});
	const { tool } = await load();
	const rdd = tool("gentle_review", { renderCall: () => nativeCall("rdd start · risk · resilience"), renderResult: () => nativeResult("reviewing · medium · created", "          9s") });
	assert.deepEqual(lines(rdd.renderCall({}, theme, {})), [" \u{100030} rdd start · risk · resilience"]);
	assert.deepEqual(lines(rdd.renderResult({}, { expanded: false }, theme, {})), [" └ ✓ reviewing · medium · created · 9s"]);
});

test("the rdd icon is its own Icons choice: changing it leaves the other gentle tools alone", async () => {
	writeConfig({});
	const { select, seen } = picker(/^Icons ›$/, /^RDD icon/, /^◆$/);
	const { tool, commands, ctx } = await load({ select });
	await commands["gentle-quiet"].handler("", ctx);
	assert.ok(seen[1].items.some((item) => /^Other gentle tools icon: "›"$/.test(item)));
	const rdd = tool("gentle_review", { renderCall: () => nativeCall("rdd start"), renderResult: () => nativeResult("reviewing") });
	assert.deepEqual(lines(rdd.renderCall({}, theme, {})), [" ◆ rdd start"]);
	const ask = tool("ask_user_choice", { renderCall: () => row("✿ question") });
	assert.equal(lines(ask.renderCall({}, theme))[0], " › question");
});

test("rdd results mark blocked and failed states, and a running call keeps its state in the title", async () => {
	writeConfig({});
	const { tool } = await load();
	const rdd = tool("gentle_review_capture_group", { renderCall: () => nativeCall("rdd preparing · capture group"), renderResult: () => nativeResult("blocked · collect · reviewer_results_required") });
	assert.deepEqual(lines(rdd.renderCall({}, theme, {})), [" \u{100030} rdd preparing · capture group"]);
	assert.deepEqual(lines(rdd.renderResult({}, { expanded: false }, theme, {})), [" └ ● blocked · collect · reviewer_results_required"]);
	assert.deepEqual(lines(rdd.renderResult({}, { expanded: false }, theme, { isError: true })), [" └ ✗ blocked · collect · reviewer_results_required"]);
});

test("boxed tool calls and custom messages start at the margin, not in the user message column", async () => {
	writeConfig({});
	await load();
	const { ToolExecutionComponent, CustomMessageComponent } = await import("@earendil-works/pi-coding-agent");
	const fetch = new ToolExecutionComponent({ renderCall() {} });
	assert.deepEqual(fetch.render(6), ["", " #####"]);
	assert.deepEqual(fetch.handleMouse({ x: 3, y: 1, width: 6 }), { x: 2, y: 1, width: 5 });
	assert.equal(fetch.handleMouse({ x: 0, y: 1, width: 6 }), undefined, "the margin column is not the box");
	assert.deepEqual(new CustomMessageComponent().render(6), ["", " #####"]);
	// Rows that carry the margin themselves stay where they are.
	assert.deepEqual(new ToolExecutionComponent({ renderShell: "self" }).render(6), ["", "######"]);
	assert.deepEqual(new CustomMessageComponent({ render: () => [] }).render(6), ["", "######"]);
});

test("Tool rows margin off leaves boxed tool calls and custom messages in Pi's column", async () => {
	writeConfig({ tools: { margin: false } });
	await load();
	const { ToolExecutionComponent, CustomMessageComponent } = await import("@earendil-works/pi-coding-agent");
	assert.deepEqual(new ToolExecutionComponent({ renderCall() {} }).render(6), ["", "######"]);
	assert.deepEqual(new CustomMessageComponent().render(6), ["", "######"]);
	writeConfig({});
});

test("the auto scrollbar gets a column of its own, so it never paints over a tool row's last column", async () => {
	await load();
	const { ScrollView } = await import("@earendil-works/pi-tui");
	assert.equal(new ScrollView({}, { scrollbar: "auto" }).getContentWidth(80), 79);
	assert.equal(new ScrollView({}, { scrollbar: "always" }).getContentWidth(80), 79, "always already had it");
	assert.equal(new ScrollView({}, { scrollbar: "hidden" }).getContentWidth(80), 80, "no scrollbar, no column");
	assert.equal(new ScrollView({}, { scrollbar: "auto" }).getContentWidth(1), 1);
});

test("the scrollbar hugs the right edge, in line with the editor's rules, instead of the cell's middle", async () => {
	await load();
	const { ScrollView } = await import("@earendil-works/pi-tui");
	for (const options of [{}, { scrollbarTrackStyle: (text) => `<${text}>`, scrollbarThumbStyle: (text) => `[${text}]` }]) {
		const view = new ScrollView({}, { scrollbar: "auto", ...options });
		view.getContentWidth(80); // Pi asks it on every render, before it paints the scrollbar
		view.getContentWidth(80);
		const custom = !!options.scrollbarTrackStyle;
		assert.equal(plain(view.scrollbarTrackStyle("│")), custom ? "<▕>" : "▕", "the track is the right eighth block, styled once");
		assert.equal(plain(view.scrollbarThumbStyle("┃")), custom ? "[▐]" : "▐", "the idle thumb is the right half block");
		assert.equal(plain(view.scrollbarThumbStyle("█")), custom ? "[█]" : "█", "the dragged thumb stays a full block");
	}
});
