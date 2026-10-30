import assert from "node:assert/strict";
import { test } from "node:test";
import { load, painted, plain, role, theme, writeConfig } from "./helpers.mjs";

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const now = () => Math.floor(Date.now() / 1000);

// A fullscreen host whose layout root hands out the native tree until the extension swaps it.
function host(columns = 180) {
	const native = { type: "vstack", entries: [] };
	const root = { render: () => [], [NODE]: () => native };
	const tui = { terminal: { columns, rows: 40 }, mode: "fullscreen", layoutRoot: root, requestRender() {} };
	return { tui, root, native };
}

const spent = [{ type: "message", message: { role: "assistant", usage: { input: 1000, output: 200, cacheRead: 40000, cacheWrite: 2000, cost: { total: 1.75 } } } }];

async function wide({ statuses = {}, branch = "main", config = {}, columns, session = {} } = {}) {
	writeConfig(config);
	const loaded = await load({
		mode: "tui",
		thinking: "high",
		session: { cwd: "/srv/app", model: { id: "claude-opus-5-5", provider: "status-card-test", reasoning: true }, usage: { percent: 28, tokens: 56_000, contextWindow: 200_000 }, ...session },
	});
	const h = host(columns);
	const footerData = { getGitBranch: () => branch, getExtensionStatuses: () => new Map(Object.entries(statuses)), onBranchChange: () => () => {} };
	const footer = loaded.footer()(h.tui, theme, footerData);
	const side = () => h.root[NODE]().entries?.[1]?.component?.[NODE]?.();
	const raw = (width = 60) => side()?.entries[1].component.render(width) ?? []; // under the tab bar
	// The fixed cards, each as its rows without the outline.
	const cards = (width = 60) => {
		const out = [];
		for (const row of raw(width).map(plain)) {
			if (row.startsWith("┌")) out.push([]);
			else if (!row.startsWith("└")) out.at(-1).push(row.replace(/^│ | +│$/g, "").replace(/ +$/, ""));
		}
		return out;
	};
	return { ...loaded, ...h, footer, side, raw, cards };
}

const planHeaders = {
	"anthropic-ratelimit-unified-status": "allowed",
	"anthropic-ratelimit-unified-5h-utilization": "0.38",
	"anthropic-ratelimit-unified-5h-reset": String(now() + 7200),
	"anthropic-ratelimit-unified-7d-utilization": "0.31",
	"anthropic-ratelimit-unified-7d-reset": String(now() + 86400 * 3),
};

const SPIN = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1 job$/u;

test("the Status card keeps Project, Branch and the statuses; the context moves to a card of its own", async () => {
	const { cards } = await wide({ statuses: { "gentle:mode": "Perm: Yolo", engram: "mem · ok", "gentle-jobs": "⧗ 1 job" }, session: { entries: spent } });
	const [status, context] = cards();
	assert.equal(cards().length, 2, "Status, then Context");
	assert.deepEqual(status.slice(0, 2), ["Status", ""]);
	assert.match(status[2], /^Project {2,}app$/);
	assert.match(status[3], /^Branch {2,}\u{E725} main$/u);
	assert.match(status[4], /^Model {2,}claude-opus-5-5 · high$/);
	assert.equal(status[5], "");
	assert.equal(status[6], "Perm: Yolo", "Perm first");
	assert.equal(status[7], "mem · ok", "then by key, as in the status line");
	assert.match(status[8], SPIN, "with no Jobs card the count stays here, spinning");
	assert.equal(status.length, 9, "no ctx, tokens or cost rows");
	assert.deepEqual(context.slice(0, 2), ["Context", ""], "a title row like the other cards");
});

test("the Context card: tokens in use and the gauge, a bar across the card, tokens spent and the cost", async () => {
	const { cards, raw } = await wide({ session: { entries: spent } });
	const [, context] = cards();
	assert.match(context[2], /^56k \/ 200k tokens +\S 28%$/u, "ctx's numbers, the gauge and percent on the right");
	assert.equal([...context[2]].length, 55, "the inner width of the column's cards");
	assert.equal(context[3], `${"■".repeat(15)}${"□".repeat(40)}`, "28% of 55 cells");
	assert.match(context[4], /^R40k W2\.0k CH\d+\.\d% +cost \$1\.75$/, "the tokens setting decides the figures");
	assert.equal([...context[4]].length, 55);
	assert.equal(context.length, 5);
	const rows = raw();
	const bar = rows.find((row) => row.includes("■"));
	assert.ok(painted(bar, "accent", "■"), "the filled part in the gauge's color");
	assert.ok(painted(bar, "dim", "□"));
	assert.ok(rows.some((row) => painted(row, "muted", "cost")), "a muted label before the cost");
});

test("the bar warns like the gauge", async () => {
	const { raw } = await wide({ session: { usage: { percent: 85, tokens: 170_000, contextWindow: 200_000 } } });
	assert.ok(raw().some((row) => painted(row, "warning", "■")));
});

test("the plan windows stay out of the Context card: they live in the PROF tab", async () => {
	const { cards, emit } = await wide({ session: { model: { id: "claude-opus-5-5", provider: "claude-bridge", reasoning: true } } });
	await emit("after_provider_response", { status: 200, headers: planHeaders });
	const [status, context] = cards();
	assert.equal(status.length, 5, "nothing of the context left in Status");
	assert.ok(!context.some((row) => /claude 5h|week/.test(row)), "no plan row");
});

test("labels keep the status line's muted role and sections are split by blank rows only", async () => {
	const { raw, cards } = await wide({ statuses: { "gentle:mode": "Perm: Yolo" } });
	const rows = raw();
	assert.ok(rows.some((row) => painted(row, "muted", "Project")));
	assert.ok(rows.every((row) => !plain(row).includes("─") || /^[┌└]/.test(plain(row))), "no rule inside the cards");
	assert.deepEqual(cards()[0].map((row) => row === ""), [false, true, false, false, false, true, false]);
});

test("without statuses their section and its blank row are left out; long values are cut with … and never wrap", async () => {
	const { cards } = await wide({ branch: "feature/a-rather-long-branch-name-for-the-side-column-and-more" });
	const [status] = cards();
	assert.equal(status.length, 5);
	assert.match(status[3], /^Branch {2}\u{E725} feature\/a-rather-long-branch-name-for-the-si…$/u);
	assert.equal([...status[3]].length, 55);
});

test("an unknown context keeps its first row, without the bar; rows whose data is missing are left out", async () => {
	const { cards } = await wide({ session: { usage: undefined } });
	const [, context] = cards();
	assert.equal(context.length, 3, "title, blank, the tokens row");
	assert.match(context[2], /^\? tokens +\S \?%$/u, "the status line's unknown context");
});

test("the Status and Context cards are there even when nothing else is", async () => {
	const { side, cards } = await wide();
	assert.equal(side().entries.length, 2, "the tab bar and the fixed cards, no scrolling area under them");
	assert.deepEqual(cards().map((card) => card[0]), ["Status", "Context"]);
});

test("with the block outline off the cards go without it, like the other cards", async () => {
	const { raw } = await wide({ config: { blocks: { border: false } } });
	const out = raw().map(plain);
	assert.equal(out[0], " Status");
	assert.match(out[2], /^ Project {2,}app$/);
	assert.ok(out.includes(" Context"));
	assert.ok(out.every((row) => !/[┌│└]/.test(row)));
});

test("below the breakpoint the status line stays under the editor, as before", async () => {
	const { footer, root, native } = await wide({ columns: 120 });
	assert.equal(root[NODE](), native);
	assert.match(plain(footer.render(120)[0]), /^app · \u{E725} main +ctx/u);
});

test("with the side column the model moves into the Status card: no longer above the editor nor on the Working row", async () => {
	const loaded = await wide();
	assert.ok(loaded.cards()[0].some((row) => /^Model {2,}claude-opus-5-5 · high$/.test(row)));
	assert.deepEqual(loaded.widgets["gentle-quiet:model"]({ requestRender() {} }, theme).render(80), [], "no idle label above the editor");
	const { Loader } = await import("@earendil-works/pi-tui");
	const working = Object.assign(new Loader(undefined, (s) => s, (s) => s, "Working"), { kind: "working" });
	assert.doesNotMatch(plain(working.render(80)[1]), /claude-opus/, "nor at the end of the Working row");
});

test("below the breakpoint the model stays above the editor, as before", async () => {
	const loaded = await wide({ columns: 120 });
	assert.match(plain(loaded.widgets["gentle-quiet:model"]({ requestRender() {} }, theme).render(80)[0]), /claude-opus-5-5 · high $/);
});

test("Project and Model values take the branch name's text color; the labels stay muted", async () => {
	const { raw } = await wide();
	const rows = raw();
	const project = rows.find((row) => plain(row).includes("Project"));
	const model = rows.find((row) => plain(row).includes("Model"));
	assert.ok(painted(project, "muted", "Project") && painted(project, "text", "app"), "project value in text");
	assert.ok(painted(model, "muted", "Model") && painted(model, "text", "claude-opus-5-5 · high"), "model value in text");
});

test("labelled rows: the label at the start, the value flush with the card's end", async () => {
	const { cards } = await wide();
	const [status] = cards();
	for (const row of status.filter((r) => /^(Project|Branch|Model) /.test(r))) assert.equal([...row].length, 55, row);
	assert.match(status.find((r) => r.startsWith("Project")), /^Project {2,}app$/);
	assert.match(status.find((r) => r.startsWith("Model")), /^Model {2,}claude-opus-5-5 · high$/);
});
