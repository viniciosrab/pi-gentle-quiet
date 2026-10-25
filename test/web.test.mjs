import assert from "node:assert/strict";
import { test } from "node:test";
import { lines, load, painted, theme, writeConfig } from "./helpers.mjs";

const text = (value, extra = {}) => ({ content: [{ type: "text", text: value }], ...extra });
// pi-web-access's own rows: the call as it draws it, a progress bar while fetching, a status line when done.
const native = {
	renderCall: (args) => ({ render: () => (args.urls ? ["\x1b[1mfetch\x1b[22m 2 URLs", "  https://a.dev", "  https://b.dev"] : [`\x1b[1mfetch\x1b[22m ${args.url}`]) }),
	renderResult: (result, options) => ({
		render: () => (options.isPartial ? ["\x1b[48;5;2m[█████░░░░░] fetching\x1b[49m"] : options.expanded ? ["Example (6152 chars)", "full page text"] : ["Example (6152 chars)", "brief text…"]),
	}),
};
const WEB_TOOLS = ["web_search", "fetch_content", "get_search_content", "source_check"];

async function web(name = "fetch_content") {
	writeConfig({});
	const { tool } = await load();
	return tool(name, native);
}

test("web calls render without Pi's tool box", async () => {
	for (const name of WEB_TOOLS) assert.equal((await web(name)).renderShell, "self", name);
});

test("a web call keeps pi-web-access's own call row, behind a dot at Pi's margin", async () => {
	const renderers = await web();
	assert.deepEqual(lines(renderers.renderCall({ url: "https://example.com" }, theme, { isPartial: false, state: {} })), [" ● fetch https://example.com"]);
	assert.deepEqual(lines(renderers.renderCall({ urls: ["https://a.dev", "https://b.dev"] }, theme, { isPartial: false, state: {} })), [
		" ● fetch 2 URLs",
		"   └ https://a.dev",
		"   └ https://b.dev",
	], "each row under the call gets Claude Code's link, like the result row");
});

// Claude Code's fixed status colors: a monochrome Pi theme would paint success and error grey.
const GREEN_DOT = "\x1b[38;2;78;186;101m●\x1b[39m";
const RED = "\x1b[38;2;255;107;128m";

test("the dot blinks grey while the web call runs, then turns Claude Code's fixed green, or red when it fails", async (t) => {
	const renderers = await web();
	const now = t.mock.method(Date, "now", () => 0);
	const state = {};
	const call = renderers.renderCall({ url: "https://example.com" }, theme, { isPartial: true, state });
	assert.ok(painted(call.render(80)[0], "dim", "●"), "lit and grey while running");
	now.mock.mockImplementation(() => 599);
	assert.ok(painted(call.render(80)[0], "dim", "●"), "still lit before 600 ms");
	now.mock.mockImplementation(() => 600);
	assert.equal(lines(call)[0], "   fetch https://example.com", "off for the next 600 ms, so it blinks");
	renderers.renderResult(text("ok"), { isPartial: false }, theme, { args: {}, state });
	assert.ok(call.render(80)[0].includes(GREEN_DOT), "steady fixed green once the call ended");
	renderers.renderResult(text("boom", { isError: true }), { isPartial: false }, theme, { args: {}, isError: true, state });
	assert.ok(call.render(80)[0].includes(`${RED}●\x1b[39m`), "a failed call keeps a fixed red dot");
	clearInterval(state.webBlink);
});

test("while running a web call shows one dim line: pi-web-access's own progress, without its background", async () => {
	const renderers = await web();
	const partial = renderers.renderResult(text(""), { isPartial: true }, theme, { args: {}, toolCallId: "p1", state: {} });
	assert.deepEqual(lines(partial), ["   └ [█████░░░░░] fetching"]);
	assert.ok(!partial.render(80)[0].includes("\x1b[48;"), "no background");
	assert.ok(painted(partial.render(80)[0], "dim"), "dim");
});

test("the running line follows pi-web-access's progress as it changes", async () => {
	writeConfig({});
	const { tool } = await load();
	let row = "  searching 1/2";
	const changing = { ...native, renderResult: () => ({ render: () => ["", row, "  more"] }) };
	const partial = tool("web_search", changing).renderResult(text(""), { isPartial: true }, theme, { args: {}, state: {} });
	assert.deepEqual(lines(partial), ["   └ searching 1/2"]);
	row = "  searching 2/2";
	assert.deepEqual(lines(partial), ["   └ searching 2/2"]);
});

test("a running web call that draws nothing says what it is doing, like Claude Code", async () => {
	writeConfig({});
	const { tool } = await load();
	const silent = { ...native, renderResult: () => ({ render: () => ["", "  "] }) };
	const expected = { web_search: "Searching…", source_check: "Searching…", fetch_content: "Fetching…", get_search_content: "Reading…" };
	for (const name of WEB_TOOLS) {
		const partial = tool(name, silent).renderResult(text(""), { isPartial: true }, theme, { args: {}, state: {} });
		assert.deepEqual(lines(partial), [`   └ ${expected[name]}`], name);
	}
});

test("a finished web call is one line: pi-web-access's own status row and the expand hint", async () => {
	const renderers = await web();
	const done = renderers.renderResult(text("page"), { isPartial: false }, theme, { args: {}, durationMs: 2000, toolCallId: "w1", state: {} });
	const rows = lines(done);
	assert.equal(rows.length, 1);
	assert.match(rows[0], /^   └ Example \(6152 chars\)\s+ctrl\+o to expand $/);
});

test("web_search's leading indent goes from the one-line summary, its colors stay", async () => {
	writeConfig({});
	const { tool } = await load();
	const search = { ...native, renderResult: () => ({ render: () => ["", " \x1b[1m2/2 queries, 6 sources\x1b[22m", " \x1b[2mProvider: exa\x1b[22m"] }) };
	const done = tool("web_search", search).renderResult(text("x"), { isPartial: false }, theme, { args: {}, toolCallId: "s1", state: {} });
	const rows = lines(done);
	assert.equal(rows.length, 1);
	assert.match(rows[0], /^   └ 2\/2 queries, 6 sources\s+ctrl\+o to expand $/);
	assert.ok(done.render(80)[0].includes("\x1b[1m2/2 queries"), "bold kept");
});

test("a finished web call that draws nothing falls back to the result's first line", async () => {
	writeConfig({});
	const { tool } = await load();
	const silent = { ...native, renderResult: () => ({ render: () => [] }) };
	const done = tool("fetch_content", silent).renderResult(text("\nfirst line\nsecond"), { isPartial: false }, theme, { args: {}, toolCallId: "f1", state: {} });
	assert.match(lines(done)[0], /^   └ first line\s+ctrl\+o to expand $/);
	assert.equal(lines(done).length, 1);
});

test("a failed web call is one red line with pi-web-access's first error row", async () => {
	const errorRows = { ...native, renderResult: () => ({ render: () => ["  \x1b[1mExtracted content appears incomplete\x1b[22m", "", "Fallback options:"] }) };
	writeConfig({});
	const { tool } = await load();
	const failed = tool("fetch_content", errorRows).renderResult(text("boom", { isError: true }), { isPartial: false }, theme, { args: {}, isError: true, toolCallId: "e1", state: {} });
	const rows = lines(failed);
	assert.equal(rows.length, 1);
	assert.match(rows[0], /^   └ Extracted content appears incomplete(\s+ctrl\+o to expand )?$/);
	assert.ok(failed.render(80)[0].includes(`${RED}Extracted content appears incomplete`), "plain text in the fixed red");
});

test("a failed web call that draws nothing shows the result's first line in red", async () => {
	writeConfig({});
	const { tool } = await load();
	const silent = { ...native, renderResult: () => ({ render: () => [] }) };
	const failed = tool("fetch_content", silent).renderResult(text("Error: 404"), { isPartial: false }, theme, { args: {}, toolCallId: "e2", state: {} , isError: true });
	assert.ok(failed.render(80)[0].includes(`${RED}Error: 404`));
});

test("ctrl+o shows all of pi-web-access's expanded rows in the same place", async () => {
	const renderers = await web();
	const full = renderers.renderResult(text("page"), { isPartial: false, expanded: true }, theme, { args: {}, state: {} });
	assert.deepEqual(lines(full), ["   └ Example (6152 chars)", "     full page text"]);
	writeConfig({});
	const { tool } = await load();
	const search = { ...native, renderResult: () => ({ render: () => [" 3 sources", " \x1b[2mProvider: exa\x1b[22m", " ", "   nested"] }) };
	const expanded = tool("web_search", search).renderResult(text("x"), { isPartial: false, expanded: true }, theme, { args: {}, state: {} });
	assert.deepEqual(lines(expanded), ["   └ 3 sources", "     Provider: exa", "", "       nested"]);
});

test("Quiet tools off leaves web calls as pi-web-access draws them", async () => {
	writeConfig({ quiet: { enabled: false } });
	const { tool } = await load();
	assert.equal(tool("fetch_content", native), native);
	writeConfig({});
});
