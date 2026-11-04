import assert from "node:assert/strict";
import os from "node:os";
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

test("read collapses to the path and a ✓ line count with the expand hint", async () => {
	const out = await draw("read", { path: "/tmp/app.ts", offset: 10, limit: 3 }, text("a\nb\nc"));
	assert.equal(out[0], " read /tmp/app.ts:10-12");
	assert.match(out[1], /^ └ ✓ 3 lines +ctrl\+o to expand$/);
});

test("bash failures show the exit code and the last output line on one row, without a hint", async () => {
	const out = await draw("bash", { command: "false" }, text("boom\nCommand exited with code 1", { isError: true }), {}, { isError: true });
	assert.deepEqual(out, [" $ false", " └ ✗ exit 1 · boom"]);
	const { tool } = await load();
	const row = tool("bash", native).renderResult(text("boom\nCommand exited with code 1", { isError: true }), {}, theme, { args: { command: "false" }, isError: true }).render(70)[0];
	assert.ok(painted(row, "error", "· boom"), "the output line in the error color");
});

test("with preview rows on, a failure keeps its output rows under the summary", async () => {
	writeConfig({ quiet: { preview: 3 } });
	const out = await draw("bash", { command: "false" }, text("one\ntwo\nCommand exited with code 1", { isError: true }), {}, { isError: true });
	writeConfig({});
	assert.deepEqual(out, [" $ false", " └ ✗ exit 1", "   one", "   two"]);
});

test("empty and running calls show no expand hint", async () => {
	assert.deepEqual(await draw("bash", { command: "true" }, text("")), [" $ true", " └ ✓ no output"]);
	assert.deepEqual(await draw("bash", { command: "sleep 1" }, text(""), { isPartial: true }), [" $ sleep 1", " └ running…"]);
});

test("summaries for grep, find, ls and write", async () => {
	assert.match((await draw("grep", { pattern: "x", path: "src" }, text("a:1\nb:2")))[1], /^ └ ✓ 2 matches/);
	assert.match((await draw("find", { pattern: "*.md" }, text("")))[1], /✓ no files/);
	assert.match((await draw("ls", { path: "." }, text("a")))[1], /^ └ ✓ 1 entry/);
	assert.match((await draw("write", { path: "b.md", content: "x\ny" }, text("ok")))[1], /✓ 2 lines written +ctrl\+o to expand/);
});

test("a command's hidden output takes a +; what a read or a search found keeps its ✓", async () => {
	assert.match((await draw("bash", { command: "ls" }, text("a\nb")))[1], /^ └ \+ 2 lines +ctrl\+o to expand$/);
	assert.match((await draw("bash", { command: "true" }, text("")))[1], /^ └ ✓ no output$/);
	assert.match((await draw("read", { path: "/tmp/a.png" }, { content: [{ type: "image", data: "", mimeType: "image/png" }] }))[1], /^ └ ✓ image$/);
	assert.match((await draw("find", { pattern: "*.md" }, text("a.md")))[1], /^ └ ✓ 1 file/);
});

test("with preview rows showing every output line, nothing is hidden: the command keeps its ✓", async () => {
	writeConfig({ quiet: { preview: 3 } });
	const out = await draw("bash", { command: "ls" }, text("a\nb"));
	writeConfig({});
	assert.deepEqual(out, [" $ ls", " └ ✓ 2 lines", "   a", "   b"]);
	writeConfig({ quiet: { preview: 1 } });
	const more = await draw("bash", { command: "ls" }, text("a\nb"));
	writeConfig({});
	assert.deepEqual([more[1], more[2].replace(/ +/g, " ")], [" └ + 2 lines", " b ctrl+o to expand"], "one row shown, one kept");
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
	assert.equal(out[1], " └ ✗ 1 of 2 calls failed");
	assert.match(out[2], /^   ✗ supabase\/list_tables permission denied +ctrl\+o to expand$/, "the hint ends the block");
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

test("a failed command's output line has no tab gap, and the expand hint ends its row, cut to make room", async () => {
	const long = `>\t\t\treturn { summary: ${"x".repeat(120)} }`;
	const out = await draw("bash", { command: "diff a b" }, text(`first\n${long}\nCommand exited with code 1`, { isError: true }), {}, { isError: true });
	assert.equal(out.length, 2, out.join("\n"));
	assert.match(out[1], /^ └ ✗ exit 1 · > return \{ summary: x+… +ctrl\+o to expand$/, out[1]);
	assert.ok(out[1].length <= 70);
});

test("a $ command whose first word is longer than the row starts on the $ row, filling it, not under it", async () => {
	const { tool } = await load();
	const word = `f=/home/user/${"node_modules/pkg/".repeat(10)}tool-execution.js`;
	const rows = tool("bash", native).renderCall({ command: `${word}; sed -n 70,100p $f` }, theme, { state: {} }).render(80).map((row) => plain(row));
	assert.ok(rows[0].startsWith(" $ f=/home/user/node_modules/"), `the command on the $ row:\n${rows.join("\n")}`);
	assert.equal(rows[0].length, 80, "the $ row filled");
	assert.ok(rows.slice(1).every((row) => /^ {3}\S/.test(row) && row.length <= 80), rows.join("\n"));
	assert.equal(rows.map((row) => row.trim()).join("").replace(/^\$ /, "").replace(/\s/g, ""), `${word};sed-n70,100p$f`, "nothing lost");
});

const steps = (count) => Array.from({ length: count }, (_, i) => `step${i}`).join(" && ");

test("a long $ command wraps under itself to three rows at most, the third cut with …", async () => {
	const { tool } = await load();
	const rows = tool("bash", native).renderCall({ command: steps(40) }, theme, { state: {} }).render(120).map((row) => plain(row));
	assert.equal(rows.length, 3, rows.join("\n"));
	assert.ok(rows[0].startsWith(" $ step0 && "), rows[0]);
	assert.ok(rows.slice(1).every((row) => /^ {3}\S/.test(row)), `the rest under the command's text:\n${rows.join("\n")}`);
	assert.ok(rows[2].endsWith("…") && rows.every((row) => row.length <= 120), rows.join("\n"));
	assert.deepEqual(tool("bash", native).renderCall({ command: "ls" }, theme, { state: {} }).render(120).map((row) => plain(row)), [" $ ls"]);
});

test("once its result is drawn, a wrapped $ command's second row starts with the └, and its summary and hint come after its last row", async () => {
	const { tool } = await load();
	const renderers = tool("bash", native);
	const context = { args: { command: steps(16) }, state: {} };
	const call = renderers.renderCall(context.args, theme, context);
	const result = renderers.renderResult(text("a\nb"), { isPartial: false }, theme, context);
	const rows = [...call.render(120), ...result.render(120)].map((row) => plain(row).trimEnd());
	assert.equal(rows.length, 3, rows.join("\n"));
	assert.ok(rows[0].startsWith(" $ step0 && "), rows.join("\n"));
	assert.ok(/^ └ \S/.test(rows[1]) && rows[1].endsWith("step15"), `the └ starts the command's second row:\n${rows.join("\n")}`);
	assert.match(rows[2], /^ {3}\+ 2 lines +ctrl\+o to expand$/, "the summary last, without the └");
	assert.equal([rows[0], rows[1]].join(" ").replace("└", "").split(/\s+/).filter((word) => /^step\d+$/.test(word)).length, 16, "no step lost");
});

test("a running $ command with no result yet shows its rows together, and ctrl+o shows the command whole", async () => {
	const { tool } = await load();
	const renderers = tool("bash", native);
	const running = renderers.renderCall({ command: steps(16) }, theme, { state: {} }).render(120).map((row) => plain(row));
	assert.equal(running.length, 2, running.join("\n"));
	const expanded = renderers.renderCall({ command: steps(40) }, theme, { state: {}, expanded: true }).render(120).map((row) => plain(row));
	assert.ok(expanded.length > 3 && !expanded.some((row) => row.endsWith("…")), expanded.join("\n"));
});

test("a leading cd is dim context, its deep folder cut to the last name; ctrl+o shows it whole", async () => {
	const { tool } = await load();
	const renderers = tool("bash", native);
	const call = (command, context = { state: {} }) => renderers.renderCall({ command }, theme, context).render(200);
	const deep = `${os.homedir()}/.herdr/worktrees/gentle-shell/worktree-calm-forest-6059`;
	const [row] = call(`cd ${deep} && gh label list`);
	assert.equal(plain(row), " $ cd ~/…/worktree-calm-forest-6059 && gh label list");
	assert.ok(painted(row, "dim", "cd ~/…/worktree-calm-forest-6059 &&"), "the cd prefix in dim");
	assert.ok(!painted(row, "dim", " gh label list"), "the command itself not dim");
	assert.equal(plain(call("cd /srv/apps/shop/api; make")[0]), " $ cd /…/api; make");
	assert.equal(plain(call('cd "/srv/my apps/shop/api" && make')[0]), ' $ cd "/…/api" && make');
	// Short folders and commands without a leading cd stay as they are.
	assert.equal(plain(call("cd /tmp && ls")[0]), " $ cd /tmp && ls");
	assert.equal(plain(call(`cd ${os.homedir()}/code/shop && ls`)[0]), " $ cd ~/code/shop && ls");
	assert.equal(plain(call("echo cd /srv/apps/shop/api && ls")[0]), " $ echo cd /srv/apps/shop/api && ls");
	assert.equal(plain(call("cd ../apps/shop/api && ls")[0]), " $ cd ../apps/shop/api && ls");
	// Expanded, the folder is whole, still dim.
	const [whole] = call(`cd ${deep} && gh label list`, { state: {}, expanded: true });
	assert.equal(plain(whole), ` $ cd ${deep} && gh label list`);
	assert.ok(painted(whole, "dim", `cd ${deep} &&`));
});

test("a wrapped command with a leading cd keeps the short folder once its result is drawn", async () => {
	const { tool } = await load();
	const renderers = tool("bash", native);
	const context = { args: { command: `cd /srv/apps/shop/api && ${steps(16)}` }, state: {} };
	const call = renderers.renderCall(context.args, theme, context);
	const result = renderers.renderResult(text("a\nb"), { isPartial: false }, theme, context);
	const rows = [...call.render(120), ...result.render(120)].map((row) => plain(row).trimEnd());
	assert.ok(rows[0].startsWith(" $ cd /…/api && step0 && "), rows.join("\n"));
	assert.ok(/^ └ \S/.test(rows[1]), rows.join("\n"));
	assert.equal(rows.join(" ").replace("└", "").split(/\s+/).filter((word) => /^step\d+$/.test(word)).length, 16, "no step lost");
});

const DEEP = `${os.homedir()}/.herdr/worktrees/pi-gentle-quiet/worktree-brave-field-0c10/extensions/sidebar`;
const callRows = async (name, args, width = 80, context = {}) => {
	const { tool } = await load();
	return tool(name, native).renderCall(args, theme, context).render(width).map((row) => plain(row));
};

test("a long read path stays on one row, its first folders dropped so the file name stays", async () => {
	const rows = await callRows("read", { path: `/tmp/${"segment-".repeat(15)}end/images/4.png`, offset: 10, limit: 5 });
	assert.deepEqual(rows, [" read /…/images/4.png:10-14"]);
	assert.deepEqual(await callRows("read", { path: `${DEEP}/run-popup.ts` }), [" read ~/…/worktree-brave-field-0c10/extensions/sidebar/run-popup.ts"]);
	assert.deepEqual(await callRows("read", { path: "/tmp/a.ts" }), [" read /tmp/a.ts"]);
});

test("edit, write, find and ls keep their call on one row, the path cut from its start", async () => {
	assert.deepEqual(await callRows("edit", { path: `${DEEP}/run-popup.ts` }, 60), [" edit ~/…/extensions/sidebar/run-popup.ts"]);
	assert.deepEqual(await callRows("write", { path: `${DEEP}/run-popup.ts` }, 40), [" write ~/…/sidebar/run-popup.ts"]);
	assert.deepEqual(await callRows("find", { pattern: "**/*.ts", path: DEEP }, 50), [" find **/*.ts in ~/…/extensions/sidebar"]);
	assert.deepEqual(await callRows("ls", { path: DEEP }, 40), [" ls ~/…/extensions/sidebar"]);
	assert.deepEqual(await callRows("edit", { path: "/tmp/a.ts" }), [" edit /tmp/a.ts"]);
	// A file name longer than the row is cut at its end.
	const [row, ...more] = await callRows("edit", { path: `/tmp/${"x".repeat(100)}.ts` }, 40);
	assert.deepEqual(more, []);
	assert.ok(row.startsWith(" edit /…/xxx") && row.endsWith("…") && row.length === 40, row);
});

test("a long grep pattern is cut with … after its path is, keeping the folder and glob", async () => {
	const rows = await callRows("grep", { pattern: "renderCall\\(args, t, context = \\{\\}\\)|renderResult\\(result, options", path: DEEP, glob: "*.ts" }, 80);
	assert.equal(rows.length, 1, rows.join("\n"));
	assert.ok(rows[0].length <= 80, rows[0]);
	assert.match(rows[0], /^ grep \/renderCall.*…\/ in ~\/…\/sidebar \(\*\.ts\)$/, rows[0]);
});

test("codegraph queries and monitor labels too long for the row are cut with …", async () => {
	const query = await callRows("codegraph", { operation: "query", query: "where does the quiet tool renderer decide between the check mark and the plus mark" }, 60);
	assert.equal(query.length, 1);
	assert.match(query[0], /^ codegraph query "where does .*…"$/, query[0]);
	assert.ok(query[0].length <= 60);
	const monitor = await callRows("monitor", { label: "CI checks for PR 1842 on viniciosrab/pi-gentle-quiet while the release workflow runs" }, 60);
	assert.equal(monitor.length, 1);
	assert.ok(monitor[0].startsWith(" monitor CI checks") && monitor[0].endsWith("…") && monitor[0].length === 60, monitor[0]);
});

test("ctrl+o shows a call row whole, wrapped under its argument", async () => {
	const rows = await callRows("edit", { path: `${DEEP}/run-popup.ts` }, 60, { expanded: true });
	assert.ok(rows.length > 1 && rows.every((row) => row.length <= 60), rows.join("\n"));
	assert.ok(rows.slice(1).every((row) => /^ {6}\S/.test(row)), `the rest under the path:\n${rows.join("\n")}`);
	assert.equal(rows.map((row) => row.trim()).join(""), `edit ${DEEP.replace(os.homedir(), "~")}/run-popup.ts`, "nothing lost");
});
