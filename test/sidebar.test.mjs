import assert from "node:assert/strict";
import { test } from "node:test";
import { ScrollView } from "@earendil-works/pi-tui";
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
	return { ...loaded, ...h, footer, todo, agents, layout, bar, body, rail, rows: (width = 60) => rail?.render(width).map(plain) };
}

test("wide fullscreen terminals put the status bar on top of the conversation and a side column", async () => {
	const { layout, body, native } = await wide();
	assert.equal(layout.type, "vstack");
	assert.equal(layout.entries[0].basis, "auto", "the bar is as tall as its rows");
	assert.equal(body.type, "hstack");
	assert.equal(body.entries[0].component[NODE](), native, "the conversation keeps Pi's own layout");
	assert.equal(body.entries[1].basis, 60, "fixed column width");
	assert.equal((await wide({ columns: 300 })).body.entries[1].basis, 60, "whatever the terminal width");
});

test("the status line is the original bar, full width, set off by a blank row above and a rule below", async () => {
	const { bar } = await wide({ columns: 180 });
	const out = bar.render(180).map(plain);
	assert.equal(out.length, 3);
	assert.equal(out[0], "", "keeps the bar off what the terminal draws above Pi");
	assert.match(out[1], /^ app · main +ctx .* 28%/);
	assert.doesNotMatch(out[1], /claude-opus-5-5/, "the model closes the Working row instead");
	assert.ok([...out[1]].length <= 180 && [...out[1]].length >= 179, "spans the terminal");
	assert.equal(out[2], "─".repeat(180));
});

test("the column stacks Agents and Todos in the square outline, a blank row under each title", async () => {
	const { rows } = await wide();
	const out = rows();
	const tops = out.flatMap((row, i) => (row.startsWith("┌") ? [i] : []));
	assert.equal(tops.length, 2);
	assert.match(out[tops[0] + 1], /^│ ◈ Agents {2}1 active/, "Agents first");
	assert.deepEqual(out.slice(tops[1] + 1, tops[1] + 4).map((row) => row.replace(/ +│$/, "")), ["│ ≡ Todos  1 of 2", "│", "│ ◔ Write it"], "a blank row under the title");
	assert.equal(out[tops[1] + 4].replace(/ +│$/, ""), "│ ○ Test it", "items stay tight");
	assert.ok(out[tops[1] - 1].startsWith("└"), "no blank row between the cards");
	assert.ok(out.every((row) => [...row].length <= 59), "rows fit the column minus its scrollbar");
});

test("the Todos card draws the task in progress with ◔, a glyph JetBrains Mono has, keeping its color", async () => {
	const loaded = await wide();
	loaded.ui.setWidget("gentle-todo", () => ({ render: panel("Todos  1 of 3", "\x1b[33m◐\x1b[39m Write it", "○ Test it", "✓ Plan it") }));
	loaded.widgets["gentle-todo"](loaded.tui, theme);
	loaded.root[NODE]();
	const raw = loaded.rail.render(60);
	const out = raw.map(plain);
	assert.ok(out.some((row) => row.startsWith("│ ◔ Write it")), "in progress");
	assert.ok(out.some((row) => row.startsWith("│ ○ Test it")), "pending keeps its glyph");
	assert.ok(out.some((row) => row.startsWith("│ ✓ Plan it")), "done keeps its glyph");
	assert.ok(raw.some((row) => row.includes("\x1b[33m◔\x1b[39m")), "the icon keeps gentle-pi's color");
	assert.ok(raw.every((row) => !row.includes("◐")), "no ◐ left for the terminal to borrow from a fallback font");
});

test("the Agents card draws a running agent with ◔ too, keeping its color and leaving ◐ inside a name alone", async () => {
	const loaded = await wide();
	loaded.ui.setWidget("gentle-agents", () => ({ render: panel("Agents  1 active", "\x1b[34m◐\x1b[39m gentle-ai-worker  map ◐ glyphs", "✓ gentle-ai-explore") }));
	loaded.widgets["gentle-agents"](loaded.tui, theme);
	loaded.root[NODE]();
	const raw = loaded.rail.render(60);
	const out = raw.map(plain);
	assert.ok(out.some((row) => row.startsWith("│ ◔ gentle-ai-worker  map ◐ glyphs")), "running");
	assert.ok(out.some((row) => row.startsWith("│ ✓ gentle-ai-explore")), "done keeps its glyph");
	assert.ok(raw.some((row) => row.includes("\x1b[34m◔\x1b[39m")), "the icon keeps gentle-pi's color");
});

test("the Agents batch clock stays on the title row, right-aligned", async () => {
	const loaded = await wide();
	const left = "❀ Agents  1 active · 1 done";
	const card = (width) => [`   ${left}${" ".repeat(width - 5 - left.length - 6)}16m53s`, "", "   ◐ gentle-ai-worker"];
	loaded.ui.setWidget("gentle-agents", () => ({ render: card }));
	loaded.widgets["gentle-agents"](loaded.tui, theme);
	loaded.root[NODE]();
	const out = loaded.rows();
	const top = out.findIndex((row) => row.startsWith("┌"));
	assert.match(out[top + 1], /^│ ◈ Agents {2}1 active · 1 done +16m53s +│$/);
	assert.equal(out.filter((row) => row.includes("16m53s")).length, 1);
});

test("a long Todos task wraps with its text lined up under the task's own text", async () => {
	const loaded = await wide();
	const long = "T8b1 Home parity part 1: nav/hero/price/integration/panel worker running and then some more words to wrap";
	loaded.ui.setWidget("gentle-todo", () => ({ render: (width) => ["   ❀ Todos  1 of 2".padEnd(width), `   ◐ ${long}`.padEnd(width), "   ○ Short one".padEnd(width), "   ↑↓ 1-10/13 · ctrl+shift+↑/↓".padEnd(width)] }));
	loaded.widgets["gentle-todo"](loaded.tui, theme);
	loaded.root[NODE]();
	const out = loaded.rows().map((row) => row.replace(/^│ | +│$/g, ""));
	const first = out.findIndex((row) => row.startsWith("◔ T8b1"));
	assert.ok(first > 0);
	assert.match(out[first + 1], /^ {2}\S/, "continuation hangs under the text, past the icon");
	assert.ok(out.some((row) => row === "○ Short one"), "other tasks are untouched");
	assert.ok(!out.some((row) => row.includes("↑↓")), "the scroll indicator row is dropped");
	assert.ok(loaded.rows().every((row) => [...row].length <= 59));
});

test("in the column the Todos rows keep one column of padding even when a row of the card sits further left", async () => {
	const loaded = await wide();
	const bg = (row) => `\x1b[48;5;236m${row}\x1b[49m`;
	// gentle-pi's float card: margin, accent bar, a space, then the row; one row painted without the indent.
	const long = "T1 Content backend: schema, Action Scheduler, Access, courses API, attachments";
	const card = (width) => [
		` ${bg("▎ ❀ Todos  1 of 2".padEnd(width - 2))} `,
		` ${bg(`▎ ◐ ${long}`.padEnd(width - 2))} `,
		` ${bg("▎ running".padEnd(width - 2))} `,
		` ${bg("▎ ○ Short one".padEnd(width - 2))} `,
		bg("↑↓ 1–10/13 · ctrl+shift+↑/↓".padEnd(width)),
	];
	loaded.ui.setWidget("gentle-todo", () => ({ render: card }));
	loaded.widgets["gentle-todo"](loaded.tui, theme);
	loaded.root[NODE]();
	const out = loaded.rows().map((row) => row.replace(/ +│$/, ""));
	const top = out.findIndex((row) => row.includes("Todos")) - 1;
	assert.equal(out[top + 1], "│ ≡ Todos  1 of 2");
	assert.match(out[top + 3], /^│ ◔ T1 Content backend/);
	assert.match(out[top + 4], /^│ {3}\S/, "the long task wraps under its text");
	assert.ok(out.some((row) => row === "│ ○ Short one"));
});

test("a task title with line breaks hangs every line under the task's text and wraps what is too long", async () => {
	const loaded = await wide();
	const rows = [
		"   ❀ Todos  0 of 3",
		"   ◐ Revisar a configuração completa do pipeline de integração contínua e confirmar que todas as etapas de build,",
		"   lint e testes são executadas na ordem correta · comparar com o ambiente de produção e documentar as diferenças",
		"   ○ Escrever testes",
		"   valores muito longos e caracteres especiais",
	];
	loaded.ui.setWidget("gentle-todo", () => ({ render: (width) => rows.map((row) => row.padEnd(width)) }));
	loaded.widgets["gentle-todo"](loaded.tui, theme);
	loaded.root[NODE]();
	const out = loaded.rows().map((row) => row.replace(/^│ | +│$/g, ""));
	const first = out.findIndex((row) => row.startsWith("◔ Revisar"));
	const second = out.findIndex((row) => row.startsWith("○ Escrever"));
	assert.ok(first > 0 && second > first);
	assert.ok(out.slice(first + 1, second).every((row) => /^ {2}\S/.test(row)), "every continuation hangs under the text");
	assert.ok(out.slice(first + 1, second).length >= 3, "the long line wraps instead of being cut");
	assert.ok(!out.some((row) => row.includes("…")), "nothing is truncated");
	const task = out.slice(second, second + 2).map((row, i) => (i === 0 ? row.slice(2) : row.trim())).join(" ");
	assert.equal(task, "Escrever testes valores muito longos e caracteres especiais", "the continuation flows into the task's text");
	assert.ok(loaded.rows().every((row) => [...row].length <= 59));
});

test("a title gentle-pi already split is joined back and flows to the box width, with its strike closed on every line", async () => {
	const loaded = await wide();
	const title = "Escrever testes para casos de borda, entradas inválidas e mensagens de erro exatas · Usando dados isolados para não alterar o banco real durante a execução da suíte";
	const cut = title.indexOf(" não alterar");
	const done = "Revisar o módulo de autenticação, cobrindo login, renovação de tokens e sessões expiradas";
	const rows = ["   ❀ Todos  1 of 2", `   ○ ${title.slice(0, cut)}`, `   ${title.slice(cut + 1)}`, `   ✓ \x1b[9m${done}\x1b[29m`];
	loaded.ui.setWidget("gentle-todo", () => ({ render: (width) => rows.map((row) => row.padEnd(width)) }));
	loaded.widgets["gentle-todo"](loaded.tui, theme);
	loaded.root[NODE]();
	const out = loaded.rows().map((row) => row.replace(/^│ | +│$/g, ""));
	const first = out.findIndex((row) => row.startsWith("○ Escrever"));
	const last = out.findIndex((row) => row.startsWith("✓ "));
	const lines = out.slice(first, last);
	assert.equal(lines.map((row, i) => (i === 0 ? row.slice(2) : row.trim())).join(" "), title, "the text is whole, in order");
	assert.ok(lines.slice(0, -1).every((row) => [...row].length >= 45), "a line is filled before the text moves down");
	assert.ok(lines.slice(1).every((row) => /^ {2}\S/.test(row)), "continuations hang under the text");
	const raw = loaded.rail.render(60).filter((row) => row.includes("\x1b[9m"));
	assert.ok(raw.length >= 1);
	assert.ok(raw.every((row) => row.lastIndexOf("\x1b[29m") > row.lastIndexOf("\x1b[9m")), "the strike never runs into the border");
});

// gentle-pi's Todos card: its own ScrollView keeps the list to a few rows and adds the scroll indicator,
// written with an en dash ("1–3/12") like gentle-pi does.
const TASKS = Array.from({ length: 12 }, (_, i) => `○ T${i + 1} task`);
function scrollingTodo() {
	const scroll = new ScrollView({ render: () => TASKS, invalidate() {} });
	return {
		render(width) {
			scroll.updateLayout(TASKS.length, 3);
			const visible = TASKS.slice(scroll.scrollTop, scroll.scrollTop + scroll.viewportHeight);
			return ["❀ Todos  0 of 12", ...visible, `↑↓ 1–3/${TASKS.length} · ctrl+shift+↑/↓`].map((row) => `   ${row}`.padEnd(width));
		},
	};
}

test("the Todos card in the column grows with its list instead of scrolling inside", async () => {
	const loaded = await wide();
	loaded.ui.setWidget("gentle-todo", () => scrollingTodo());
	loaded.widgets["gentle-todo"](loaded.tui, theme);
	loaded.root[NODE]();
	const out = loaded.rows().map((row) => row.replace(/^│ | +│$/g, ""));
	assert.deepEqual(out.filter((row) => /^○ T\d+/.test(row)), TASKS);
	assert.ok(!out.some((row) => row.includes("↑↓")), "no scroll indicator row");
});

test("below the breakpoint the Todos card keeps scrolling inside", async () => {
	const loaded = await wide({ columns: 139 });
	loaded.ui.setWidget("gentle-todo", () => scrollingTodo());
	const todo = loaded.widgets["gentle-todo"](loaded.tui, theme);
	const out = todo.render(60).map(plain);
	assert.equal(out.filter((row) => /○ T\d+/.test(row)).length, 3);
});

test("Todos and Agents leave their usual places while the column is open", async () => {
	const { todo, agents } = await wide();
	assert.deepEqual(todo.render(100), []);
	assert.deepEqual(agents.render(100), []);
});

test("the footer draws no row under the editor while the column is open", async () => {
	const { footer } = await wide();
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

test("an agent's label and model are not cut off in the column: the details go on their own row", async () => {
	const loaded = await wide();
	const left = "◐ gentle-ai-worker  Phase 2 home page (resume)";
	const right = "claude-sonnet-5-5 · high · 3.7M · 7m43s";
	// gentle-pi lays the row out for the width it is given: details right-aligned when they fit.
	const card = (width) => ["   ❀ Agents  1 active".padEnd(width), `   ${left}${" ".repeat(Math.max(3, width - 5 - left.length - right.length))}${right}`];
	loaded.ui.setWidget("gentle-agents", () => ({ render: card }));
	loaded.widgets["gentle-agents"](loaded.tui, theme);
	loaded.root[NODE](); // the next layout pass reads the new card
	const out = loaded.rows().map((row) => row.replace(/ +│$/, ""));
	const top = out.findIndex((row) => row.startsWith("┌"));
	assert.deepEqual(out.slice(top + 1, top + 6), ["│ ◈ Agents  1 active", "│", `│ ${left.replace("◐", "◔")}`, `│   ${right}`, out[top + 5]]);
	assert.ok(out[top + 5].startsWith("└"));
	assert.ok(loaded.rows().every((row) => [...row].length <= 59));
});

// A Todos card like gentle-pi's: only a click on its title row toggles it; the title is row `titleRow` of the card.
async function clickable(titleRow) {
	const loaded = await wide();
	const seen = [];
	loaded.ui.setWidget("gentle-todo", () => ({
		render: panel("Todos  1 of 2", "◐ Write it", "○ Test it"),
		handleMouse(event) {
			seen.push(event);
			return event.type === "wheel" || event.y === titleRow ? { handled: true, render: true } : undefined;
		},
	}));
	loaded.widgets["gentle-todo"](loaded.tui, theme);
	loaded.root[NODE]();
	const column = loaded.rail;
	// Agents card: rows 0-4; Todos card from row 5, its title on row 6.
	const mouse = (type, y, extra = {}) => column.handleMouse({ type, button: "left", x: 10, y, width: 60, height: 30, screenX: 100, screenY: y, ...extra });
	return { seen, mouse };
}

test("clicking the Todos title in the column toggles it, whatever row the card counts its title on", async () => {
	for (const titleRow of [0, 1]) {
		const { seen, mouse } = await clickable(titleRow);
		assert.equal(mouse("click", 6)?.handled, true, `title row ${titleRow}`);
		assert.equal(seen.filter((event) => event.type === "click" && event.y === titleRow).length, 1);
	}
});

test("clicks elsewhere in the column are not sent to the cards", async () => {
	const { seen, mouse } = await clickable(0);
	assert.equal(mouse("click", 8)?.handled, undefined, "on an item");
	assert.equal(mouse("click", 2)?.handled, undefined, "on the Agents card");
	assert.equal(mouse("click", 20)?.handled, undefined, "below the cards");
	assert.deepEqual(seen, []);
});

test("the wheel over the Todos card reaches it", async () => {
	const { seen, mouse } = await clickable(0);
	assert.equal(mouse("wheel", 8, { wheelDelta: 3 })?.handled, true);
	assert.equal(seen[0].type, "wheel");
	assert.equal(seen[0].wheelDelta, 3);
});

test("an agent's details line up under its name, however far the name sits from the icon", async () => {
	for (const icon of ["◐ ", "◐  "]) {
		const loaded = await wide();
		const left = `${icon}gentle-ai-verify  Verify Phase 2 home`;
		const right = "claude-opus-5-5 · high · 26k · 15s";
		loaded.ui.setWidget("gentle-agents", () => ({ render: (width) => ["   ❀ Agents  1 active", `   ${left}${" ".repeat(Math.max(3, width - 5 - left.length - right.length))}${right}`] }));
		loaded.widgets["gentle-agents"](loaded.tui, theme);
		loaded.root[NODE]();
		const out = loaded.rows();
		const name = out.find((row) => row.includes("gentle-ai-verify"));
		const details = out[out.indexOf(name) + 1];
		assert.equal(details.indexOf("claude-opus-5-5"), name.indexOf("gentle-ai-verify"), JSON.stringify(icon));
	}
});
