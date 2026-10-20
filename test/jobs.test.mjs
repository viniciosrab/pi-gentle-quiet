import assert from "node:assert/strict";
import { test } from "node:test";
import { load, lines, painted, theme } from "./helpers.mjs";

const NOTICE = "gentle-jobs.notice";
const text = (value, extra = {}) => ({ content: [{ type: "text", text: value }], ...extra });
const native = { renderCall: () => ({ render: () => ["NATIVE"] }), renderResult: () => ({ render: () => ["NATIVE"] }) };

// Shapes gentle-pi's background jobs send (lib/background-jobs-tools.ts).
const events = {
	customType: NOTICE,
	content: [{ type: "text", text: 'Monitor job-2 ("verify KPDL") reported 2 new lines:\nkey down [ KPDL ] keysyms [ Delete          ] unicode [ U+007F ]\nkey up   [ KPDL ]' }],
	details: { gentleJobs: { jobId: "job-2", kind: "monitor", label: "verify KPDL", status: "running", exitCode: null, event: "events" } },
};
const exited = (exitCode) => ({
	customType: NOTICE,
	content: [{ type: "text", text: `Background job job-1 ("build") exited with code ${exitCode} after 12s.\nCommand: make\nLast output:\nok` }],
	details: { gentleJobs: { jobId: "job-1", kind: "bash", label: "build", status: "exited", exitCode } },
});
const render = (renderer, msg, expanded = false, width = 70) =>
	lines(renderer(msg, { expanded }, theme), width).map((line) => line.trimEnd());

async function draw(name, args, result, options = {}) {
	const { tool } = await load();
	const renderers = tool(name, native);
	assert.equal(renderers.renderShell, "self");
	return [
		...lines(renderers.renderCall(args, theme)),
		...lines(renderers.renderResult(result, options, theme, { args }), 70),
	].map((line) => line.trimEnd());
}

test("a monitor event shows the job, its label and a line count instead of a card", async () => {
	const { messageRenderers } = await load();
	const renderer = messageRenderers[NOTICE];
	assert.ok(renderer, "job notice renderer registered");
	const out = render(renderer, events);
	assert.equal(out.length, 2);
	assert.match(out[0], /^ ⠋ monitor · verify KPDL +ctrl\+o to expand$/);
	assert.equal(out[1], " └ 2 new lines");
});

test("expanding a monitor event lists its lines on Pi's margin, cut to the width", async () => {
	const { messageRenderers } = await load();
	const out = render(messageRenderers[NOTICE], events, true, 40);
	assert.equal(out[0], " ⠋ monitor · verify KPDL");
	assert.equal(out[1], " └ 2 new lines");
	assert.equal(out[2], "   key down [ KPDL ] keysyms [ Delete  …");
	assert.equal(out[3], "   key up   [ KPDL ]");
	assert.ok(out.every((line) => line.length <= 40));
});

test("a finished job shows its outcome painted by exit code", async () => {
	const { messageRenderers } = await load();
	const ok = messageRenderers[NOTICE](exited(0), { expanded: false }, theme).render(70);
	assert.match(ok[0], /⠋ bash_background/);
	assert.ok(painted(ok[1], "success", "✓ exited with code 0 after 12s"));
	const failed = messageRenderers[NOTICE](exited(2), { expanded: false }, theme).render(70);
	assert.ok(painted(failed[1], "error", "✗ exited with code 2 after 12s"));
});

test("background job tools render as quiet rows", async () => {
	assert.deepEqual(await draw("bash_background", { command: "npm test", label: "tests" }, text('Started background job job-1 ("tests").\nOutput: /tmp/x')), [
		" $ npm test · background",
		" └ ✓ job-1 started",
	]);
	assert.deepEqual(await draw("monitor", { command: "tail -f log", label: "watch log", timeout_seconds: 60 }, text('Started monitor job-3 ("watch log") for up to 60s.')), [
		" monitor watch log",
		" └ ✓ job-3 watching · up to 60s",
	]);
	assert.deepEqual(await draw("job_stop", { job_id: "job-2" }, text('Stopped job-2 ("verify").')), [" job_stop job-2", ' └ ✓ Stopped job-2 ("verify").']);
	assert.deepEqual(await draw("job_list", {}, text("job-1 running\njob-2 exited")), [" job_list", " └ ✓ 2 jobs"]);
});
