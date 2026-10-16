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
	assert.ok(screens[0].includes(" → Status line: gentle"), "first tab's first option selected");
	assert.match(tabBar(screens[1]), /\[ Tools \]/, "→ moves to the next tab");
	assert.ok(screens[1].includes(" → Tool rows: quiet (new calls)"));
	assert.ok(screens[2].includes(" → Tool call tones: theme"), "enter changes the option in place and the screen stays open");
	assert.equal(readConfig().tools.tones, "theme", "and it is saved");
	assert.ok(screens[0].some((line) => line.includes("←→ tabs")), "key hints at the bottom");
});

test("the selected option's caption hangs under it and follows the selection", async () => {
	writeConfig({});
	const loaded = await load({ mode: "tui", session: { model: { id: "m", provider: "claude-bridge" } } });
	const keys = { right: "\x1b[C", down: "\x1b[B", escape: "\x1b" };
	const screens = [];
	loaded.ui.custom = (factory) => new Promise((resolve) => {
		const component = factory({ requestRender() {} }, { ...theme, bg: (_name, text) => text }, {}, resolve);
		const view = () => component.render(100).map(plain);
		screens.push(view());
		component.handleInput(keys.down); // Status line changes
		screens.push(view());
		component.handleInput(keys.right); // Footer → Memory in footer
		screens.push(view());
		component.handleInput(keys.escape);
	});
	await loaded.commands["gentle-quiet"].handler("", loaded.ctx);
	// The caption hangs right under the selected row: "   └ text", continued on "     text".
	const help = (screen) => {
		const at = screen.findIndex((line) => line.startsWith(" → "));
		const rows = [];
		for (let i = at + 1; i < screen.length && /^ {3}[└ ] \S/.test(screen[i]); i++) rows.push(screen[i].slice(5));
		return rows.length && screen[at + 1].startsWith("   └ ") ? rows.join(" ") : undefined;
	};
	assert.equal(help(screens[0]), "Which footer shows under the editor. Now: this extension's status line.");
	assert.equal(help(screens[1]), "Files and lines changed since the last commit, such as ±2 +3 -1.");
	assert.equal(help(screens[2]), "Engram memory activity among the statuses, such as mem 4 results.");
	for (const screen of screens) assert.ok(screen.every((line) => line.length <= 100), "fits the width");
});

test("every option in every tab has a description", async () => {
	writeConfig({});
	const loaded = await load({ mode: "tui", session: { model: { id: "m", provider: "claude-bridge" } } });
	const missing = [];
	loaded.ui.custom = (factory) => new Promise((resolve) => {
		const component = factory({ requestRender() {} }, { ...theme, bg: (_name, text) => text }, {}, resolve);
		for (let tab = 0; tab < 7; tab++) {
			const first = component.render(100).map(plain).find((line) => line.startsWith(" → "));
			let label = first;
			do {
				const screen = component.render(100).map(plain);
				label = screen.find((line) => line.startsWith(" → "));
				if (!screen[screen.indexOf(label) + 1]?.startsWith("   └ ")) missing.push(label);
				component.handleInput("\x1b[B");
			} while (component.render(100).map(plain).find((line) => line.startsWith(" → ")) !== first);
			component.handleInput("\x1b[C");
		}
		component.handleInput("\x1b");
	});
	await loaded.commands["gentle-quiet"].handler("", loaded.ctx);
	assert.deepEqual(missing, []);
});

test("a caption follows the current value of an option that cycles", async () => {
	writeConfig({});
	const loaded = await load({ mode: "tui" });
	const captions = [];
	loaded.ui.custom = (factory) => new Promise((resolve) => {
		const component = factory({ requestRender() {} }, { ...theme, bg: (_name, text) => text }, {}, resolve);
		for (let i = 0; i < 4; i++) component.handleInput("\x1b[B"); // Status line tokens
		const caption = () => component.render(120).map(plain).find((line) => line.startsWith("   └ "));
		captions.push(caption());
		component.handleInput("\r");
		setTimeout(() => {
			captions.push(caption());
			component.handleInput("\x1b");
		}, 50);
	});
	await loaded.commands["gentle-quiet"].handler("", loaded.ctx);
	assert.deepEqual(captions, [
		"   └ Token counts in the status line. Now: cache reads, writes and hit rate.",
		"   └ Token counts in the status line. Now: input and output tokens plus the cache figures.",
	]);
});
