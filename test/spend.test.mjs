import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { configFile, load, plain, theme, writeConfig } from "./helpers.mjs";

// The main Pi process: subagents (their own Pi processes) leave their totals under its session id.
const spendDir = path.join(path.dirname(configFile), "gentle-quiet-spend");
const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };
const reply = (input, output, cost) => ({ type: "message", message: { role: "assistant", usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } } });

async function main(id) {
	writeConfig({ statusLine: { tokens: "all" } });
	const loaded = await load({ mode: "tui", session: { id, model: { id: "m", provider: "anthropic", reasoning: false }, usage: { percent: 28 }, cwd: "/srv/app", entries: [reply(1000, 200, 1.5)] } });
	const component = loaded.footer()({ requestRender() {} }, theme, footerData);
	return { ...loaded, line: () => plain(component.render(200)[0]) };
}

const child = (parent, name, totals) => {
	mkdirSync(path.join(spendDir, parent), { recursive: true });
	writeFileSync(path.join(spendDir, parent, `${name}.json`), JSON.stringify({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, at: Date.now(), ...totals }));
};

test("the main process names its session for the subagents it starts", async () => {
	await main("root-a");
	assert.equal(process.env.GENTLE_QUIET_SPEND_PARENT, "root-a");
});

test("the footer adds every subagent's tokens and cost to the session's own", async () => {
	const { line } = await main("root-b");
	assert.match(line(), /↑1\.0k ↓200 · ctx .* · \$1\.50 $/);
	child("root-b", "claude-child", { input: 3000, output: 800, cost: 2.25 });
	child("root-b", "grok-child", { input: 1000, output: 0, cost: 0.75 });
	assert.match(line(), /↑5\.0k ↓1\.0k · ctx .* · \$4\.50 $/);
});

test("a subagent's newer totals replace its older ones instead of adding up", async () => {
	const { line } = await main("root-c");
	child("root-c", "worker", { cost: 1 });
	assert.match(line(), /\$2\.50/);
	child("root-c", "worker", { cost: 2 });
	assert.match(line(), /\$3\.50/);
});

test("subagents of another session are not counted", async () => {
	const { line } = await main("root-d");
	child("someone-else", "worker", { cost: 9 });
	assert.match(line(), /\$1\.50/);
});

test("a malformed subagent file is skipped", async () => {
	const { line } = await main("root-e");
	mkdirSync(path.join(spendDir, "root-e"), { recursive: true });
	writeFileSync(path.join(spendDir, "root-e", "broken.json"), "{not json");
	child("root-e", "worker", { cost: 1 });
	assert.match(line(), /\$2\.50/);
});
