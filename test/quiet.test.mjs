import assert from "node:assert/strict";
import { test } from "node:test";
import { load, lines, painted, picker, plain, readConfig, theme, writeConfig } from "./helpers.mjs";

const text = (value, extra = {}) => ({ content: [{ type: "text", text: value }], ...extra });
const native = { renderCall: () => ({ render: () => ["NATIVE"] }), renderResult: () => ({ render: () => ["\x1b[48;5;2mfull\x1b[49m", "output"] }) };

async function draw(name, args, result, options = {}, context = {}) {
	const { tool } = await load();
	const renderers = tool(name, native);
	return [
		...lines(renderers.renderCall(args, theme)),
		...lines(renderers.renderResult(result, options, theme, { args, ...context }), 70),
	].map((line) => line.trimEnd());
}

test("quiet tools render without Pi's tool box", async () => {
	const { tool } = await load();
	assert.equal(tool("read", native).renderShell, "self");
});

test("read collapses to the path and a line count with the expand hint", async () => {
	const out = await draw("read", { path: "/tmp/app.ts", offset: 10, limit: 3 }, text("a\nb\nc"));
	assert.equal(out[0], " read /tmp/app.ts:10-12");
	assert.match(out[1], /^ └ ✓ 3 lines +ctrl\+o to expand$/);
});

test("bash failures show the exit code and the last output line, without a hint", async () => {
	const out = await draw("bash", { command: "false" }, text("boom\nCommand exited with code 1", { isError: true }), {}, { isError: true });
	assert.deepEqual(out, [" $ false", " └ ✗ exit 1", "   boom"]);
});

test("empty and running calls show no expand hint", async () => {
	assert.deepEqual(await draw("bash", { command: "true" }, text("")), [" $ true", " └ ✓ no output"]);
	assert.deepEqual(await draw("bash", { command: "sleep 1" }, text(""), { isPartial: true }), [" $ sleep 1", " └ running…"]);
});

test("summaries for grep, find, ls and write", async () => {
	assert.match((await draw("grep", { pattern: "x", path: "src" }, text("a:1\nb:2")))[1], /✓ 2 matches/);
	assert.match((await draw("find", { pattern: "*.md" }, text("")))[1], /✓ no files/);
	assert.match((await draw("ls", { path: "." }, text("a")))[1], /✓ 1 entry/);
	assert.match((await draw("write", { path: "b.md", content: "x\ny" }, text("ok")))[1], /✓ 2 lines written +ctrl\+o to expand/);
});

test("expanded calls show Pi's own output on the margin, without backgrounds", async () => {
	const out = await draw("bash", { command: "ls" }, text("x"), { expanded: true }, { state: {} });
	assert.deepEqual(out, [" $ ls", " full", " output"]);
});

test("codegraph collapses to the operation, the query and a result count", async () => {
	const explore = await draw("codegraph", { operation: "explore", query: "src/data/fees.ts consumers" }, text("**Exploration: src/data/fees.ts consumers**\n\nFound 78 symbols across 5 files. 1 file pinned from the query.\n\n- `Price` (src/Price.astro:1)"));
	assert.equal(explore[0], ' codegraph explore "src/data/fees.ts consumers"');
	assert.match(explore[1], /^ └ ✓ 78 symbols · 5 files +ctrl\+o to expand$/);
	assert.equal(explore.length, 2);
	const query = await draw("codegraph", { operation: "query", query: "fees", limit: 10 }, text('Search Results for "fees":\n\nfile        fees.ts\n  src/data/fees.ts:1\n\ntype_alias  PaymentMethod\n  src/data/fees.ts:3'));
	assert.equal(query[0], ' codegraph query "fees"');
	assert.match(query[1], /^ └ ✓ 2 results +ctrl\+o to expand$/);
	assert.match((await draw("codegraph", { operation: "query", query: "zzz" }, text('Search Results for "zzz":\n\nNo results found.')))[1], /✓ no results/);
	// codegraph's own framed output: "┌  Initializing CodeGraph", "│", "◆  Indexed 1 files", "└  Done".
	const initialized = text("┌  Initializing CodeGraph\n│\n◆  Initialized in /srv/app\n│\nScanning files...\n│\n◆  Indexed 42 files\n│\n●  80 nodes, 61 edges in 166ms\n│\n└  Done\n");
	const init = await draw("codegraph", { operation: "init" }, initialized);
	assert.equal(init[0], " codegraph init");
	assert.match(init[1], /^ └ ✓ 42 files indexed · 80 nodes, 61 edges in 166ms +ctrl\+o to expand$/);
	assert.equal(init.length, 2);
	const existing = text('┌  Initializing CodeGraph\n│\n▲  Already initialized in /srv/app\n│\n●  Use "codegraph index" to re-index or "codegraph sync" to update\n│\n└  \n');
	assert.deepEqual(await draw("codegraph", { operation: "init" }, existing), [" codegraph init", " └ ✓ already initialized"]);
	const failed = await draw("codegraph", { operation: "query", query: "x" }, text("codegraph: no index", { isError: true }), {}, { isError: true });
	assert.match(failed[1], /^ └ ✗ codegraph: no index( +ctrl\+o to expand)?$/);
});

test("codegraph without renderers of its own is quiet too, and ctrl+o shows its whole output", async () => {
	const { tool } = await load();
	const renderers = tool("codegraph", undefined);
	assert.equal(renderers.renderShell, "self");
	const args = { operation: "explore", query: "q" };
	const result = text("Found 1 symbol across 1 file.\n- `a` (a.ts:1)");
	assert.deepEqual(lines(renderers.renderCall(args, theme)).map((line) => line.trimEnd()), [' codegraph explore "q"']);
	assert.deepEqual(lines(renderers.renderResult(result, { expanded: true }, theme, { args, state: {} }), 70).map((line) => line.trimEnd()), [" Found 1 symbol across 1 file.", " - `a` (a.ts:1)"]);
});

test("codemode summarizes child calls and lists failures", async () => {
	const calls = [
		{ name: "mcp__context7__query-docs", status: "ok", durationMs: 800 },
		{ name: "mcp__supabase__list_tables", status: "error", error: "permission denied" },
	];
	const out = await draw("codemode", { code: "a\nb" }, { content: [], details: { calls } });
	assert.equal(out[0], " codemode 2 lines");
	assert.match(out[1], /^ └ ✗ 1 of 2 calls failed +ctrl\+o to expand$/);
	assert.equal(out[2], "   ✗ supabase/list_tables permission denied");
	const ok = await draw("codemode", { code: "a" }, { content: [], details: { calls: [calls[0]] } }, {}, { durationMs: 1400 });
	assert.match(ok[1], /✓ 1 call · context7 · 1\.4s/);
});

test("an unchanged expanded output is reused instead of reprocessed", async () => {
	const { tool } = await load();
	let renders = 0;
	const output = Array.from({ length: 500 }, (_, i) => `\x1b[48;5;1mline ${i}\x1b[49m`);
	const renderers = tool("bash", { renderResult: () => ({ render: () => (renders++, output) }) });
	const component = renderers.renderResult(text("x"), { expanded: true }, theme, { state: {} });
	const first = component.render(80);
	assert.equal(component.render(80), first, "same array returned while nothing changed");
	assert.equal(renders, 2, "Pi's renderer still runs, so new output is picked up");
});

test("tool calls use Claude Code's tones: light name, softer grey path and $ command", async () => {
	const { tool } = await load();
	const LIGHT = "\x1b[38;2;188;188;188m";
	const GREY = "\x1b[38;2;153;153;153m";
	const read = tool("read", native).renderCall({ path: "/tmp/app.ts" }, theme).render(80)[0];
	assert.ok(read.includes(`${LIGHT}read`), "tool name in the light tone");
	assert.ok(read.includes(`${GREY}/tmp/app.ts`), "path in the softer grey");
	assert.ok(!read.includes("\x1b[1m"), "no bold title");
	const bash = tool("bash", native).renderCall({ command: "nproc" }, theme).render(80)[0];
	assert.ok(bash.includes(`${GREY}$ nproc`), "the $ command is the softer grey, like Claude Code's");
	assert.ok(!bash.includes(LIGHT), "and nothing on the row is in the light tone");
});

test("Tool call tones: theme gives the rows back to Pi's theme colors and is saved", async () => {
	writeConfig({});
	const { select, seen } = picker(/^Tool rows ›$/, /^Tool call tones/);
	const loaded = await load({ mode: "tui", select });
	await loaded.commands["gentle-quiet"].handler("", loaded.ctx);
	assert.ok(seen[1].items.includes("Tool call tones: claude"), "Claude Code tones by default");
	assert.equal(readConfig().tools.tones, "theme");
	const read = loaded.tool("read", native).renderCall({ path: "/tmp/app.ts" }, theme).render(80)[0];
	assert.ok(painted(read, "toolTitle", "\x1b[1mread"), "bold toolTitle name");
	assert.ok(painted(read, "accent", "/tmp/app.ts"), "accent path");
	assert.ok(!read.includes("\x1b[38;2;"), "no fixed truecolor");
	const bash = loaded.tool("bash", native).renderCall({ command: "nproc" }, theme).render(80)[0];
	assert.ok(painted(bash, "toolTitle", "$ nproc"));
});

test("an unknown saved tone falls back to the Claude Code tones", async () => {
	writeConfig({ tools: { tones: "neon" } });
	const loaded = await load();
	const read = loaded.tool("read", native).renderCall({ path: "/tmp/app.ts" }, theme).render(80)[0];
	assert.ok(read.includes("\x1b[38;2;188;188;188mread"));
	writeConfig({});
});

test("Tool call tones: soft follows the theme quietly: toolTitle name, muted path and command, no bold", async () => {
	writeConfig({ tools: { tones: "soft" } });
	const loaded = await load();
	const read = loaded.tool("read", native).renderCall({ path: "/tmp/app.ts" }, theme).render(80)[0];
	assert.ok(painted(read, "toolTitle", "read"), "toolTitle name");
	assert.ok(painted(read, "muted", "/tmp/app.ts"), "muted path");
	assert.ok(!read.includes("\x1b[1m"), "no bold title");
	assert.ok(!read.includes("\x1b[38;2;"), "no fixed truecolor");
	const bash = loaded.tool("bash", native).renderCall({ command: "nproc" }, theme).render(80)[0];
	assert.ok(painted(bash, "muted", "$ nproc"), "the $ command is muted, like the paths");
	writeConfig({});
});

test("the tones option cycles claude → theme → soft → claude", async () => {
	writeConfig({ tools: { tones: "theme" } });
	const { select } = picker(/^Tool rows ›$/, /^Tool call tones/, /^Tool call tones/);
	const loaded = await load({ select });
	await loaded.commands["gentle-quiet"].handler("", loaded.ctx);
	assert.equal(readConfig().tools.tones, "claude");
	writeConfig({});
});

test("a long $ command fills the width and wraps to two rows, like Claude Code", async () => {
	const { tool } = await load();
	const command = Array.from({ length: 40 }, (_, i) => `step${i}`).join(" && ");
	const rows = tool("bash", native).renderCall({ command }, theme).render(120).map((row) => plain(row));
	assert.equal(rows.length, 2, "two rows, the second hanging under the command");
	assert.ok(rows.every((row) => row.length <= 120), "no row passes the width");
	assert.ok(rows[0].length > 110, "the first row uses the full width, not 100 characters");
	assert.ok(rows[0].startsWith(" $ step0 && "));
	assert.match(rows[1], /^   \S/, "the second row lines up under the command, past \"$ \"");
	assert.ok(rows[1].endsWith("…"), "the rest is cut with an ellipsis");
	assert.deepEqual(tool("bash", native).renderCall({ command: "ls" }, theme).render(120).map((row) => plain(row)), [" $ ls"]);
});

test("a long path stays on the tool's row and goes on under it, never alone on its own row", async () => {
	const { tool } = await load();
	const file = `/tmp/${"segment-".repeat(15)}end/images/4.png`;
	const rows = tool("read", native).renderCall({ path: file }, theme).render(80).map((row) => plain(row));
	assert.ok(rows[0].startsWith(" read /tmp/segment-"), "the path starts on the tool's row");
	assert.equal(rows[0].length, 80, "and fills it to the width");
	assert.equal(rows.length, 2);
	assert.match(rows[1], /^ {6}\S/, "the rest lines up under the path, past \"read \"");
	assert.equal(rows.map((row, i) => (i ? row.trimStart() : row.slice(6))).join(""), file);
	assert.deepEqual(tool("read", native).renderCall({ path: "/tmp/a.ts" }, theme).render(80).map((row) => plain(row)), [" read /tmp/a.ts"]);
});
