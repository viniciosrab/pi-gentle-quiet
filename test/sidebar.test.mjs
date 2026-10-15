import assert from "node:assert/strict";
import { test } from "node:test";
import { load, picker, plain, readConfig, theme, writeConfig } from "./helpers.mjs";

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const GENTLE_SIDEBAR = Symbol.for("gentle-pi.experimental-sidebar.state");

// A fullscreen host: its layout root hands out the native tree until the extension swaps it.
function host({ columns = 180, mode = "fullscreen", gentle } = {}) {
	const native = { type: "vstack", entries: [] };
	const root = { render: () => [], [NODE]: () => native };
	const terminal = { columns, rows: 40, ...(gentle ? { [GENTLE_SIDEBAR]: gentle } : {}) };
	const tui = { terminal, mode, layoutRoot: root, requestRender() {} };
	return { tui, root, native, terminal };
}

const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };
const panel = (title, ...rows) => (width) => [`   ❀ ${title}`, ...rows.map((row) => `   ${row}`)].map((row) => row.padEnd(width));

async function wide(options = {}, config = {}) {
	writeConfig(config);
	const loaded = await load({ mode: "tui", session: { cwd: "/srv/app", model: { id: "claude-opus-5-5" }, usage: { percent: 28 } } });
	const h = host(options);
	const footer = loaded.footer()?.(h.tui, theme, footerData);
	loaded.ui.setWidget("gentle-todo", () => ({ render: panel("Todos  1 of 2", "◐ Write it", "○ Test it") }));
	loaded.ui.setWidget("gentle-agents", () => ({ render: panel("Agents  1 active", "◐ gentle-ai-worker") }));
	const todo = loaded.widgets["gentle-todo"](h.tui, theme);
	const agents = loaded.widgets["gentle-agents"](h.tui, theme);
	const layout = h.root[NODE]();
	// [status bar / [conversation | column]]
	const bar = layout.entries?.[0]?.component;
	const body = layout.entries?.[1]?.component?.[NODE]?.();
	const rail = body?.entries?.[1]?.component;
	return { ...loaded, ...h, footer, todo, agents, layout, bar, body, rail, rows: (width = 52) => rail?.render(width).map(plain) };
}

test("wide fullscreen terminals put the status bar on top of the conversation and a side column", async () => {
	const { layout, body, native } = await wide();
	assert.equal(layout.type, "vstack");
	assert.equal(layout.entries[0].basis, "auto", "the bar is as tall as its rows");
	assert.equal(body.type, "hstack");
	assert.equal(body.entries[0].component[NODE](), native, "the conversation keeps Pi's own layout");
	assert.equal(body.entries[1].basis, 52, "fixed column width");
	assert.equal((await wide({ columns: 300 })).body.entries[1].basis, 52, "whatever the terminal width");
});

test("the status line is the original bar, full width, set off by a blank row above and a rule below", async () => {
	const { bar } = await wide({ columns: 180 });
	const out = bar.render(180).map(plain);
	assert.equal(out.length, 3);
	assert.equal(out[0], "", "keeps the bar off what the terminal draws above Pi");
	assert.match(out[1], /^ \/srv\/app .*claude-opus-5-5 .*ctx .* 28%/);
	assert.ok([...out[1]].length <= 180 && [...out[1]].length >= 179, "spans the terminal");
	assert.equal(out[2], "─".repeat(180));
});

test("the column stacks Agents and Todos in the same square outline as above the input", async () => {
	const { rows } = await wide();
	const out = rows();
	const tops = out.flatMap((row, i) => (row.startsWith("┌") ? [i] : []));
	assert.equal(tops.length, 2);
	assert.match(out[tops[0] + 1], /^│ ◈ Agents {2}1 active/, "Agents first");
	assert.deepEqual(out.slice(tops[1] + 1, tops[1] + 4).map((row) => row.replace(/ +│$/, "")), ["│ ≡ Todos  1 of 2", "│ ◐ Write it", "│ ○ Test it"], "same padding and tight rows as the panels above the input");
	assert.ok(out[tops[1] - 1].startsWith("└"), "no blank row between the cards");
	assert.ok(out.every((row) => [...row].length <= 51), "rows fit the column minus its scrollbar");
});

test("Todos, Agents and the footer leave their usual places while the column is open", async () => {
	const { todo, agents, footer } = await wide();
	assert.deepEqual(todo.render(100), []);
	assert.deepEqual(agents.render(100), []);
	assert.deepEqual(footer.render(100), []);
});

test("below the breakpoint everything stays where it is", async () => {
	const { tui, root, native, todo, agents, footer, terminal } = await wide({ columns: 139 });
	assert.equal(root[NODE](), native);
	assert.equal(plain(todo.render(60)[0]), "┌──────────────────────────────────────────────────────────┐");
	assert.ok(agents.render(60).length > 0);
	assert.ok(footer.render(100).length > 0);
	terminal.columns = 140;
	assert.equal(root[NODE]().type, "vstack", "resizing wider opens the wide layout");
	assert.deepEqual(todo.render(100), []);
	terminal.columns = 120;
	assert.equal(root[NODE](), native, "and narrower closes it again");
	assert.ok(todo.render(60).length > 0);
	assert.ok(tui.terminal);
});

test("regular mode keeps Pi's scrollback layout", async () => {
	const { root, native, todo } = await wide({ mode: "regular" });
	assert.equal(root[NODE](), native);
	assert.ok(todo.render(60).length > 0);
});

test("the column can be turned off or moved to another width", async () => {
	const off = await wide({}, { sidebar: { enabled: false } });
	assert.equal(off.layout, off.native);
	const late = await wide({ columns: 150 }, { sidebar: { minColumns: 160 } });
	assert.equal(late.layout, late.native);
});

test("without Agents or Todos only the status bar goes on top, with no empty column", async () => {
	const loaded = await wide();
	loaded.ui.setWidget("gentle-todo", undefined);
	loaded.ui.setWidget("gentle-agents", undefined);
	const layout = loaded.root[NODE]();
	assert.equal(layout.type, "vstack");
	assert.equal(layout.entries[1].component[NODE](), loaded.native);
});

test("with Pi's own status line the column holds Agents and Todos, and nothing opens when they are empty", async () => {
	const loaded = await wide({}, { statusLine: { enabled: false } });
	assert.equal(loaded.layout.type, "hstack");
	loaded.ui.setWidget("gentle-todo", undefined);
	loaded.ui.setWidget("gentle-agents", undefined);
	assert.equal(loaded.root[NODE](), loaded.native);
});

test("gentle-shell's own sidebar takes precedence", async () => {
	const { root, native } = await wide({ gentle: { ownsHost: () => true, parts: new Map() } });
	assert.equal(root[NODE](), native);
});

test("/gentle-quiet toggles the column and picks the width it opens at", async () => {
	writeConfig({});
	const { select, seen } = picker(/^Blocks and agents ›$/, /^Side column: on/, /^Side column from: 140 columns/, /^Back|^← Back/);
	const { commands, ctx } = await load({ select });
	await commands["gentle-quiet"].handler("", ctx);
	assert.deepEqual(readConfig().sidebar, { enabled: false, minColumns: 160 });
	assert.ok(seen.some(({ items }) => items.includes("Side column: off")), "the menu shows the new state");
});
