import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Loader } from "@earendil-works/pi-tui";
import { load, painted, picker, plain, readConfig, theme, writeConfig } from "./helpers.mjs";

// A real git repo with one committed file, then one edited file and one new file.
function repo() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gentle-quiet-repo-"));
	const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	writeFileSync(path.join(dir, "a.txt"), "1\n2\n3\n");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	writeFileSync(path.join(dir, "a.txt"), "1\nTWO\n3\n4\n");
	writeFileSync(path.join(dir, "b.txt"), "new\n");
	return dir;
}

const session = (overrides = {}) => ({
	model: { id: "claude-opus-5-5", reasoning: true },
	usage: { percent: 28 },
	// Totals: ↑1.2k ↓300 R50k W2.0k; cache hit of the latest response 10000/10200 = 98.0%.
	entries: [
		{ type: "message", message: { role: "assistant", usage: { input: 1000, output: 200, cacheRead: 40000, cacheWrite: 2000, cost: { total: 1.5 } } } },
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "assistant", usage: { input: 200, output: 100, cacheRead: 10000, cacheWrite: 0, cost: { total: 0.25 } } } },
	],
	subscription: true,
	...overrides,
});

// Pi's footer data: git branch, extension statuses, branch-change subscription.
const footerData = (statuses = { "gentle:mode": "Perm: Normal", "gentle-jobs": "⧗ 1 job" }) => ({
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map(Object.entries(statuses)),
	onBranchChange: () => () => {},
});

async function footer(options = {}) {
	writeConfig(options.config ?? {});
	const loaded = await load({ mode: "tui", session: session(options.session), ...options.load });
	const factory = loaded.footer();
	let renders = 0;
	const tui = { requestRender: () => renders++ };
	const component = factory ? factory(tui, theme, footerData(options.statuses)) : undefined;
	return { ...loaded, component, renders: () => renders };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

test("replaces Pi's footer: Perm right after the location, counters on the right", async () => {
	const { component } = await footer({ session: { cwd: "/srv/app" } });
	assert.ok(component, "footer installed");
	const rows = component.render(170).map(plain);
	assert.equal(rows.length, 1, "statuses share the line when they fit");
	assert.match(rows[0], /^app · \u{E725} main · Perm: Normal · [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1 job +R50k W2\.0k CH98\.0% · ctx \u{F0A9F} 28% · \$1\.75 sub $/u);
});

test("the model and its effort are not on the status line", async () => {
	const { component } = await footer({ session: { cwd: "/srv/app" } });
	for (const width of [200, 170, 120, 80, 50]) {
		const rows = component.render(width).map(plain).join("\n");
		assert.doesNotMatch(rows, /claude-opus-5-5|medium/, `at ${width} columns`);
	}
});

// Pi's working row: a WorkingStatusIndicator, a Loader of kind "working".
const loader = (kind, message = "Working") => Object.assign(new Loader(undefined, (s) => s, (s) => s, message), { kind });

test("the model and its effort close the Working row, right-aligned and dim", async () => {
	await footer({ session: { cwd: "/srv/app" } });
	const row = loader("working").render(80)[1];
	assert.match(plain(row), /^ ⠋ Working +claude-opus-5-5 · medium $/);
	assert.equal([...plain(row)].length, 80);
	assert.ok(painted(row, "dim", "claude-opus-5-5 · medium"));
});

test("a model without reasoning closes the Working row with its name alone", async () => {
	await footer({ session: { model: { id: "gpt-x", reasoning: false } } });
	assert.match(plain(loader("working").render(60)[1]), /^ ⠋ Working +gpt-x $/);
});

test("other loaders, a too narrow row and a disabled status line keep Pi's row", async () => {
	await footer({ session: { cwd: "/srv/app" } });
	assert.equal(loader("compaction", "Compacting").render(80)[1], ` ⠋ Compacting${" ".repeat(67)}`);
	assert.equal(loader("working").render(30)[1], ` ⠋ Working${" ".repeat(20)}`);
	await footer({ config: { statusLine: { enabled: false } } });
	assert.equal(loader("working").render(80)[1], ` ⠋ Working${" ".repeat(70)}`);
});

// While idle the model stays on the Working row's screen row: a widget above the editor.
const modelWidget = (loaded) => {
	let renders = 0;
	const factory = loaded.widgets["gentle-quiet:model"];
	const component = typeof factory === "function" ? factory({ requestRender: () => renders++ }, theme) : undefined;
	return { component, renders: () => renders };
};

test("while idle the model stays where the Working row ends, right-aligned and dim", async () => {
	const loaded = await footer({ session: { cwd: "/srv/app" } });
	const { component } = modelWidget(loaded);
	assert.ok(component, "model widget installed");
	const rows = component.render(80);
	assert.equal(rows.length, 2);
	assert.equal(rows[1], "");
	assert.match(plain(rows[0]), /^ +claude-opus-5-5 · medium $/);
	assert.equal([...plain(rows[0])].length, 80);
	assert.ok(painted(rows[0], "dim", "claude-opus-5-5 · medium"));
	const working = plain(loader("working").render(80)[1]);
	assert.equal(plain(rows[0]).lastIndexOf("medium"), working.lastIndexOf("medium"), "same column as on the Working row");
});

test("while Pi works or compacts the model widget steps aside for the Working row", async () => {
	const loaded = await footer({ session: { cwd: "/srv/app" } });
	const { component, renders } = modelWidget(loaded);
	await loaded.emit("agent_start");
	assert.deepEqual(component.render(80), []);
	assert.ok(renders() > 0, "asks for a redraw");
	await loaded.emit("agent_end");
	assert.match(plain(component.render(80)[0]), /claude-opus-5-5 · medium $/);
	await loaded.emit("session_before_compact");
	assert.deepEqual(component.render(80), []);
	await loaded.emit("session_compact");
	assert.equal(component.render(80).length, 2);
	await loaded.emit("session_before_compact");
	await loaded.emit("session_compact_failed");
	assert.equal(component.render(80).length, 2);
	// A compaction mid-run ends while the run goes on: the Working row is still there.
	await loaded.emit("agent_start");
	await loaded.emit("session_before_compact");
	await loaded.emit("session_compact");
	assert.deepEqual(component.render(80), []);
	await loaded.emit("agent_end");
	// A new session starts idle even if the last one ended mid-run.
	await loaded.emit("agent_start");
	await loaded.emit("session_start");
	assert.equal(component.render(80).length, 2);
});

test("the model widget follows model and thinking changes", async () => {
	const loaded = await footer({ session: { cwd: "/srv/app" } });
	const { component, renders } = modelWidget(loaded);
	loaded.ctx.model = { id: "gpt-x", reasoning: false };
	await loaded.emit("model_select");
	assert.match(plain(component.render(80)[0]), /^ +gpt-x $/);
	const before = renders();
	await loaded.emit("thinking_level_select");
	assert.ok(renders() > before, "asks for a redraw");
});

test("a disabled status line or a too narrow row leave no model widget", async () => {
	const loaded = await footer({ session: { cwd: "/srv/app" } });
	assert.deepEqual(modelWidget(loaded).component.render(20), []);
	const off = await footer({ config: { statusLine: { enabled: false } } });
	const { component } = modelWidget(off);
	assert.ok(!component || component.render(80).length === 0);
});

test("on narrow terminals the counters give way before Perm leaves the first line", async () => {
	const { component } = await footer({ session: { cwd: "/srv/app" } });
	const at = (width) => component.render(width).map(plain);
	assert.equal(at(66).length, 1);
	assert.match(at(66)[0], /^app · \u{E725} main · Perm: Normal · [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1 job +ctx .* \$1\.75 sub $/u);
	const narrow = at(51);
	assert.equal(narrow.length, 2, "statuses move to a second row only when the first line cannot hold them");
	assert.match(narrow[1], /^Perm: Normal  [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1 job$/);
});

test("the jobs spinner turns while a job runs, and the footer redraws on its own", async () => {
	const { component, renders } = await footer({ session: { cwd: "/srv/app" } });
	const frame = () => /([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) 1 job/.exec(plain(component.render(170)[0]))?.[1];
	const frames = new Set([frame()]);
	const before = renders();
	await new Promise((resolve) => setTimeout(resolve, 350));
	assert.ok(renders() > before, "the footer asks for redraws while the job runs");
	for (let i = 0; i < 8; i++) {
		await new Promise((resolve) => setTimeout(resolve, 130));
		frames.add(frame());
	}
	assert.ok(!frames.has(undefined), "every render draws a spinner frame");
	assert.ok(frames.size > 1, "the spinner frame changes over time");
	component.dispose();

	const idle = await footer({ session: { cwd: "/srv/app" }, statuses: {} });
	const idleBefore = idle.renders();
	await new Promise((resolve) => setTimeout(resolve, 350));
	assert.ok(idle.renders() - idleBefore <= 1, "no jobs, no redraw loop");
	idle.component.dispose();
});

test("the status line names only the working folder, under ~/ inside home, then a dot before the branch", async () => {
	const at = async (cwd) => plain((await footer({ session: { cwd }, statuses: {} })).component.render(170)[0]);
	assert.match(await at(path.join(os.homedir(), ".herdr/worktrees/membero/worktree-quiet-field-5095")), /^~\/worktree-quiet-field-5095 · \u{E725} main +/u);
	assert.match(await at("/srv/app/"), /^app · \u{E725} main +/u);
	assert.match(await at(os.homedir()), /^~ · \u{E725} main +/u);
	assert.match(await at("/"), /^\/ · \u{E725} main +/u);
});

test("token counters come from every usage Pi records, like Pi's footer", async () => {
	const entries = [
		{ type: "message", message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } },
		{ type: "message", message: { role: "toolResult", usage: { input: 900, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.2 } } } },
		{ type: "usage", usage: { input: 0, output: 950, cacheRead: 0, cacheWrite: 0, cost: { total: 0.3 } } },
	];
	const line = plain((await footer({ session: { entries }, statuses: {}, config: { statusLine: { tokens: "all" } } })).component.render(160)[0]);
	assert.match(line, / ↑1\.0k ↓1\.0k · ctx /, "no cache counters when there was no caching");
	assert.match(line, /\$0\.600 sub $/);
});

test("shows the working tree changes from git: files and added/removed lines", async () => {
	const dir = repo();
	const { component } = await footer({ session: { cwd: dir } });
	await settle();
	const line = component.render(200)[0];
	assert.match(plain(line), / main ±2 \+3 -1 · /);
	assert.ok(painted(line, "warning", "±2"));
	assert.ok(painted(line, "toolDiffAdded", "+3"));
	assert.ok(painted(line, "toolDiffRemoved", "-1"));
});

test("files changed by another process (a subagent) show up without any event in this one", async () => {
	const dir = repo();
	const { component, renders } = await footer({ session: { cwd: dir } });
	await settle();
	assert.match(plain(component.render(200)[0]), / main ±2 \+3 -1 · /);
	const before = renders();
	writeFileSync(path.join(dir, "c.txt"), "x\ny\n");
	await new Promise((resolve) => setTimeout(resolve, 2600));
	assert.match(plain(component.render(200)[0]), / main ±3 \+5 -1 · /);
	assert.ok(renders() > before, "the footer is redrawn when the counts change");
});

test("the context gauge turns warning at 80% and error at 95%", async () => {
	const warn = (await footer({ session: { usage: { percent: 85 } } })).component.render(120)[0];
	assert.ok(painted(warn, "warning", "\u{F0AA4}"));
	const full = (await footer({ session: { usage: { percent: 97 } } })).component.render(120)[0];
	assert.ok(painted(full, "error", "\u{F0AA5}"));
});

test("the context gauge is one ring that fills in eighths: empty at 0%, full at 100%", async () => {
	const at = async (percent) => (await footer({ session: { usage: { percent } }, statuses: {} })).component.render(160)[0];
	const empty = await at(0);
	assert.match(plain(empty), /ctx \u{F0766} 0%/u);
	assert.ok(painted(empty, "border", "\u{F0766}"));
	assert.match(plain(await at(50)), /ctx \u{F0AA1} 50%/u);
	const full = await at(100);
	assert.match(plain(full), /ctx \u{F0AA5} 100%/u);
	assert.ok(painted(full, "error", "\u{F0AA5}"));
});

test("API-key models show plain cost", async () => {
	const line = plain((await footer({ session: { subscription: false, model: { id: "gpt-x", reasoning: false } }, statuses: {}, config: { statusLine: { tokens: "all" } } })).component.render(160)[0]);
	assert.match(line, / main +↑1\.2k .* ctx .* \$1\.75 $/);
});

test("narrow terminals drop details before the context and cost", async () => {
	const { component } = await footer({ session: { cwd: "/srv/a-long-project-name" } });
	const line = plain(component.render(46)[0]);
	assert.ok([...line].length <= 46);
	assert.match(line, /ctx .* 28%/);
});

test("Status line options: changes and cost can be hidden", async () => {
	const dir = repo();
	const { component } = await footer({ session: { cwd: dir }, config: { statusLine: { changes: false, cost: false } } });
	await settle();
	const line = plain(component.render(200)[0]);
	assert.doesNotMatch(line, /±|\$/);
	assert.match(line, / main · Perm: Normal/);
});

test("Status line: pi restores Pi's own footer right away and is saved", async () => {
	const { select } = picker(/^Status line ›$/, /^Status line: gentle/);
	const { commands, ctx, footer: current } = await footer({ load: { select } });
	assert.ok(current(), "installed");
	await commands["gentle-quiet"].handler("", ctx);
	assert.equal(current(), undefined, "Pi's default footer is back");
	assert.equal(readConfig().statusLine.enabled, false);
});

test("with the status line off, the footer is left to Pi", async () => {
	const { footer: current } = await footer({ config: { statusLine: { enabled: false } } });
	assert.equal(current(), undefined);
});

test("narrow terminals drop the cache details, then the tokens, before context and cost", async () => {
	const { component } = await footer({ session: { cwd: "/srv/app" }, statuses: {}, config: { statusLine: { tokens: "all" } } });
	const at = (width) => plain(component.render(width)[0]);
	assert.match(at(71), /↑1\.2k ↓300 R50k W2\.0k CH98\.0% · ctx/);
	assert.match(at(61), /main +↑1\.2k ↓300 · ctx/, "cache goes first, the location stays");
	assert.doesNotMatch(at(61), /R50k/);
	assert.doesNotMatch(at(41), /↑/);
	assert.match(at(41), /main +ctx .* \$1\.75 sub $/);
});

test("Status line tokens can be turned off", async () => {
	const line = plain((await footer({ config: { statusLine: { tokens: false } }, statuses: {} })).component.render(160)[0]);
	assert.doesNotMatch(line, /↑|↓|CH/);
	assert.match(line, /ctx \u{F0A9F}/u);
});

test("by default the counters show only the cache: R, W and the hit rate", async () => {
	const line = plain((await footer({ statuses: {} })).component.render(160)[0]);
	assert.match(line, / R50k W2\.0k CH98\.0% · ctx /);
	assert.doesNotMatch(line, /↑|↓/);
});

test("in cache mode a narrow terminal keeps the hit rate after R and W go", async () => {
	const { component } = await footer({ session: { cwd: "/srv/app" }, statuses: {} });
	assert.match(plain(component.render(49)[0]), /main +CH98\.0% · ctx/);
	assert.doesNotMatch(plain(component.render(49)[0]), /R50k/);
});

test("Status line tokens cycles cache → all → off and is saved", async () => {
	const { select, seen } = picker(/^Status line ›$/, /^Status line tokens/, /^Status line tokens/, /^Status line tokens/);
	const { commands, ctx, footer: current } = await footer({ load: { select }, statuses: {} });
	await commands["gentle-quiet"].handler("", ctx);
	assert.ok(seen[1].items.includes("Status line tokens: cache"));
	assert.ok(seen[2].items.includes("Status line tokens: all"));
	assert.ok(seen[3].items.includes("Status line tokens: off"));
	assert.equal(readConfig().statusLine.tokens, "cache");
	const line = plain(current()({ requestRender() {} }, theme, footerData({})).render(160)[0]);
	assert.match(line, / R50k W2\.0k CH98\.0% · ctx /);
});

test("older saved true/false values still work", async () => {
	const all = plain((await footer({ config: { statusLine: { tokens: true } }, statuses: {} })).component.render(160)[0]);
	assert.match(all, /↑1\.2k ↓300 R50k/);
});

// A provider like claude-bridge: no price per token, no OAuth reported to Pi.
const unpriced = (extra = {}) => ({
	model: { id: "claude-opus-5-5", provider: "claude-bridge", reasoning: true },
	subscription: false,
	entries: [{ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }],
	...extra,
});

test("a zero cost without a known subscription is hidden, like Pi's own footer", async () => {
	const line = plain((await footer({ session: unpriced(), statuses: {} })).component.render(160)[0]);
	assert.doesNotMatch(line, /\$/);
	assert.match(line, /ctx \u{F0A9F} 28% $/u);
});

test("a provider marked as subscription shows sub instead of $0.000", async () => {
	const config = { statusLine: { subscriptionProviders: ["claude-bridge"] } };
	const line = plain((await footer({ session: unpriced(), statuses: {}, config })).component.render(160)[0]);
	assert.match(line, /ctx \u{F0A9F} 28% · sub $/u);
	assert.doesNotMatch(line, /\$0/);
});

test("the menu marks the current provider as subscription and back, and saves it", async () => {
	const { select, seen } = picker(/^Status line ›$/, /^Subscription \(claude-bridge\)/, /^Subscription \(claude-bridge\)/);
	const { commands, ctx } = await footer({ session: unpriced(), statuses: {}, load: { select } });
	await commands["gentle-quiet"].handler("", ctx);
	assert.ok(seen[1].items.includes("Subscription (claude-bridge): off"));
	assert.ok(seen[2].items.includes("Subscription (claude-bridge): on"));
	assert.deepEqual(readConfig().statusLine.subscriptionProviders, []);
});

// claude-bridge reports real tokens at zero prices; Pi knows the Anthropic prices.
const bridged = (usage, extra = {}) => ({
	model: { id: "claude-opus-5-5", provider: "claude-bridge", reasoning: true },
	subscription: false,
	registry: { "anthropic/claude-opus-5-5": { cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } } },
	entries: [
		{ type: "message", message: { role: "assistant", provider: "claude-bridge", model: "claude-opus-5-5", usage: { ...usage, cost: { total: 0 } } } },
	],
	...extra,
});
const subscribed = { statusLine: { subscriptionProviders: ["claude-bridge"] } };

test("an unpriced provider gets the API-equivalent cost from the same Anthropic model", async () => {
	// 1M input × $4 + 100k output × $20 + 10M cache read × $0.2 + 200k cache write × $5 = 4 + 2 + 2 + 1 = $9.00
	const session = bridged({ input: 1_000_000, output: 100_000, cacheRead: 10_000_000, cacheWrite: 200_000 });
	const line = plain((await footer({ session, statuses: {}, config: subscribed })).component.render(160)[0]);
	assert.match(line, /ctx \u{F0A9F} 28% · \$9\.00 sub $/u);
});

test("price tiers apply like Pi's own cost calculation", async () => {
	const session = bridged({ input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 }, {
		model: { id: "claude-haiku-5-5", provider: "claude-bridge", reasoning: true },
		registry: { "anthropic/claude-haiku-5-5": { cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ inputTokensAbove: 1e5, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }] } } },
	});
	session.entries[0].message.model = "claude-haiku-5-5";
	const line = plain((await footer({ session, statuses: {}, config: subscribed })).component.render(160)[0]);
	assert.match(line, /\$0\.100 sub $/, "200k input above the 100k tier: 200k × $0.5");
});

test("without a known price the cost stays as reported", async () => {
	const session = bridged({ input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }, { registry: {} });
	const line = plain((await footer({ session, statuses: {}, config: subscribed })).component.render(160)[0]);
	assert.match(line, /28% · sub $/);
});

test("Estimated cost can be turned off in the menu", async () => {
	const session = bridged({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
	const { select, seen } = picker(/^Status line ›$/, /^Estimated cost/);
	const { commands, ctx, component } = await footer({ session, statuses: {}, config: subscribed, load: { select } });
	assert.match(plain(component.render(160)[0]), /\$4\.00 sub $/);
	await commands["gentle-quiet"].handler("", ctx);
	assert.ok(seen[1].items.includes("Estimated cost (unpriced providers): on"));
	assert.equal(readConfig().statusLine.estimateCost, false);
	assert.match(plain(component.render(160)[0]), /28% · sub $/);
});

test("the branch has a git branch icon in front, in the branch's color", async () => {
	const { component } = await footer({ session: { cwd: "/srv/app" }, statuses: {} });
	const row = component.render(170)[0];
	assert.match(plain(row), /^app · \u{E725} main +/u);
	assert.ok(painted(row, "text", "\u{E725} main"), "icon and name in the text role");
});

test("the branch icon is an Icons choice: another glyph or none, saved", async () => {
	const { select, seen } = picker(/^Icons ›$/, /^Branch icon/, /^none$/);
	const { component, commands, ctx } = await footer({ session: { cwd: "/srv/app" }, statuses: {}, load: { select } });
	await commands["gentle-quiet"].handler("", ctx);
	assert.ok(seen[1].items.includes('Branch icon: "\u{E725}"'));
	assert.deepEqual(seen[2].items, ["\u{E725}", "\u{F418}", "\u{E0A0}", "⎇", "none", "custom…"]);
	assert.equal(readConfig().icons.branch, "");
	assert.match(plain(component.render(170)[0]), /^app · main +/);
});

test("no branch, no icon", async () => {
	writeConfig({});
	const loaded = await load({ mode: "tui", session: session({ cwd: "/srv/app" }) });
	const component = loaded.footer()({ requestRender() {} }, theme, { ...footerData({}), getGitBranch: () => null });
	assert.doesNotMatch(plain(component.render(170)[0]), /\u{E725}/u);
});

test("the context shows the tokens in use out of the window, and the option hides them", async () => {
	const usage = { percent: 18, tokens: 180_000, contextWindow: 1_000_000 };
	const shown = plain((await footer({ session: { usage }, statuses: {} })).component.render(160)[0]);
	assert.match(shown, /ctx \u{F0A9E} 18% 180k\/1\.0M · /u);
	const unknown = plain((await footer({ session: { usage: { percent: null, tokens: null, contextWindow: 200_000 } }, statuses: {} })).component.render(160)[0]);
	assert.match(unknown, /ctx \S+ \?% \?\/200k · /u);
	const off = plain((await footer({ session: { usage }, statuses: {}, config: { statusLine: { contextTokens: false } } })).component.render(160)[0]);
	assert.match(off, /ctx \u{F0A9E} 18% · /u);
	assert.doesNotMatch(off, /180k/);
});
