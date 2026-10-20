import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load, painted, picker, plain, readConfig, theme, writeConfig, configFile } from "./helpers.mjs";

const agentDir = path.dirname(configFile);
const writeMcp = (servers) => writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
const servers = {
	codegraph: { command: "codegraph" },
	context7: { command: "npx" },
	"my-db": { url: "https://example.com/mcp" },
	off: { command: "x", enabled: false },
};
const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };

async function row(session, config = {}, width = 200) {
	writeConfig(config);
	const loaded = await load({ mode: "tui", session });
	const component = loaded.footer()({ requestRender() {} }, theme, footerData);
	return { ...loaded, component, line: component.render(width)[0] };
}

test("shows online / installed MCP servers, counting only enabled ones", async () => {
	writeMcp(servers);
	const { line } = await row({ tools: ["mcp__codegraph__query", "mcp__codegraph__explore", "mcp__context7__resolve", "mcp__my_db__list"] });
	assert.match(plain(line), /· MCP 3\/3 /, "my-db maps to the my_db namespace; the disabled server is not counted");
	assert.ok(painted(line, "dim", "MCP 3/3"));
});

test("a server without visible tools is offline and the count warns", async () => {
	writeMcp(servers);
	const tools = [
		"mcp__codegraph__query",
		{ name: "mcp__context7__resolve", exposure: "hidden", namespace: { name: "mcp__context7" } }, // Pi hides a dropped server's tools
	];
	const { line } = await row({ tools });
	assert.match(plain(line), /MCP 1\/3 /);
	assert.ok(painted(line, "warning", "MCP 1/3"));
});

test("project servers count only in a trusted project; extension-registered servers count too", async () => {
	writeMcp({ codegraph: { command: "codegraph" } });
	const cwd = mkdtempSync(path.join(os.tmpdir(), "gentle-quiet-proj-"));
	mkdirSync(path.join(cwd, ".pi"));
	writeFileSync(path.join(cwd, ".pi/mcp.json"), JSON.stringify({ mcpServers: { local: { command: "x" } } }));
	const tools = ["mcp__codegraph__q", "mcp__local__q", "mcp__ext__q"];
	const untrusted = await row({ cwd, tools, extensionServers: [{ name: "ext", config: {} }] });
	assert.match(plain(untrusted.line), /MCP 2\/2 /, "codegraph + ext; the project file is ignored");
	const trusted = await row({ cwd, tools, projectTrusted: true, extensionServers: [{ name: "ext", config: {} }] });
	assert.match(plain(trusted.line), /MCP 3\/3 /);
});

test("no MCP servers configured shows nothing", async () => {
	writeMcp({});
	const { line } = await row({ tools: [] });
	assert.doesNotMatch(plain(line), /MCP/);
});

test("MCP can be turned off from the menu and is saved", async () => {
	writeMcp(servers);
	const { select, seen } = picker(/^Status line ›$/, /^Status line MCP/);
	writeConfig({});
	const loaded = await load({ mode: "tui", session: { tools: ["mcp__codegraph__q"] }, select });
	const component = loaded.footer()({ requestRender() {} }, theme, footerData);
	assert.match(plain(component.render(200)[0]), /MCP 1\/3/);
	await loaded.commands["gentle-quiet"].handler("", loaded.ctx);
	assert.ok(seen[1].items.includes("Status line MCP: on"));
	assert.equal(readConfig().statusLine.mcp, false);
	assert.doesNotMatch(plain(component.render(200)[0]), /MCP/);
});

test("MCP sits with the statuses: after Perm on the left, and on the second row when narrow", async () => {
	writeMcp(servers);
	writeConfig({});
	const loaded = await load({ mode: "tui", session: { cwd: "/srv/app", model: { id: "claude-opus-5-5", reasoning: true }, usage: { percent: 28 }, tools: ["mcp__codegraph__q"] } });
	const data = { ...footerData, getExtensionStatuses: () => new Map([["gentle:mode", "Perm: Normal"]]) };
	const component = loaded.footer()({ requestRender() {} }, theme, data);
	assert.match(plain(component.render(200)[0]), /^app · main · Perm: Normal · MCP 1\/3 /);
	const narrow = component.render(33).map(plain);
	assert.equal(narrow.length, 2);
	assert.equal(narrow[1], "Perm: Normal  MCP 1/3");
});
