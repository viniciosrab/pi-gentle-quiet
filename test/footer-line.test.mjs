import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
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

test("replaces Pi's footer: Perm right after the model and effort, counters on the right", async () => {
	const { component } = await footer({ session: { cwd: "/srv/app" } });
	assert.ok(component, "footer installed");
	const rows = component.render(170).map(plain);
	assert.equal(rows.length, 1, "statuses share the line when they fit");
	assert.match(rows[0], /^\/srv\/app main · claude-opus-5-5 · medium · Perm: Normal · ⧗ 1 job +R50k W2\.0k CH98\.0% · ctx ▰▰▱▱▱▱▱▱ 28% · \$1\.75 sub $/);
});

test("on narrow terminals the counters give way before Perm leaves the first line", async () => {
	const { component } = await footer({ session: { cwd: "/srv/app" } });
	const at = (width) => component.render(width).map(plain);
	assert.equal(at(105).length, 1);
	assert.match(at(105)[0], /^\/srv\/app main · claude-opus-5-5 · medium · Perm: Normal · ⧗ 1 job +ctx .* \$1\.75 sub $/);
	const narrow = at(90);
	assert.equal(narrow.length, 2, "statuses move to a second row only when the first line cannot hold them");
	assert.equal(narrow[1], "Perm: Normal  ⧗ 1 job");
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

test("the context gauge turns warning at 80% and error at 95%", async () => {
	const warn = (await footer({ session: { usage: { percent: 85 } } })).component.render(120)[0];
	assert.ok(painted(warn, "warning", "▰▰▰▰▰▰▰"));
	const full = (await footer({ session: { usage: { percent: 97 } } })).component.render(120)[0];
	assert.ok(painted(full, "error", "▰▰▰▰▰▰▰▰"));
});

test("API-key models show plain cost; models without reasoning show no effort", async () => {
	const line = plain((await footer({ session: { subscription: false, model: { id: "gpt-x", reasoning: false } }, statuses: {}, config: { statusLine: { tokens: "all" } } })).component.render(160)[0]);
	assert.match(line, / gpt-x +↑1\.2k .* ctx .* \$1\.75 $/);
});

test("narrow terminals drop details before the context and cost", async () => {
	const { component } = await footer({ session: { cwd: "/srv/a-long-project-name" } });
	const line = plain(component.render(46)[0]);
	assert.ok(line.length <= 46);
	assert.match(line, /ctx .* 28%/);
});

test("Status line options: changes and cost can be hidden", async () => {
	const dir = repo();
	const { component } = await footer({ session: { cwd: dir }, config: { statusLine: { changes: false, cost: false } } });
	await settle();
	const line = plain(component.render(200)[0]);
	assert.doesNotMatch(line, /±|\$/);
	assert.match(line, / main · claude/);
});

test("Status line: pi restores Pi's own footer right away and is saved", async () => {
	const { select } = picker(/^Status line: gentle/);
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
	assert.match(at(110), /↑1\.2k ↓300 R50k W2\.0k CH98\.0% · ctx/);
	assert.match(at(100), /medium +↑1\.2k ↓300 · ctx/, "cache goes first, effort stays");
	assert.doesNotMatch(at(100), /R50k/);
	assert.doesNotMatch(at(80), /↑/);
	assert.match(at(80), /medium +ctx .* \$1\.75 sub $/);
});

test("Status line tokens can be turned off", async () => {
	const line = plain((await footer({ config: { statusLine: { tokens: false } }, statuses: {} })).component.render(160)[0]);
	assert.doesNotMatch(line, /↑|↓|CH/);
	assert.match(line, /ctx ▰/);
});

test("by default the counters show only the cache: R, W and the hit rate", async () => {
	const line = plain((await footer({ statuses: {} })).component.render(160)[0]);
	assert.match(line, / R50k W2\.0k CH98\.0% · ctx /);
	assert.doesNotMatch(line, /↑|↓/);
});

test("in cache mode a narrow terminal keeps the hit rate after R and W go", async () => {
	const { component } = await footer({ session: { cwd: "/srv/app" }, statuses: {} });
	assert.match(plain(component.render(88)[0]), /medium +CH98\.0% · ctx/);
	assert.doesNotMatch(plain(component.render(88)[0]), /R50k/);
});

test("Status line tokens cycles cache → all → off and is saved", async () => {
	const { select, seen } = picker(/^Status line tokens/, /^Status line tokens/, /^Status line tokens/);
	const { commands, ctx, footer: current } = await footer({ load: { select }, statuses: {} });
	await commands["gentle-quiet"].handler("", ctx);
	assert.ok(seen[0].items.includes("Status line tokens: cache"));
	assert.ok(seen[1].items.includes("Status line tokens: all"));
	assert.ok(seen[2].items.includes("Status line tokens: off"));
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
	assert.match(line, /ctx ▰▰▱▱▱▱▱▱ 28% $/);
});

test("a provider marked as subscription shows sub instead of $0.000", async () => {
	const config = { statusLine: { subscriptionProviders: ["claude-bridge"] } };
	const line = plain((await footer({ session: unpriced(), statuses: {}, config })).component.render(160)[0]);
	assert.match(line, /ctx ▰▰▱▱▱▱▱▱ 28% · sub $/);
	assert.doesNotMatch(line, /\$0/);
});

test("the menu marks the current provider as subscription and back, and saves it", async () => {
	const { select, seen } = picker(/^Subscription \(claude-bridge\)/, /^Subscription \(claude-bridge\)/);
	const { commands, ctx } = await footer({ session: unpriced(), statuses: {}, load: { select } });
	await commands["gentle-quiet"].handler("", ctx);
	assert.ok(seen[0].items.includes("Subscription (claude-bridge): off"));
	assert.ok(seen[1].items.includes("Subscription (claude-bridge): on"));
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
	assert.match(line, /ctx ▰▰▱▱▱▱▱▱ 28% · \$9\.00 sub $/);
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
	const { select, seen } = picker(/^Estimated cost/);
	const { commands, ctx, component } = await footer({ session, statuses: {}, config: subscribed, load: { select } });
	assert.match(plain(component.render(160)[0]), /\$4\.00 sub $/);
	await commands["gentle-quiet"].handler("", ctx);
	assert.ok(seen[0].items.includes("Estimated cost (unpriced providers): on"));
	assert.equal(readConfig().statusLine.estimateCost, false);
	assert.match(plain(component.render(160)[0]), /28% · sub $/);
});
