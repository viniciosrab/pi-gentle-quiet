import assert from "node:assert/strict";
import { test } from "node:test";
import { load, lines, theme } from "./helpers.mjs";

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

test("tool calls use Claude Code's tones: light name and command, softer grey path", async () => {
	const { tool } = await load();
	const LIGHT = "\x1b[38;2;188;188;188m";
	const GREY = "\x1b[38;2;153;153;153m";
	const read = tool("read", native).renderCall({ path: "/tmp/app.ts" }, theme).render(80)[0];
	assert.ok(read.includes(`${LIGHT}read`), "tool name in the light tone");
	assert.ok(read.includes(`${GREY}/tmp/app.ts`), "path in the softer grey");
	assert.ok(!read.includes("\x1b[1m"), "no bold title");
	const bash = tool("bash", native).renderCall({ command: "nproc" }, theme).render(80)[0];
	assert.ok(bash.includes(`${LIGHT}$ nproc`), "the command row is light, apart from its grey result row");
});
