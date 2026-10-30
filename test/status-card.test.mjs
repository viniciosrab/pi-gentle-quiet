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
	const raw = (width = 60) => side()?.entries[0].component.render(width) ?? [];
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
	assert.deepEqual(status.slice(0, 5), ["Status", "", "Project  app", "Branch   \u{E725} main", ""]);
	assert.equal(status[5], "Perm: Yolo", "Perm first");
	assert.equal(status[6], "mem · ok", "then by key, as in the status line");
	assert.match(status[7], SPIN, "with no Jobs card the count stays here, spinning");
	assert.equal(status.length, 8, "no ctx, tokens or cost rows");
	assert.ok(!status.some((row) => row.includes("claude-opus-5-5")), "no model: it closes the Working row");
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

test("the plan windows close the Context card on one row, as the status line draws them", async () => {
	const { cards, raw, emit } = await wide({ session: { model: { id: "claude-opus-5-5", provider: "claude-bridge", reasoning: true } } });
	await emit("after_provider_response", { status: 200, headers: planHeaders });
	const [status, context] = cards();
	assert.equal(status.length, 4, "nothing of the context left in Status");
	assert.match(context.at(-1), /^claude 5h \S 38% · week \S 31%$/u);
	const plan = raw().find((row) => plain(row).includes("claude 5h"));
	assert.ok(painted(plan, "muted", "claude 5h") && painted(plan, "muted", "week"), "window labels muted");
	assert.ok(painted(plan, "dim", " · "), "joined with a dim dot");
});

test("labels keep the status line's muted role and sections are split by blank rows only", async () => {
	const { raw, cards } = await wide({ statuses: { "gentle:mode": "Perm: Yolo" } });
	const rows = raw();
	assert.ok(rows.some((row) => painted(row, "muted", "Project")));
	assert.ok(rows.every((row) => !plain(row).includes("─") || /^[┌└]/.test(plain(row))), "no rule inside the cards");
	assert.deepEqual(cards()[0].map((row) => row === ""), [false, true, false, false, true, false]);
});

test("without statuses their section and its blank row are left out; long values are cut with … and never wrap", async () => {
	const { cards } = await wide({ branch: "feature/a-rather-long-branch-name-for-the-side-column-and-more" });
	const [status] = cards();
	assert.equal(status.length, 4);
	assert.match(status[3], /^Branch {3}\u{E725} feature\/a-rather-long-branch-name-for-the-s…$/u);
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
	assert.equal(side().entries.length, 1, "fixed, no scrolling area under them");
	assert.deepEqual(cards().map((card) => card[0]), ["Status", "Context"]);
});

test("with the block outline off the cards go without it, like the other cards", async () => {
	const { raw } = await wide({ config: { blocks: { border: false } } });
	const out = raw().map(plain);
	assert.equal(out[0], " Status");
	assert.equal(out[2], " Project  app");
	assert.ok(out.includes(" Context"));
	assert.ok(out.every((row) => !/[┌│└]/.test(row)));
});

test("below the breakpoint the status line stays under the editor, as before", async () => {
	const { footer, root, native } = await wide({ columns: 120 });
	assert.equal(root[NODE](), native);
	assert.match(plain(footer.render(120)[0]), /^app · \u{E725} main +ctx/u);
});
