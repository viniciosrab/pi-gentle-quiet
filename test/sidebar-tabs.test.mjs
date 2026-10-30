import assert from "node:assert/strict";
import { test } from "node:test";
import { load, painted, plain, readConfig, role, theme, writeConfig } from "./helpers.mjs";
import { cycleTab, DEFAULT_TAB_ORDER, moveTab, moveTabTo, normalizeTabOrder, renderTabBar, slotAt, TAB_FACTORIES, TABS } from "../extensions/sidebar/tabs.ts";

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

test("the tabs are 1:MAIN 2:GIT 3:PROF 4:MEM 5:TREE 6:PR, with no AGENTS or YouTube tab", () => {
	assert.deepEqual(TABS.map((tab) => `${tab.key}:${tab.label}`), ["1:MAIN", "2:GIT", "3:PROF", "4:MEM", "5:TREE", "6:PR"]);
	assert.deepEqual(Object.keys(TAB_FACTORIES).sort(), ["git", "mem", "pr", "prof", "tree"]);
});

test("the tab bar draws the active tab bracketed in accent bold and the others dim and muted, spread across the width", () => {
	const { line, divider, hitboxes } = renderTabBar(58, "tree", theme);
	const text = plain(line);
	assert.equal([...text].length, 58);
	assert.match(text, /^1:MAIN +2:GIT +3:PROF +4:MEM +\[ 5:TREE \] +6:PR$/);
	const gaps = hitboxes.slice(1).map((box, i) => box.startX - hitboxes[i].endX);
	assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, "equal gaps");
	assert.ok(line.includes(role("accent")) && line.includes(theme.bold("[ 5:TREE ]")), "active: accent and bold");
	assert.ok(painted(line, "dim", "1") && painted(line, "muted", "MAIN"), "inactive: key dim, label muted");
	assert.equal(plain(divider), "─".repeat(58));
	assert.ok(painted(divider, "border"), "the divider in the border color");
	assert.deepEqual(hitboxes.map((box) => box.id), ["main", "git", "prof", "mem", "tree", "pr"]);
	assert.equal(text.slice(hitboxes[4].startX, hitboxes[4].endX), "[ 5:TREE ]");
	assert.equal(text.slice(hitboxes[1].startX, hitboxes[1].endX), "2:GIT");
});

test("under 44 columns the active tab drops the spaces inside its brackets, and nothing overflows", () => {
	const { line } = renderTabBar(43, "main", theme);
	assert.ok(plain(line).startsWith("[1:MAIN]"));
	assert.ok([...plain(line)].length <= 43);
	assert.match(plain(line), /^\[1:MAIN\] +2:GIT +3:PROF +4:MEM +5:TREE +6:PR *$/, "all six tabs still fit");
	assert.match(plain(renderTabBar(43, "pr", theme).line), / \[6:PR\]$/);
	assert.ok([...plain(renderTabBar(20, "main", theme).line)].length <= 20, "cut when even that does not fit");
});

test("the column opens with the tab bar fixed on top, MAIN active, with no banner", async () => {
	const { side, barRows } = await wide();
	const entries = side().entries;
	assert.equal(entries[0].basis, "auto");
	assert.equal(entries[0].grow, 0, "the bar stays on top, outside the scrolling");
	const [bar, divider] = barRows();
	assert.equal(barRows().length, 2);
	assert.match(bar, /^\[ 1:MAIN \] +2:GIT +3:PROF +4:MEM +5:TREE +6:PR$/, "the tabs from the column's start to its end");
	assert.equal([...bar].length, 59);
	assert.equal(divider, `╶${"─".repeat(57)}╴`, "the divider ends mid-cell, like the cards' corners");
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
	for (const label of ["2:GIT", "3:PROF", "4:MEM", "5:TREE", "6:PR"]) {
		loaded.clickTab(label);
		assert.ok(loaded.agents.render(60).length > 0, label);
	}
});

test("clicking a tab in the bar switches to it, and the bar marks it", async () => {
	const { clickTab, barRows, side, rows } = await wide();
	assert.equal(clickTab("3:PROF")?.handled, true);
	assert.match(barRows()[0], /\[ 3:PROF \]/);
	assert.match(barRows()[0], /^1:MAIN /);
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
	assert.match(barRows()[0], /\[ 6:PR \]/, "MAIN back to PR");
	wheelBar(1);
	assert.match(barRows()[0], /\[ 1:MAIN \]/, "PR on to MAIN");
});

test("GIT, PROF, MEM, TREE and PR draw their own cards in the square outline, within the column", async () => {
	const loaded = await wide();
	for (const [label, title] of [["2:GIT", "GIT"], ["3:PROF", "PROF"], ["4:MEM", "MEM"], ["5:TREE", "TREE"], ["6:PR", "PR"]]) {
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

test("a tab is told when it is hidden: another tab, or MAIN, takes its place", async () => {
	const hidden = [];
	const shown = [];
	const factory = (id) => () => ({ id, render: (width) => [" ".repeat(width)], onShow: () => shown.push(id), onHide: () => hidden.push(id) });
	await withTab("git", factory("git"), async () => {
		await withTab("mem", factory("mem"), async () => {
			const loaded = await wide();
			loaded.clickTab("2:GIT");
			loaded.rows();
			loaded.clickTab("4:MEM");
			loaded.rows();
			assert.deepEqual(hidden, ["git"]);
			loaded.clickTab("1:MAIN");
			loaded.rows();
			assert.deepEqual(hidden, ["git", "mem"]);
			assert.deepEqual(shown, ["git", "mem"]);
		});
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

test("a tab order keeps the known ids once, in their order, and appends the missing tabs in the default order", () => {
	assert.deepEqual(DEFAULT_TAB_ORDER, ["main", "git", "prof", "mem", "tree", "pr"]);
	assert.deepEqual(normalizeTabOrder(undefined), DEFAULT_TAB_ORDER);
	assert.deepEqual(normalizeTabOrder("pr"), DEFAULT_TAB_ORDER, "not an array");
	assert.deepEqual(normalizeTabOrder(["main", "pr"]), ["main", "pr", "git", "prof", "mem", "tree"], "partial");
	assert.deepEqual(normalizeTabOrder(["yt", "pr", 3, null, "agents"]), ["pr", "main", "git", "prof", "mem", "tree"], "unknown ids dropped");
	assert.deepEqual(normalizeTabOrder(["tree", "pr", "tree", "main", "pr"]), ["tree", "pr", "main", "git", "prof", "mem"], "duplicates once");
});

test("moving a tab up or down swaps it with its neighbour and stops at the ends", () => {
	assert.deepEqual(moveTab(DEFAULT_TAB_ORDER, "pr", -1), ["main", "git", "prof", "mem", "pr", "tree"]);
	assert.deepEqual(moveTab(DEFAULT_TAB_ORDER, "main", 1), ["git", "main", "prof", "mem", "tree", "pr"]);
	assert.deepEqual(moveTab(DEFAULT_TAB_ORDER, "main", -1), DEFAULT_TAB_ORDER, "first stays first");
	assert.deepEqual(moveTab(DEFAULT_TAB_ORDER, "pr", 1), DEFAULT_TAB_ORDER, "last stays last");
	assert.deepEqual(moveTab(["pr"], "pr", -1), ["pr", "main", "git", "prof", "mem", "tree"], "on a normalised order");
});

test("with a custom order the tab bar draws the tabs in it, numbered by position, and the wheel follows it", () => {
	const order = ["main", "pr", "git", "prof", "mem", "tree"];
	const { line, hitboxes } = renderTabBar(58, "pr", theme, order);
	assert.match(plain(line), /^1:MAIN +\[ 2:PR \] +3:GIT +4:PROF +5:MEM +6:TREE$/);
	assert.deepEqual(hitboxes.map((box) => box.id), order, "the ids stay the same");
	assert.match(plain(renderTabBar(58, "main", theme, ["tree"]).line), /^1:TREE +\[ 2:MAIN \] +3:GIT +4:PROF +5:MEM +6:PR$/, "a partial order");
	assert.equal(cycleTab("main", 1, order), "pr");
	assert.equal(cycleTab("tree", 1, order), "main", "wraps");
	assert.equal(cycleTab("main", -1, order), "tree");
	assert.equal(cycleTab("main", 1), "git", "the default order without one");
	assert.match(plain(renderTabBar(58, "main", theme).line), /^\[ 1:MAIN \] +2:GIT +3:PROF +4:MEM +5:TREE +6:PR$/, "default unchanged");
});

test("the column's tab bar, clicks and wheel follow sidebar.tabOrder from gentle-quiet.json", async () => {
	const { barRows, clickTab, wheelBar, side } = await wide({}, { sidebar: { tabOrder: ["main", "pr"] } });
	assert.match(barRows()[0], /^\[ 1:MAIN \] +2:PR +3:GIT +4:PROF +5:MEM +6:TREE$/);
	assert.equal(clickTab("2:PR")?.handled, true);
	assert.match(barRows()[0], /\[ 2:PR \]/);
	assert.equal(side().entries.length, 2, "the PR tab's content, not MAIN");
	wheelBar(1);
	assert.match(barRows()[0], /\[ 3:GIT \]/, "PR on to GIT");
	wheelBar(-1);
	wheelBar(-1);
	assert.match(barRows()[0], /\[ 1:MAIN \]/);
	wheelBar(-1);
	assert.match(barRows()[0], /\[ 6:TREE \]/, "MAIN back to TREE");
});

// Drag to reorder (S12): Pi sends the press, then drag events (motion with the button held) and the release to
// the component that captured the press, wherever the pointer goes; a click follows only when nothing moved.
function dragger(bar) {
	const send = (type, x, y = 0) => bar().handleMouse({ type, button: "left", x, y, width: 60, height: 2, screenX: 120 + x, screenY: y });
	return { press: (x, y) => send("press", x, y), drag: (x, y) => send("drag", x, y), release: (x, y) => send("release", x, y), click: (x, y) => send("click", x, y) };
}
const INVERSE = "\x1b[7m";

test("dragging a tab sideways moves it live, the others make room, and the release saves sidebar.tabOrder", async () => {
	const { bar, barRows, tabX, side } = await wide();
	const { press, drag, release, click } = dragger(bar);
	const from = tabX("6:PR");
	const to = tabX("2:GIT");
	assert.equal(press(from)?.capture, true, "the press captures the drag and the release");
	const moving = drag(to, 5); // below the bar: still the bar's, captured
	assert.equal(moving?.handled, true);
	assert.equal(moving?.render, true);
	assert.match(barRows()[0], /^\[ 1:MAIN \] +2:PR +3:GIT +4:PROF +5:MEM +6:TREE$/, "PR already in the second place, numbered by position");
	const raw = bar().render(60)[0];
	assert.ok(raw.includes(`${INVERSE}${role("accent")}`) && /2:PR/.test(plain(raw.slice(raw.indexOf(INVERSE)))), "the dragged tab is highlighted");
	assert.equal(readConfig()?.sidebar?.tabOrder, undefined, "nothing saved while dragging");
	assert.equal(release(to, 5)?.handled, true);
	assert.deepEqual(readConfig().sidebar.tabOrder, ["main", "pr", "git", "prof", "mem", "tree"]);
	assert.match(barRows()[0], /^\[ 1:MAIN \] +2:PR +3:GIT/, "MAIN still active, PR stays second");
	assert.ok(!bar().render(60)[0].includes(INVERSE), "no highlight after the drop");
	assert.equal(click(to)?.handled, true, "a click after a drag is swallowed");
	assert.match(barRows()[0], /^\[ 1:MAIN \]/, "the click did not switch tabs");
	assert.equal(side().entries.length, 3, "MAIN's content");
});

test("a press and release without moving still switches tabs and keeps the order; a jitter under 2 columns is a click", async () => {
	const { bar, barRows, tabX } = await wide();
	const { press, drag, release, click } = dragger(bar);
	const git = tabX("2:GIT");
	press(git);
	release(git);
	click(git);
	assert.match(barRows()[0], /^1:MAIN +\[ 2:GIT \] +3:PROF/);
	const prof = tabX("3:PROF");
	press(prof);
	assert.equal(drag(prof + 1)?.render, false, "a 1-column jitter does not start a drag");
	assert.ok(!bar().render(60)[0].includes(INVERSE));
	release(prof + 1); // Pi sends no click once the pointer moved
	assert.match(barRows()[0], /\[ 3:PROF \]/, "the release picks the pressed tab");
	assert.equal(readConfig()?.sidebar?.tabOrder, undefined, "order unchanged and not saved");
});

test("a drag past either end clamps to the first or last place; the active tab stays the same", async () => {
	const { bar, barRows, tabX, clickTab } = await wide();
	const { press, drag, release } = dragger(bar);
	clickTab("4:MEM");
	press(tabX("4:MEM"));
	drag(500);
	assert.match(barRows()[0], /^1:MAIN +2:GIT +3:PROF +4:TREE +5:PR +\[ 6:MEM \]$/);
	release(500);
	assert.deepEqual(readConfig().sidebar.tabOrder, ["main", "git", "prof", "tree", "pr", "mem"]);
	press(tabX("4:TREE"));
	drag(-40, -3);
	release(-40, -3);
	assert.deepEqual(readConfig().sidebar.tabOrder, ["tree", "main", "git", "prof", "pr", "mem"]);
	assert.match(barRows()[0], /^1:TREE +2:MAIN +3:GIT +4:PROF +5:PR +\[ 6:MEM \]$/, "MEM still active");
});

test("a press after a drag that never got its release starts afresh", async () => {
	const { bar, barRows, tabX } = await wide();
	const { press, drag, release } = dragger(bar);
	const prof = tabX("3:PROF");
	press(tabX("6:PR"));
	drag(tabX("2:GIT"));
	assert.match(barRows()[0], /2:PR/);
	assert.equal(press(prof)?.render, true, "the release was lost: the bar is redrawn"); // PROF's place in the saved order
	assert.match(barRows()[0], /^\[ 1:MAIN \] +2:GIT +3:PROF +4:MEM +5:TREE +6:PR$/, "the saved order back");
	release(prof);
	assert.match(barRows()[0], /\[ 3:PROF \]/);
	assert.equal(readConfig()?.sidebar?.tabOrder, undefined);
});

test("moveTabTo puts a tab at a place, clamped, and slotAt finds the nearest slot", () => {
	assert.deepEqual(moveTabTo(undefined, "pr", 1), ["main", "pr", "git", "prof", "mem", "tree"]);
	assert.deepEqual(moveTabTo(undefined, "main", 99), ["git", "prof", "mem", "tree", "pr", "main"]);
	assert.deepEqual(moveTabTo(undefined, "git", -5), ["git", "main", "prof", "mem", "tree", "pr"]);
	assert.deepEqual(moveTabTo(undefined, "nope", 0), DEFAULT_TAB_ORDER);
	const slots = [{ startX: 0, endX: 4 }, { startX: 10, endX: 14 }, { startX: 20, endX: 24 }];
	assert.equal(slotAt(slots, -9), 0);
	assert.equal(slotAt(slots, 8), 1);
	assert.equal(slotAt(slots, 18), 2);
	assert.equal(slotAt(slots, 99), 2);
});
