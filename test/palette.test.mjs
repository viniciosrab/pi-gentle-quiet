import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { configFile, load } from "./helpers.mjs";

// A stand-in for gentle-pi's command palette files, installed where Pi keeps npm packages.
const agentDir = path.dirname(configFile);
const lib = path.join(agentDir, "npm/node_modules/gentle-pi/lib");
const settingsFile = path.join(agentDir, "settings.json");
mkdirSync(lib, { recursive: true });
writeFileSync(path.join(lib, "command-palette.ts"), `
export class CommandPalette {
	constructor(groups, done, theme, rows) { Object.assign(this, { groups, done, theme, rows }); globalThis.lastPalette = this; }
	render() { return []; }
	invalidate() {}
}
export function commandsKey(env = process.env) {
	const value = env.GENTLE_PI_COMMANDS_KEY?.trim();
	if (value === undefined) return "alt+k";
	return value === "" || value.toLowerCase() === "off" ? undefined : value;
}
`);
writeFileSync(path.join(lib, "command-palette-catalog.ts"), `
export function buildCommandPaletteGroups(registered) {
	const items = registered.filter((command) => command.name.startsWith("gentle:")).map((command) => ({ command: command.name, label: command.name === "gentle:yolo" ? "🚀 YOLO 🔥 session permission" : command.name }));
	return items.length ? [{ title: "Configuration", items }] : [];
}
`);

// gentle-pi installed with Gentle Shell turned off, as the README recommends.
const shellOff = () => writeFileSync(settingsFile, JSON.stringify({ packages: [{ source: "npm:gentle-pi", extensions: ["-extensions/gentle-shell.ts"] }] }));
const commands = [{ name: "gentle:models", description: "Assign models" }, { name: "gentle:doctor", description: "Doctor" }];
const tuiStub = { terminal: { rows: 40 }, requestRender() {} };

test("with Gentle Shell off, alt+k opens gentle-pi's command palette and runs the picked command", async () => {
	shellOff();
	const opened = [];
	const custom = async (factory, options) => {
		let result;
		const palette = factory(tuiStub, { fg: (_role, text) => text }, {}, (value) => (result = value));
		opened.push({ palette, options });
		palette.done({ type: "run", name: "gentle:models" });
		return result;
	};
	const { shortcuts, sent, ctx } = await load({ mode: "tui", custom, session: { commands } });
	assert.ok(shortcuts["alt+k"], "alt+k is registered");
	await shortcuts["alt+k"].handler(ctx);
	assert.equal(opened.length, 1);
	assert.deepEqual(opened[0].palette.groups[0].items.map((item) => item.command), ["gentle:models", "gentle:doctor"]);
	assert.equal(opened[0].options.overlay, true);
	assert.deepEqual(sent, [["/gentle:models", { expandPromptTemplates: true }]]);
});

test("the palette labels lose their emoji", async () => {
	shellOff();
	let palette;
	const custom = async (factory) => {
		let result;
		palette = factory(tuiStub, { fg: (_role, text) => text }, {}, (value) => (result = value));
		palette.done({ type: "close" });
		return result;
	};
	const { shortcuts, sent, ctx } = await load({ mode: "tui", custom, session: { commands: [...commands, { name: "gentle:yolo", description: "YOLO" }] } });
	await shortcuts["alt+k"].handler(ctx);
	assert.deepEqual(palette.groups[0].items.map((item) => item.label), ["gentle:models", "gentle:doctor", "YOLO session permission"]);
	assert.deepEqual(palette.groups[0].items.map((item) => item.command), ["gentle:models", "gentle:doctor", "gentle:yolo"]);
	assert.deepEqual(sent, []);
});

test("closing the palette runs nothing", async () => {
	shellOff();
	const custom = async (factory) => {
		let result;
		factory(tuiStub, { fg: (_role, text) => text }, {}, (value) => (result = value)).done({ type: "close" });
		return result;
	};
	const { shortcuts, sent, ctx } = await load({ mode: "tui", custom, session: { commands } });
	await shortcuts["alt+k"].handler(ctx);
	assert.deepEqual(sent, []);
});

test("without Gentle commands it says so instead of opening an empty palette", async () => {
	shellOff();
	let opened = false;
	const { shortcuts, notices, ctx } = await load({ mode: "tui", custom: async () => (opened = true), session: { commands: [] } });
	await shortcuts["alt+k"].handler(ctx);
	assert.equal(opened, false);
	assert.deepEqual(notices.at(-1), ["No Gentle commands are registered.", "info"]);
});

test("while Gentle Shell is on it keeps alt+k and nothing is registered twice", async () => {
	writeFileSync(settingsFile, JSON.stringify({ packages: ["npm:gentle-pi"] }));
	const { shortcuts } = await load({ mode: "tui", session: { commands } });
	assert.equal(shortcuts["alt+k"], undefined);
});

test("GENTLE_PI_COMMANDS_KEY moves or turns off the shortcut, like in Gentle Shell", async () => {
	shellOff();
	process.env.GENTLE_PI_COMMANDS_KEY = "ctrl+alt+p";
	try {
		const moved = await load({ mode: "tui", session: { commands } });
		assert.ok(moved.shortcuts["ctrl+alt+p"]);
		assert.equal(moved.shortcuts["alt+k"], undefined);
		process.env.GENTLE_PI_COMMANDS_KEY = "off";
		const off = await load({ mode: "tui", session: { commands } });
		assert.deepEqual(Object.keys(off.shortcuts), []);
	} finally {
		delete process.env.GENTLE_PI_COMMANDS_KEY;
	}
});

test("without gentle-pi's palette files no shortcut is registered", async () => {
	shellOff();
	rmSync(path.join(lib, "command-palette.ts"));
	const { shortcuts } = await load({ mode: "tui", session: { commands } });
	assert.deepEqual(Object.keys(shortcuts), []);
});
