import assert from "node:assert/strict";
import { test } from "node:test";
import { load, painted, picker, plain, readConfig, theme, writeConfig } from "./helpers.mjs";

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

test("Claude plan windows from the response headers show as a meter for 5h and text for week", async () => {
	const { emit, line } = await start("claude-bridge");
	assert.doesNotMatch(plain(line()), /claude/, "nothing before the first response");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.62, 0.31) });
	assert.match(plain(line()), /ctx ▰▰▱▱▱▱▱▱ 28% · claude 5h ▰▰▰▰▰▱▱▱ 62% · week 31% $/);
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
	assert.match(plain(line()), /codex 5h ▰▰▰▰▰▱▱▱ 62% · week 31% $/);
});

test("the meter turns warning at 80% and error at 95%, like the context meter", async () => {
	const warn = await start("claude-bridge-warn");
	await warn.emit("after_provider_response", { status: 200, headers: claudeHeaders(0.85, 0.2) });
	assert.ok(painted(warn.line(), "warning", "▰▰▰▰▰▰▰"));
	const full = await start("claude-bridge-error");
	await full.emit("after_provider_response", { status: 200, headers: claudeHeaders(0.97, 0.2) });
	assert.ok(painted(full.line(), "error", "▰▰▰▰▰▰▰▰"));
});

test("responses without usage headers leave the last reading alone", async () => {
	const { emit, line } = await start("claude-bridge-keep");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.4, 0.2) });
	await emit("after_provider_response", { status: 200, headers: { "content-type": "text/event-stream" } });
	assert.match(plain(line()), /claude 5h ▰▰▰▱▱▱▱▱ 40% · week 20%/);
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
	assert.match(plain(line()), /claude week ▰▰▱▱▱▱▱▱ 20% $/);
	assert.doesNotMatch(plain(line()), /5h/);
});

test("narrow terminals keep only the first window before dropping the usage", async () => {
	const { emit, component } = await start("claude-bridge-narrow");
	await emit("after_provider_response", { status: 200, headers: claudeHeaders(0.62, 0.31) });
	const at = (width) => plain(component.render(width)[0]);
	assert.match(at(200), /claude 5h ▰▰▰▰▰▱▱▱ 62% · week 31%/);
	assert.match(at(70), /claude 5h ▰▰▰▰▰▱▱▱ 62% $/);
	assert.doesNotMatch(at(70), /week/);
	assert.doesNotMatch(at(55), /claude/);
	assert.doesNotMatch(at(40), /claude/);
});

test("Status line usage can be turned off in the menu and is saved", async () => {
	writeConfig({});
	const { select, seen } = picker(/^Status line usage/);
	const loaded = await load({ mode: "tui", session: { model: { id: "m", provider: "claude-bridge-menu", reasoning: false }, usage: { percent: 28 } }, select });
	const component = loaded.footer()({ requestRender() {} }, theme, footerData);
	await loaded.emit("after_provider_response", { status: 200, headers: claudeHeaders(0.5, 0.1) });
	assert.match(plain(component.render(200)[0]), /claude 5h ▰▰▰▰▱▱▱▱ 50%/);
	await loaded.commands["gentle-quiet"].handler("", loaded.ctx);
	assert.ok(seen[0].items.includes("Status line usage: on"));
	assert.equal(readConfig().statusLine.usage, false);
	assert.doesNotMatch(plain(component.render(200)[0]), /claude/);
});
