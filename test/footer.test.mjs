import assert from "node:assert/strict";
import { test } from "node:test";
import { load, painted, plain, readConfig, picker, theme, writeConfig } from "./helpers.mjs";

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

test("the background jobs status shows Pi's braille spinner and keeps the count", async () => {
	const { ui, status } = await load();
	ui.setStatus("gentle-jobs", "⧗ 1 job");
	assert.equal(status["gentle-jobs"], "⠋ 1 job", "the stored status keeps the first frame");
	ui.setStatus("gentle-jobs", "⧗ 3 jobs");
	assert.equal(status["gentle-jobs"], "⠋ 3 jobs");
	ui.setStatus("gentle-jobs", undefined);
	assert.equal(status["gentle-jobs"], undefined, "no jobs clears the status");
	ui.setStatus("gentle-jobs", "2 jobs");
	assert.equal(status["gentle-jobs"], "2 jobs", "text without the hourglass is left as it is");
});

test("YOLO banner is hidden in the footer and above the editor", async () => {
	const { ui, status, widgets } = await load();
	ui.setStatus("gentle:yolo", "🚀 YOLO ON 🔥 — destructive confirmations remain");
	ui.setWidget("gentle:yolo", ["🚀 YOLO ON 🔥"]);
	assert.equal(status["gentle:yolo"], undefined);
	assert.equal(widgets["gentle:yolo"], undefined);
});

test("the /yolo notification is hidden with the banner; other notifications pass through", async () => {
	const { ui, notices } = await load();
	ui.notify("🚀 YOLO ON 🔥 — destructive confirmations remain", "warning");
	ui.notify("Saved", "info");
	assert.deepEqual(notices, [["Saved", "info"]]);
});

test("with the banner shown, the /yolo notification is shown too", async () => {
	writeConfig({ yoloBanner: true });
	const { ui, notices } = await load();
	ui.notify("🚀 YOLO ON 🔥", "warning");
	assert.deepEqual(notices, [["🚀 YOLO ON 🔥", "warning"]]);
	writeConfig({});
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

test("in the terminal /gentle-quiet is one screen with horizontal tabs", async () => {
	writeConfig({});
	const loaded = await load({ mode: "tui" });
	const keys = { left: "\x1b[D", right: "\x1b[C", down: "\x1b[B", enter: "\r", escape: "\x1b" };
	const screens = [];
	loaded.ui.custom = (factory) => new Promise((resolve) => {
		const tui = { requestRender() {} };
		const component = factory(tui, { ...theme, bg: (_name, text) => `[${plain(text)}]` }, {}, resolve);
		const view = () => component.render(80).map(plain);
		screens.push(view());
		component.handleInput(keys.right); // Footer
		component.handleInput(keys.right); // Tools
		screens.push(view());
		component.handleInput(keys.down); // Tool row margin
		component.handleInput(keys.down); // Tool call tones
		component.handleInput(keys.enter);
		setTimeout(() => {
			screens.push(view());
			component.handleInput(keys.escape);
		}, 50);
	});
	await loaded.commands["gentle-quiet"].handler("", loaded.ctx);
	const tabBar = (screen) => screen.find((line) => line.includes("Status") && line.includes("Prompt"));
	assert.equal(tabBar(screens[0]).trim(), "[ Status ]  Footer   Tools   Blocks   Icons   Prompt   Reset", "tabs side by side, the active one highlighted");
	assert.ok(screens[0].some((line) => /^ → Status line +gentle$/.test(line)), "first tab's first option selected");
	assert.match(tabBar(screens[1]), /\[ Tools \]/, "→ moves to the next tab");
	assert.ok(screens[1].some((line) => /^ → Tool rows +quiet \(new calls\)$/.test(line)));
	assert.ok(screens[2].some((line) => /^ → Tool call tones +theme$/.test(line)), "enter changes the option in place and the screen stays open");
	assert.equal(readConfig().tools.tones, "theme", "and it is saved");
	assert.ok(screens[0].some((line) => line.includes("←→ tabs")), "key hints at the bottom");
});

// Pi's own settings list: labels and values in two aligned columns, the selected option's description
// under the list in the dim role, set off by a blank row.
async function menu(steps, width = 100, session = { model: { id: "m", provider: "claude-bridge" } }) {
	writeConfig({});
	const loaded = await load({ mode: "tui", session });
	const screens = [];
	loaded.ui.custom = (factory) => new Promise((resolve) => {
		const component = factory({ requestRender() {} }, { ...theme, bg: (_name, text) => text }, {}, resolve);
		const run = async () => {
			for (const step of steps) {
				if (step === "view") screens.push(component.render(width));
				else if (step === "wait") await new Promise((done) => setTimeout(done, 50));
				else component.handleInput(step);
			}
			component.handleInput("\x1b");
		};
		void run();
	});
	await loaded.commands["gentle-quiet"].handler("", loaded.ctx);
	return screens;
}
const KEY = { right: "\x1b[C", down: "\x1b[B", enter: "\r" };
/** The description rows: dim rows between the list and the key hints. */
const description = (screen) => {
	const rows = screen.filter((line) => painted(line, "dim") && !plain(line).includes("←→ tabs"));
	return rows.length ? rows.map((line) => plain(line).trim()).join(" ") : undefined;
};

test("options are laid out like Pi's settings: label and value columns, the description under the list", async () => {
	const [screen] = await menu([KEY.down, "view"]);
	const rows = screen.map(plain);
	const at = rows.findIndex((line) => line.startsWith(" → "));
	// The longest label, "Estimated cost (unpriced providers)", sets the column; values start two after it.
	const row = (cursor, label, value) => ` ${cursor}${label.padEnd(35)}  ${value}`;
	assert.equal(rows[at], row("→ ", "Status line changes", "on"));
	assert.equal(rows[at - 1], row("  ", "Status line", "gentle"));
	assert.equal(rows[at + 1], row("  ", "Status line usage", "on"));
	const hints = rows.findIndex((line) => line.includes("←→ tabs"));
	assert.deepEqual(rows.slice(hints - 3, hints), ["", "   Files and lines changed since the last commit, such as ±2 +3 -1.", ""]);
	assert.ok(painted(screen[hints - 2], "dim"), "description in the dim role");
	assert.ok(painted(screen[at], "accent", "Status line changes"), "selected label in accent");
	assert.ok(painted(screen[at + 1], "muted", "on"), "other values muted");
});

test("the description follows the selection across tabs", async () => {
	const screens = await menu(["view", KEY.down, "view", KEY.right, "view"]);
	assert.deepEqual(screens.map(description), [
		"Which footer shows under the editor. Now: this extension's status line.",
		"Files and lines changed since the last commit, such as ±2 +3 -1.",
		"Engram memory activity among the statuses, such as mem 4 results.",
	]);
});

test("a description follows the current value of an option that cycles", async () => {
	const screens = await menu([KEY.down, KEY.down, KEY.down, KEY.down, "view", KEY.enter, "wait", "view"]);
	assert.deepEqual(screens.map(description), [
		"Token counts in the status line. Now: cache reads, writes and hit rate.",
		"Token counts in the status line. Now: input and output tokens plus the cache figures.",
	]);
});

test("a long description wraps under the list within the width", async () => {
	const [screen] = await menu([...Array(6).fill(KEY.down), "view"], 60);
	const rows = screen.map(plain);
	assert.equal(description(screen), "Prices responses billed at $0 (claude-bridge) at the same model's Anthropic API rates. An estimate, not a charge.");
	assert.ok(screen.filter((line) => painted(line, "dim")).length > 2, "wrapped over several rows");
	assert.ok(rows.every((line) => line.length <= 60));
});

test("every option in every tab has a description", async () => {
	const steps = [];
	for (let tab = 0; tab < 7; tab++) {
		for (let row = 0; row < 12; row++) steps.push("view", KEY.down);
		steps.push(KEY.right);
	}
	const screens = await menu(steps);
	const missing = screens.filter((screen) => !description(screen)).map((screen) => plain(screen.find((line) => plain(line).startsWith(" → ")) ?? ""));
	assert.deepEqual([...new Set(missing)], []);
});
