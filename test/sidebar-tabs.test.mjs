import assert from "node:assert/strict";
import { test } from "node:test";
import { load, painted, plain, role, theme, writeConfig } from "./helpers.mjs";
import { renderTabBar, TAB_FACTORIES, TABS } from "../extensions/sidebar/tabs.ts";

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

function host({ columns = 180, rows = 40 } = {}) {
	const native = { type: "vstack", entries: [] };
	const root = { render: () => [], [NODE]: () => native };
	const terminal = { columns, rows };
	let renders = 0;
	const tui = { terminal, mode: "fullscreen", layoutRoot: root, requestRender: () => renders++ };
	return { tui, root, native, terminal, renders: () => renders };
}

const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };
const panel = (title, ...rows) => (width) => [`   ❀ ${title}`, ...rows.map((row) => `   ${row}`)].map((row) => row.padEnd(width));

async function wide(options = {}, config = {}) {
	writeConfig(config);
	const loaded = await load({ mode: "tui", session: { cwd: "/srv/app", model: { id: "claude-opus-5-5" }, usage: { percent: 28 } } });
	const h = host(options);
	loaded.footer()?.(h.tui, theme, footerData);
	loaded.ui.setWidget("gentle-todo", () => ({ render: panel("Todos  1 of 2", "◐ Write it", "○ Test it") }));
	loaded.ui.setWidget("gentle-agents", () => ({ render: panel("Agents  1 active", "◐ gentle-ai-worker") }));
	const todo = loaded.widgets["gentle-todo"](h.tui, theme);
	const agents = loaded.widgets["gentle-agents"](h.tui, theme);
	const side = () => h.root[NODE]().entries?.[1]?.component?.[NODE]?.();
	const bar = () => side().entries[0].component;
	const barRows = () => bar().render(60).map(plain);
	// The x of a tab's label in the tab bar, as Pi hands it to the bar (local to the bar).
	const tabX = (label) => barRows()[0].indexOf(label) + 1;
	const clickTab = (label, y = 0) => bar().handleMouse({ type: "click", button: "left", x: tabX(label), y, width: 60, height: 2, screenX: 120, screenY: y });
	const wheelBar = (delta) => bar().handleMouse({ type: "wheel", button: "none", x: 5, y: 0, width: 60, height: 2, screenX: 125, screenY: 0, wheelDelta: delta });
	const content = () => side().entries.at(-1).component;
	return { ...loaded, ...h, todo, agents, side, bar, barRows, tabX, clickTab, wheelBar, content, rows: (width = 60) => content().render(width).map(plain) };
}

// A tab standing in for one of the tab modules, recording the mouse events it gets.
function fakeTab(id, rowsFor) {
	const seen = { hosts: [], clicks: [], wheels: [], sizes: [] };
	const factory = (host) => {
		seen.hosts.push(host);
		return {
			id,
			render(width, height) {
				seen.sizes.push([width, height]);
				return rowsFor(width, height, host);
			},
			handleClick(line, button, x) {
				seen.clicks.push([line, button, x]);
				return line === 3;
			},
			handleWheel(delta, line, x) {
				seen.wheels.push([delta, line, x]);
				return delta > 0;
			},
		};
	};
	return { seen, factory };
}

async function withTab(id, factory, run) {
	const original = TAB_FACTORIES[id];
	TAB_FACTORIES[id] = factory;
	try {
		await run();
	} finally {
		TAB_FACTORIES[id] = original;
	}
}

test("the tabs are 1:MAIN 2:GIT 3:PROF 4:MEM 5:TREE, with no AGENTS or YouTube tab", () => {
	assert.deepEqual(TABS.map((tab) => `${tab.key}:${tab.label}`), ["1:MAIN", "2:GIT", "3:PROF", "4:MEM", "5:TREE"]);
	assert.deepEqual(Object.keys(TAB_FACTORIES).sort(), ["git", "mem", "prof", "tree"]);
});

test("the tab bar draws the active tab bracketed in accent bold and the others dim and muted, spread across the width", () => {
	const { line, divider, hitboxes } = renderTabBar(58, "tree", theme);
	const text = plain(line);
	assert.equal([...text].length, 58);
	assert.match(text, /^1:MAIN +2:GIT +3:PROF +4:MEM +\[ 5:TREE \]$/);
	const gaps = hitboxes.slice(1).map((box, i) => box.startX - hitboxes[i].endX);
	assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, "equal gaps");
	assert.ok(line.includes(role("accent")) && line.includes(theme.bold("[ 5:TREE ]")), "active: accent and bold");
	assert.ok(painted(line, "dim", "1") && painted(line, "muted", "MAIN"), "inactive: key dim, label muted");
	assert.equal(plain(divider), "─".repeat(58));
	assert.ok(painted(divider, "border"), "the divider in the border color");
	assert.deepEqual(hitboxes.map((box) => box.id), ["main", "git", "prof", "mem", "tree"]);
	assert.equal(text.slice(hitboxes[4].startX, hitboxes[4].endX), "[ 5:TREE ]");
	assert.equal(text.slice(hitboxes[1].startX, hitboxes[1].endX), "2:GIT");
});

test("under 44 columns the active tab drops the spaces inside its brackets, and nothing overflows", () => {
	const { line } = renderTabBar(43, "main", theme);
	assert.ok(plain(line).startsWith("[1:MAIN]"));
	assert.ok([...plain(line)].length <= 43);
	assert.ok([...plain(renderTabBar(20, "main", theme).line)].length <= 20, "cut when even that does not fit");
});

test("the column opens with the tab bar fixed on top, MAIN active, with no banner", async () => {
	const { side, barRows } = await wide();
	const entries = side().entries;
	assert.equal(entries[0].basis, "auto");
	assert.equal(entries[0].grow, 0, "the bar stays on top, outside the scrolling");
	const [bar, divider] = barRows();
	assert.equal(barRows().length, 2);
	assert.match(bar, /^ \[ 1:MAIN \] +2:GIT +3:PROF +4:MEM +5:TREE $/);
	assert.match(divider, /^─+$/);
	assert.ok(!barRows().join("").includes("CINLODEV"));
});

// MAIN with a Jobs card above Todos: test/jobs-card.test.mjs, which installs gentle-pi's jobs files.
test("MAIN shows the Status and Context cards fixed under the bar, then Todos scrolling, and no Agents card", async () => {
	const loaded = await wide();
	const entries = loaded.side().entries;
	assert.equal(entries.length, 3);
	assert.equal(entries[1].basis, "auto");
	const status = entries[1].component.render(60).map(plain).map((row) => row.replace(/ +│$/, ""));
	assert.equal(status[1], "│ Status");
	assert.ok(status.includes("│ Context"));
	assert.equal(entries[2].grow, 1);
	const out = loaded.rows();
	const titles = out.filter((row, i) => i > 0 && out[i - 1].startsWith("┌")).map((row) => row.replace(/ +│$/, ""));
	assert.deepEqual(titles.map((row) => row.replace(/ {2}.*/, "")), ["│ ≡ Todos"], "Todos alone, with no jobs");
	assert.ok(!out.some((row) => row.includes("Agents")), "the Agents card is not in the column");
});

test("with the column open the Agents card stays inline above the editor, drawn as without the column", async () => {
	const loaded = await wide();
	assert.equal(loaded.root[NODE]().type, "hstack");
	const inline = loaded.agents.render(60).map(plain).map((row) => row.replace(/ +│$/, ""));
	assert.ok(inline[0].startsWith("┌") && inline.at(-1).startsWith("└"));
	assert.deepEqual(inline.slice(1, 3), ["│ ◈ Agents  1 active", "│ ◔ gentle-ai-worker"], "no blank row under the title, as in place");
	assert.deepEqual(loaded.todo.render(60), [], "Todos still leaves its place for the column");
	for (const label of ["2:GIT", "3:PROF", "4:MEM", "5:TREE"]) {
		loaded.clickTab(label);
		assert.ok(loaded.agents.render(60).length > 0, label);
	}
});

test("clicking a tab in the bar switches to it, and the bar marks it", async () => {
	const { clickTab, barRows, side, rows } = await wide();
	assert.equal(clickTab("3:PROF")?.handled, true);
	assert.match(barRows()[0], /\[ 3:PROF \]/);
	assert.match(barRows()[0], /^ 1:MAIN /);
	assert.equal(side().entries.length, 2, "the bar and the tab's content");
	assert.ok(!rows().some((row) => /Todos|Status|Agents/.test(row)), "the tab's own cards only");
	assert.equal(clickTab("1:MAIN")?.handled, true);
	assert.equal(side().entries.length, 3, "back to MAIN");
});

test("a click on the divider row or between two tabs picks the nearest tab; a press is taken so the click comes back", async () => {
	const { bar, barRows, clickTab } = await wide();
	const press = bar().handleMouse({ type: "press", button: "left", x: 3, y: 0, width: 60, height: 2, screenX: 120, screenY: 0 });
	assert.equal(press?.handled, true);
	assert.equal(clickTab("3:PROF", 1)?.handled, true, "on the divider");
	assert.match(barRows()[0], /\[ 3:PROF \]/);
	const gapStart = barRows()[0].indexOf("2:GIT") + "2:GIT".length;
	bar().handleMouse({ type: "click", button: "left", x: gapStart, y: 0, width: 60, height: 2, screenX: 120, screenY: 0 });
	assert.match(barRows()[0], /\[ 2:GIT \]/, "just past GIT: GIT");
	assert.equal(bar().handleMouse({ type: "click", button: "right", x: 2, y: 0, width: 60, height: 2, screenX: 120, screenY: 0 }), undefined, "only the left button");
});

test("the wheel over the bar cycles the tabs, wrapping at both ends", async () => {
	const { wheelBar, barRows, renders } = await wide();
	const before = renders();
	assert.equal(wheelBar(1)?.handled, true);
	assert.match(barRows()[0], /\[ 2:GIT \]/);
	assert.ok(renders() > before, "the column is redrawn");
	wheelBar(-1);
	wheelBar(-1);
	assert.match(barRows()[0], /\[ 5:TREE \]/, "MAIN back to TREE");
	wheelBar(1);
	assert.match(barRows()[0], /\[ 1:MAIN \]/, "TREE on to MAIN");
});

test("GIT, PROF, MEM and TREE draw their own cards in the square outline, within the column", async () => {
	const loaded = await wide();
	for (const [label, title] of [["2:GIT", "GIT"], ["3:PROF", "PROF"], ["4:MEM", "MEM"], ["5:TREE", "TREE"]]) {
		loaded.clickTab(label);
		const out = loaded.rows();
		assert.ok(out[0].startsWith("┌"), title);
		assert.ok(!out.some((row) => row.includes("coming soon")), title);
		assert.ok(out.every((row) => [...row].length <= 60), title);
	}
});

test("a tab module gets the column's width and height and its mouse events in its own coordinates", async () => {
	const tall = Array.from({ length: 50 }, (_, i) => `row ${i}`);
	const { seen, factory } = fakeTab("git", (width) => tall.map((row) => row.padEnd(width)));
	await withTab("git", factory, async () => {
		const loaded = await wide({ rows: 30 });
		loaded.clickTab("2:GIT");
		assert.equal(loaded.rows()[0].trim(), "row 0");
		assert.deepEqual(seen.sizes.at(-1), [59, 28], "the terminal's height less the bar and its divider");
		const column = loaded.content();
		const event = (type, y, extra = {}) => column.handleMouse({ type, button: "left", x: 7, y, width: 60, height: 28, screenX: 127, screenY: y + 2, ...extra });
		assert.equal(event("click", 3)?.handled, true, "the tab took it");
		assert.equal(event("click", 4)?.handled, undefined, "the tab left it");
		assert.deepEqual(seen.clicks, [[3, "left", 7], [4, "left", 7]]);
		assert.equal(event("wheel", 5, { wheelDelta: 3 })?.handled, true);
		assert.deepEqual(seen.wheels, [[3, 5, 7]]);
		assert.equal(seen.hosts.length, 1, "one tab per column");
	});
});

test("the host hands a tab the theme, the card outline, the session and a redraw", async () => {
	const { seen, factory } = fakeTab("mem", (width, _height, host) => host.card("Engram", [host.fg("muted", "ok")], width));
	await withTab("mem", factory, async () => {
		const loaded = await wide();
		loaded.clickTab("4:MEM");
		const out = loaded.rows().map((row) => row.replace(/ +│$/, ""));
		assert.deepEqual(out.slice(1, 4), ["│ Engram", "│", "│ ok"]);
		const host = seen.hosts[0];
		assert.equal(host.cwd(), "/srv/app");
		assert.equal(host.ctx(), loaded.ctx);
		assert.equal(host.theme, theme);
		assert.equal(typeof host.git, "function");
		assert.equal(typeof host.agentDir, "string");
		const before = loaded.renders();
		host.requestRender();
		assert.equal(loaded.renders(), before + 1);
	});
});

test("a tab that throws draws an error card instead of closing the column", async () => {
	await withTab("prof", () => ({ id: "prof", render: () => { throw new Error("boom"); } }), async () => {
		const loaded = await wide();
		loaded.clickTab("3:PROF");
		assert.equal(loaded.root[NODE]().type, "hstack");
		assert.ok(loaded.rows().some((row) => row.includes("PROF — boom")));
		loaded.clickTab("1:MAIN");
		assert.ok(loaded.rows().some((row) => row.includes("Todos")), "MAIN still draws");
	});
});

test("below the breakpoint nothing changes, whatever tab was open", async () => {
	const loaded = await wide();
	loaded.clickTab("2:GIT");
	loaded.terminal.columns = 139;
	assert.equal(loaded.root[NODE](), loaded.native);
	assert.ok(loaded.todo.render(60).length > 0, "Todos back in place");
	loaded.terminal.columns = 180;
	assert.match(loaded.barRows()[0], /\[ 2:GIT \]/, "the tab is remembered while the column is closed");
});
