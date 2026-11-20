// The usage readings and the tree memory live in <agent dir>/gentle-quiet/; older versions kept them in the
// agent dir itself, and loading the extension moves them there once.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { configFile, load } from "./helpers.mjs";

const agentDir = path.dirname(configFile);
const stateDir = path.join(agentDir, "gentle-quiet");
const legacyUsage = path.join(agentDir, "gentle-quiet-usage.json");
const legacyTree = path.join(agentDir, "gentle-quiet-tree.json");

test("files left in the agent dir by older versions move into gentle-quiet/ on load", async () => {
	writeFileSync(legacyUsage, '{"claude-bridge":{"name":"claude","windows":[],"at":1}}');
	writeFileSync(legacyTree, '{"/p":{"expanded":["src"],"at":1}}');
	writeFileSync(configFile, '{"yoloBanner":true}');
	await load();
	assert.equal(existsSync(legacyUsage), false);
	assert.equal(existsSync(legacyTree), false);
	assert.equal(readFileSync(path.join(stateDir, "usage.json"), "utf8"), '{"claude-bridge":{"name":"claude","windows":[],"at":1}}');
	assert.equal(readFileSync(path.join(stateDir, "tree.json"), "utf8"), '{"/p":{"expanded":["src"],"at":1}}');
	assert.equal(readFileSync(configFile, "utf8"), '{"yoloBanner":true}'); // the settings stay where they are
});

test("a legacy file never overwrites one already in gentle-quiet/", async () => {
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(path.join(stateDir, "tree.json"), '{"new":true}');
	writeFileSync(legacyTree, '{"old":true}');
	await load();
	assert.equal(readFileSync(path.join(stateDir, "tree.json"), "utf8"), '{"new":true}');
	assert.equal(readFileSync(legacyTree, "utf8"), '{"old":true}');
});
