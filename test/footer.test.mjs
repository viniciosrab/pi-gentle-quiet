import assert from "node:assert/strict";
import { test } from "node:test";
import { load, painted, plain, readConfig, picker, writeConfig } from "./helpers.mjs";

test("memory status loses the emoji and project, keeps the state", async () => {
	const { ui, status } = await load();
	ui.setStatus("engram", "🧠 vinicios · ✓ 4 results");
	assert.equal(plain(status.engram), "mem 4 results");
	ui.setStatus("engram", "🧠 vinicios · ✗ connection refused");
	assert.equal(plain(status.engram), "mem error connection refused");
	assert.ok(painted(status.engram, "error", "error connection refused"));
	ui.setStatus("engram", "🧠 vinicios · offline");
	assert.ok(painted(status.engram, "warning", "offline"));
});

test("permission mode is capitalized with a colored mode", async () => {
	const { ui, status } = await load();
	ui.setStatus("gentle:mode", "Permissions: NORMAL");
	assert.equal(plain(status["gentle:mode"]), "Perm: Normal");
	ui.setStatus("gentle:mode", "Permissions: AUTO");
	assert.ok(painted(status["gentle:mode"], "accent", "Auto"));
	ui.setStatus("gentle:mode", "Permissions: YOLO");
	assert.ok(painted(status["gentle:mode"], "warning", "Yolo"));
});

test("YOLO banner is hidden in the footer and above the editor", async () => {
	const { ui, status, widgets } = await load();
	ui.setStatus("gentle:yolo", "🚀 YOLO ON 🔥 — destructive confirmations remain");
	ui.setWidget("gentle:yolo", ["🚀 YOLO ON 🔥"]);
	assert.equal(status["gentle:yolo"], undefined);
	assert.equal(widgets["gentle:yolo"], undefined);
});

test("statuses of other extensions pass through unchanged", async () => {
	const { ui, status } = await load();
	ui.setStatus("other", "keep me");
	assert.equal(status.other, "keep me");
});

test("/gentle-quiet toggles an option, redraws the footer and saves it", async () => {
	const { select, seen } = picker(/^Footer statuses ›$/, /^Permission when normal/);
	const { ui, status, commands, ctx } = await load({ select });
	ui.setStatus("gentle:mode", "Permissions: NORMAL");
	assert.equal(plain(status["gentle:mode"]), "Perm: Normal");
	await commands["gentle-quiet"].handler("", ctx);
	assert.equal(seen[0].title, "Gentle Quiet");
	assert.equal(status["gentle:mode"], undefined, "normal mode hidden right away");
	assert.equal(readConfig().permissions.hideWhenNormal, true);
});

test("/gentle-quiet groups its options in sections; Back returns to them and Reset stays at the top", async () => {
	writeConfig({ yoloBanner: true });
	const { select, seen } = picker(/^Tool rows ›$/, /^← Back$/, /^Reset to defaults$/);
	const { commands, ctx } = await load({ select });
	await commands["gentle-quiet"].handler("", ctx);
	assert.deepEqual(seen[0].items, ["Status line ›", "Footer statuses ›", "Tool rows ›", "Blocks and agents ›", "Icons ›", "Prompt ›", "Reset to defaults", "Done"]);
	assert.equal(seen[1].title, "Gentle Quiet › Tool rows");
	assert.ok(seen[1].items.includes("Tool call tones: claude"), "the section lists its own options");
	assert.ok(!seen[1].items.some((item) => item.startsWith("Status line")), "and only those");
	assert.equal(seen[1].items.at(-1), "← Back");
	assert.equal(seen[2].title, "Gentle Quiet", "Back returns to the sections");
	assert.equal(seen[3].title, "Gentle Quiet", "Reset keeps the sections open");
	assert.equal(readConfig().yoloBanner, false, "Reset restored and saved the defaults");
});
