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
	entries: [
		{ type: "message", message: { role: "assistant", usage: { cost: { total: 1.5 } } } },
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.25 } } } },
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

test("replaces Pi's footer with location, model, context and cost", async () => {
	const { component } = await footer({ session: { cwd: "/srv/app" } });
	assert.ok(component, "footer installed");
	const [line, statuses] = component.render(120).map(plain);
	assert.match(line, /^ \/srv\/app main · claude-opus-5-5 · medium +ctx ▰▰▱▱▱▱▱▱ 28% · \$1\.75 sub $/);
	assert.equal(statuses, " ⧗ 1 job  Perm: Normal");
});

test("shows the working tree changes from git: files and added/removed lines", async () => {
	const dir = repo();
	const { component } = await footer({ session: { cwd: dir } });
	await settle();
	const line = component.render(140)[0];
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
	const line = plain((await footer({ session: { subscription: false, model: { id: "gpt-x", reasoning: false } } })).component.render(120)[0]);
	assert.match(line, / gpt-x +ctx .* \$1\.75 $/);
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
	const line = plain(component.render(140)[0]);
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
