import assert from "node:assert/strict";
import { test } from "node:test";
import { load, lines, painted, theme, picker, readConfig, writeConfig } from "./helpers.mjs";

const RESULT = "gentle-agents.result";
// Shape gentle-agents sends: a completion header paragraph, then the child's answer.
const message = (status = "completed", body = "Found 3 call sites in src/.\nDetails follow.\n\nMore text.") => ({
	customType: RESULT,
	content: [{ type: "text", text: `Subagent gentle-ai-explore (task t1) ${status}.\n\n${body}` }],
	details: { gentleAgents: { agent: "gentle-ai-explore", status } },
});
const render = (renderer, msg, expanded = false, width = 70) =>
	lines(renderer(msg, { expanded, outputPad: 1 }, theme), width).map((line) => line.trimEnd());

test("a finished subagent shows its name, status and one summary line", async () => {
	const { messageRenderers } = await load();
	const renderer = messageRenderers[RESULT];
	assert.ok(renderer, "result renderer registered");
	const out = render(renderer, message());
	assert.equal(out.length, 2);
	assert.match(out[0], /^ ◈ gentle-ai-explore · done +ctrl\+o to expand$/);
	assert.equal(out[1], " └ Found 3 call sites in src/.");
});

test("the status is painted: done in success, failures in error", async () => {
	const { messageRenderers } = await load();
	const ok = messageRenderers[RESULT](message(), { expanded: false }, theme).render(70)[0];
	assert.ok(painted(ok, "success", "done"));
	const failed = messageRenderers[RESULT](message("failed", "Timed out."), { expanded: false }, theme).render(70)[0];
	assert.ok(painted(failed, "error", "failed"));
});

test("expanding shows the whole answer on Pi's margin, without the completion header", async () => {
	const { messageRenderers } = await load();
	assert.deepEqual(render(messageRenderers[RESULT], message(), true), [
		" ◈ gentle-ai-explore · done",
		"   Found 3 call sites in src/.",
		"   Details follow.",
		"",
		"   More text.",
	]);
});

test("a one-line answer has nothing to expand, so no hint", async () => {
	const { messageRenderers } = await load();
	assert.deepEqual(render(messageRenderers[RESULT], message("completed", "All good.")), [" ◈ gentle-ai-explore · done", " └ All good."]);
});

test("the agents icon follows the configured icon", async () => {
	const { select } = picker(/^Agents icon/, /^◆$/);
	const { messageRenderers, commands, ctx } = await load({ select });
	await commands["gentle-quiet"].handler("", ctx);
	assert.match(render(messageRenderers[RESULT], message())[0], /^ ◆ gentle-ai-explore/);
});

test("subagent results can be switched back to the original card (after restart)", async () => {
	const { select, seen } = picker(/^Subagent results/);
	const { commands, ctx } = await load({ select });
	await commands["gentle-quiet"].handler("", ctx);
	assert.ok(seen[0].items.some((item) => /^Subagent results: minimal \(restart to apply\)$/.test(item)));
	assert.equal(readConfig().subagents.minimal, false);
});

const STALE = "gentle-agents.stale-result";
const stale = { customType: STALE, data: { taskId: "t7", agent: "gentle-ai-explore", label: "map files", status: "completed", ageSeconds: 130 } };

test("a stale subagent result is a quiet row with when it finished", async () => {
	writeConfig({});
	const { entryRenderers } = await load();
	const renderer = entryRenderers[STALE];
	assert.ok(renderer, "stale result renderer registered");
	const out = lines(renderer(stale, { expanded: false }, theme), 80).map((line) => line.trimEnd());
	assert.equal(out.length, 2);
	assert.match(out[0], /^ ◈ gentle-ai-explore · stale +ctrl\+o to expand$/);
	assert.equal(out[1], " └ completed 2m ago while the orchestrator was busy");
	assert.ok(painted(renderer(stale, { expanded: false }, theme).render(80)[0], "warning", "stale"));
});

test("expanding a stale result says how to read it", async () => {
	writeConfig({});
	const { entryRenderers } = await load();
	const out = lines(entryRenderers[STALE](stale, { expanded: true }, theme), 80).map((line) => line.trimEnd());
	assert.deepEqual(out, [
		" ◈ gentle-ai-explore · stale",
		" └ completed 2m ago while the orchestrator was busy",
		"   Not replayed here; read it with subagent_result t7 (map files).",
	]);
});
