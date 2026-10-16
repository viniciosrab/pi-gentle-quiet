import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { configFile, load } from "./helpers.mjs";

// A subagent: Pi passes the main process's environment on, so the parent's session id is already set.
process.env.GENTLE_QUIET_SPEND_PARENT = "main-session";
const spendDir = path.join(path.dirname(configFile), "gentle-quiet-spend");
const reply = (input, output, cost, model) => ({ type: "message", message: { role: "assistant", provider: "x", model, usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } } });

test("a subagent shares its own session totals, priced by its own model, under the parent's session", async () => {
	const session = { id: "child-1", model: { id: "grok-5", provider: "xai" }, entries: [reply(2000, 300, 0.4, "grok-5")] };
	const { emit } = await load({ session });
	await emit("turn_end");
	const shared = JSON.parse(readFileSync(path.join(spendDir, "main-session", "child-1.json"), "utf8"));
	assert.deepEqual([shared.input, shared.output, shared.cost], [2000, 300, 0.4]);
	session.entries.push(reply(1000, 100, 0.2, "grok-5"));
	await emit("turn_end");
	const later = JSON.parse(readFileSync(path.join(spendDir, "main-session", "child-1.json"), "utf8"));
	assert.deepEqual([later.input, later.output, Math.round(later.cost * 100)], [3000, 400, 60]);
});

test("a subagent leaves the parent's session id for its own subagents", () => {
	assert.equal(process.env.GENTLE_QUIET_SPEND_PARENT, "main-session");
});
