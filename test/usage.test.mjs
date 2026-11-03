import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configFile, load, painted, picker, plain, readConfig, theme, writeConfig } from "./helpers.mjs";

const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };
const now = () => Math.floor(Date.now() / 1000);

// What claude-bridge hands Pi after each turn: the SDK's rate_limit_event rebuilt as unified headers.
const claudeHeaders = (five, week, extra = {}) => ({
	"anthropic-ratelimit-unified-status": "allowed",
	"anthropic-ratelimit-unified-5h-utilization": String(five),
	"anthropic-ratelimit-unified-5h-reset": String(now() + 7200),
	"anthropic-ratelimit-unified-7d-utilization": String(week),
	"anthropic-ratelimit-unified-7d-reset": String(now() + 86400 * 3),
	...extra,
});

// Each test uses its own provider id: usage is account-level state that outlives a session.
async function start(provider, config = {}, width = 200) {
	writeConfig(config);
	const loaded = await load({
		mode: "tui",
		session: { model: { id: "m", provider, reasoning: false }, usage: { percent: 28 }, cwd: "/srv/app" },
	});
	const component = loaded.footer()({ requestRender() {} }, theme, footerData);
	const line = () => component.render(width)[0];
	return { ...loaded, component, line };
}

test("Claude plan windows from the response headers show as a meter each, 5h and week", async () => {
	const { emit, line } = await start("claude-bridge");
	assert.doesNotMatch(plain(line()), /claude/, "nothing before the first response");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.62, 0.31) });
	assert.match(plain(line()), /ctx \u{F0A9F} 28% · claude 5h \u{F0AA2} 62% · week \u{F0A9F} 31% $/u);
});

test("Codex headers (percent plus window length) work the same way", async () => {
	const { emit, line } = await start("openai-codex");
	await emit("after_provider_response", {
		status: 200,
		headers: {
			"x-codex-primary-used-percent": "62",
			"x-codex-primary-window-minutes": "300",
			"x-codex-secondary-used-percent": "31",
			"x-codex-secondary-window-minutes": "10080",
		},
	});
	assert.match(plain(line()), /codex 5h \u{F0AA2} 62% · week \u{F0A9F} 31% $/u);
});

test("the meter turns warning at 80% and error at 95%, like the context meter", async () => {
	const warn = await start("claude-bridge-warn");
	await warn.emit("after_provider_response", { status: 200, headers: claudeHeaders(0.85, 0.2) });
	assert.ok(painted(warn.line(), "warning", "\u{F0AA4}"));
	const full = await start("claude-bridge-error");
	await full.emit("after_provider_response", { status: 200, headers: claudeHeaders(0.97, 0.2) });
	assert.ok(painted(full.line(), "error", "\u{F0AA5}"));
});

test("the week meter turns warning at 80% on its own, like the 5h one", async () => {
	const { emit, line } = await start("claude-bridge-week-warn");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.2, 0.85) });
	assert.ok(painted(line(), "warning", "\u{F0AA4}"), "week meter in warning");
	assert.ok(painted(line(), "accent", "\u{F0A9F}"), "5h meter stays accent");
});

test("responses without usage headers leave the last reading alone", async () => {
	const { emit, line } = await start("claude-bridge-keep");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.4, 0.2) });
	await emit("after_provider_response", { status: 200, headers: { "content-type": "text/event-stream" } });
	assert.match(plain(line()), /claude 5h \u{F0AA0} 40% · week \u{F0A9F} 20%/u);
});

test("usage belongs to the provider that reported it", async () => {
	const { emit, line, ctx } = await start("claude-bridge-own");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.4, 0.2) });
	ctx.model = { id: "gpt", provider: "some-other-provider", reasoning: false };
	assert.doesNotMatch(plain(line()), /claude|codex/);
});

test("a window that already reset is not shown", async () => {
	const { emit, line } = await start("claude-bridge-stale");
	await emit("after_provider_response", {
		status: 200,
		headers: claudeHeaders(0.9, 0.2, { "anthropic-ratelimit-unified-5h-reset": String(now() - 60) }),
	});
	assert.match(plain(line()), /claude week \u{F0A9F} 20% $/u);
	assert.doesNotMatch(plain(line()), /5h/);
});

test("narrow terminals keep only the first window before dropping the usage", async () => {
	const { emit, component } = await start("claude-bridge-narrow");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.62, 0.31) });
	const at = (width) => plain(component.render(width)[0]);
	assert.match(at(200), /claude 5h \u{F0AA2} 62% · week \u{F0A9F} 31%/u);
	assert.match(at(47), /claude 5h \u{F0AA2} 62% $/u);
	assert.doesNotMatch(at(47), /week/);
	assert.doesNotMatch(at(32), /claude/);
	assert.match(at(32), /^app · \u{E725} main +ctx/u);
	assert.doesNotMatch(at(17), /claude|app/);
});

test("Status line usage can be turned off in the menu and is saved", async () => {
	writeConfig({});
	const { select, seen } = picker(/^Status line ›$/, /^Status line usage/);
	const loaded = await load({ mode: "tui", session: { model: { id: "m", provider: "claude-bridge-menu", reasoning: false }, usage: { percent: 28 } }, select });
	const component = loaded.footer()({ requestRender() {} }, theme, footerData);
	await loaded.emit("after_provider_response", { status: 200, headers: claudeHeaders(0.5, 0.1) });
	assert.match(plain(component.render(200)[0]), /claude 5h \u{F0AA1} 50%/u);
	await loaded.commands["gentle-quiet"].handler("", loaded.ctx);
	assert.ok(seen[1].items.includes("Status line usage: on"));
	assert.equal(readConfig().statusLine.usage, false);
	assert.doesNotMatch(plain(component.render(200)[0]), /claude/);
});

// Subagents are separate Pi processes: each one shares its readings through this file.
const usageFile = path.join(path.dirname(configFile), "gentle-quiet-usage.json");
const readUsageFile = () => JSON.parse(readFileSync(usageFile, "utf8"));
const writeUsageFile = (value) => writeFileSync(usageFile, JSON.stringify(value));

// claude-accounts gives each Pi process its Claude account through this variable; the file keys a
// Claude reading by a fingerprint of it, never the token itself.
const TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";
const onAccount = (token) => (process.env[TOKEN] = token);
const fingerprint = (token) => createHash("sha256").update(token).digest("hex").slice(0, 12);
const sharedKey = (provider, token) => `${provider}#${fingerprint(token)}`;
const reading = (five, week, at = Date.now() + 1000) => {
	const reset = (now() + 7200) * 1000;
	return { name: "claude", at, windows: [{ label: "5h", percent: five, resetAt: reset }, { label: "week", percent: week, resetAt: reset }] };
};

test("a reading is shared with the other Pi processes through the usage file", async () => {
	onAccount("token-share");
	const { emit } = await start("claude-bridge-share");
	await emit("agent_start");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.55, 0.25) });
	const shared = readUsageFile()[sharedKey("claude-bridge-share", "token-share")];
	assert.equal(shared.name, "claude");
	assert.deepEqual(shared.windows.map((window) => [window.label, Math.round(window.percent)]), [["5h", 55], ["week", 25]]);
});

test("a subagent's newer reading shows in the main footer before the subagent returns", async () => {
	onAccount("token-child");
	const { emit, line } = await start("claude-bridge-child");
	await emit("agent_start");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.4, 0.2) });
	writeUsageFile({ ...readUsageFile(), [sharedKey("claude-bridge-child", "token-child")]: reading(67, 38) });
	assert.match(plain(line()), /claude 5h \u{F0AA2} 67% · week \u{F0AA0} 38% $/u);
});

test("a newer reading another window made on a different account never shows in this one", async () => {
	onAccount("token-mine");
	const { emit, line } = await start("claude-bridge-accounts");
	await emit("agent_start");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.4, 0.07) });
	writeUsageFile({
		...readUsageFile(),
		[sharedKey("claude-bridge-accounts", "token-other")]: reading(9, 45),
		// What versions before the account key wrote: no way to tell whose account it was.
		"claude-bridge-accounts": reading(24, 45),
	});
	assert.match(plain(line()), /claude 5h \u{F0AA0} 40% · week \S+ 7% $/u);
});

test("a reading after claude-accounts switched mid-run belongs to the account the run started on", async () => {
	onAccount("token-full");
	const { emit, line } = await start("claude-bridge-switch");
	await emit("agent_start");
	// claude-accounts moves the session at 95%, but this run's Claude Code process keeps its token.
	onAccount("token-fresh");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.96, 0.2) });
	assert.match(plain(line()), /claude 5h \u{F0AA5} 96%/u, "the run that just answered");
	assert.ok(readUsageFile()[sharedKey("claude-bridge-switch", "token-full")], "shared as the full account's");
	assert.equal(readUsageFile()[sharedKey("claude-bridge-switch", "token-fresh")], undefined);
	await emit("agent_start");
	assert.doesNotMatch(plain(line()), /claude/, "the next run is on an account with no reading yet");
});

test("the retry after a failed response belongs to the account claude-accounts moved it to", async () => {
	onAccount("token-limit");
	const { emit, line } = await start("claude-bridge-retry");
	await emit("agent_start");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.4, 0.2) });
	onAccount("token-spare");
	await emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "limit reached" } });
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.03, 0.1) });
	assert.match(plain(line()), /claude 5h \S+ 3%/u);
	assert.ok(readUsageFile()[sharedKey("claude-bridge-retry", "token-spare")]);
	assert.equal(Math.round(readUsageFile()[sharedKey("claude-bridge-retry", "token-limit")].windows[0].percent), 40, "the failed run's reading stays its own");
});

test("an older reading in the file does not replace a newer one of this process", async () => {
	onAccount("token-older");
	const { emit, line } = await start("claude-bridge-older");
	await emit("agent_start");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.4, 0.2) });
	writeUsageFile({
		...readUsageFile(),
		[sharedKey("claude-bridge-older", "token-older")]: { name: "claude", at: 1, windows: [{ label: "5h", percent: 90, resetAt: null }] },
	});
	assert.match(plain(line()), /claude 5h \u{F0AA0} 40% · week \u{F0A9F} 20% $/u);
});

test("a missing or malformed usage file leaves the footer as it was", async () => {
	const { emit, line } = await start("claude-bridge-broken");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.4, 0.2) });
	writeFileSync(usageFile, "{not json");
	assert.match(plain(line()), /claude 5h \u{F0AA0} 40% · week \u{F0A9F} 20% $/u);
});

test("Status line weekly usage can be turned off in the menu: the 5h window stays and it is saved", async () => {
	writeConfig({});
	const { select, seen } = picker(/^Status line ›$/, /^Status line weekly usage/);
	const loaded = await load({ mode: "tui", session: { model: { id: "m", provider: "claude-bridge-week-menu", reasoning: false }, usage: { percent: 28 } }, select });
	const component = loaded.footer()({ requestRender() {} }, theme, footerData);
	await loaded.emit("after_provider_response", { status: 200, headers: claudeHeaders(0.5, 0.1) });
	assert.match(plain(component.render(200)[0]), /claude 5h \u{F0AA1} 50% · week \u{F0A9E} 10% $/u);
	await loaded.commands["gentle-quiet"].handler("", loaded.ctx);
	const items = seen[1].items;
	assert.equal(items[items.indexOf("Status line usage: on") + 1], "Status line weekly usage: on", "right under the usage option");
	assert.equal(readConfig().statusLine.usageWeek, false);
	assert.match(plain(component.render(200)[0]), /claude 5h \u{F0AA1} 50% $/u);
	assert.doesNotMatch(plain(component.render(200)[0]), /week/);
});

test("with weekly usage off, a lone weekly window (5h already reset) shows no usage at all", async () => {
	const { emit, line } = await start("claude-bridge-week-only", { statusLine: { usageWeek: false } });
	await emit("after_provider_response", {
		status: 200,
		headers: claudeHeaders(0.9, 0.2, { "anthropic-ratelimit-unified-5h-reset": String(now() - 60) }),
	});
	assert.doesNotMatch(plain(line()), /claude|week/);
	assert.match(plain(line()), /ctx \u{F0A9F} 28% $/u);
});

test("with weekly usage off, Codex's weekly window is hidden too", async () => {
	const { emit, line } = await start("openai-codex-week-off", { statusLine: { usageWeek: false } });
	await emit("after_provider_response", {
		status: 200,
		headers: {
			"x-codex-primary-used-percent": "62",
			"x-codex-primary-window-minutes": "300",
			"x-codex-secondary-used-percent": "31",
			"x-codex-secondary-window-minutes": "10080",
		},
	});
	assert.match(plain(line()), /codex 5h \u{F0AA2} 62% $/u);
});
