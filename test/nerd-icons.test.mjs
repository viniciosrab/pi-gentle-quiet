import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { load, picker, readConfig, writeConfig } from "./helpers.mjs";
import { FOLDER_ROLE, GLYPHS, HUE_ROLES, byExtension, byFileName, file, folder, folderEmpty, folderEmptyOpen, folderOpen, nerdIcon } from "../extensions/sidebar/nerd-icons.ts";

const NERD_FONT = "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf";

// The codepoints a TrueType font maps, from its Windows full-Unicode cmap subtable (format 12).
function cmapCodepoints(bytes) {
	const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tables = data.getUint16(4);
	let cmap;
	for (let i = 0; i < tables; i++) {
		const at = 12 + i * 16;
		if (String.fromCharCode(...bytes.subarray(at, at + 4)) === "cmap") cmap = data.getUint32(at + 8);
	}
	assert.ok(cmap !== undefined, "the font has a cmap");
	const codes = new Set();
	for (let i = 0; i < data.getUint16(cmap + 2); i++) {
		const record = cmap + 4 + i * 8;
		const sub = cmap + data.getUint32(record + 4);
		if (data.getUint16(record) !== 3 || data.getUint16(record + 2) !== 10 || data.getUint16(sub) !== 12) continue;
		for (let g = 0; g < data.getUint32(sub + 12); g++) {
			const group = sub + 16 + g * 12;
			for (let code = data.getUint32(group); code <= data.getUint32(group + 4); code++) codes.add(code);
		}
	}
	return codes;
}

const cp = (icon) => icon.char.codePointAt(0);
const ALL = () => [file, folder, folderOpen, folderEmpty, folderEmptyOpen, ...Object.values(byFileName), ...Object.values(byExtension)];
// What Pi's theme exposes for the nine mini.icons hues and the folders.
const PI_ROLES = new Set(["accent", "text", "muted", "success", "warning", "error", "syntaxFunction", "syntaxNumber", "mdLink", "mdCode"]);

test("every icon is one glyph from the list the build checked, painted with a Pi theme role", () => {
	const checked = new Set(GLYPHS);
	assert.ok(checked.size >= 50, "the build lists the glyphs it checked");
	for (const icon of ALL()) {
		assert.equal([...icon.char].length, 1);
		assert.ok(checked.has(cp(icon)), `U+${cp(icon).toString(16)} was checked in the font`);
		assert.ok(PI_ROLES.has(icon.color), `${icon.color} is a Pi theme role`);
	}
	assert.deepEqual(Object.keys(HUE_ROLES).sort(), ["azure", "blue", "cyan", "green", "grey", "orange", "purple", "red", "yellow"]);
});

test("every listed glyph is in JetBrainsMono Nerd Font", { skip: !existsSync(NERD_FONT) && "the Nerd Font is not installed" }, () => {
	const codes = cmapCodepoints(readFileSync(NERD_FONT));
	for (const code of GLYPHS) assert.ok(codes.has(code), `U+${code.toString(16)} is in the font`);
});

test("the module stays small: only the names and extensions mini.icons maps", () => {
	const source = readFileSync(new URL("../extensions/sidebar/nerd-icons.ts", import.meta.url), "utf8");
	assert.ok(source.length < 40_000, `${source.length} bytes`);
	assert.ok(Object.keys(byExtension).length >= 200, "mini.icons and Neovim's filetype extensions");
});

test("the package ships mini.icons' licence, no icon font and no Symbols or Nerd Fonts notice", () => {
	const { files } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.ok(files.includes("fonts/LICENSE-mini-icons"));
	for (const gone of ["fonts/GentleNerdIcons.ttf", "fonts/LICENSE-nerd-fonts", "fonts/LICENSE-vscode-symbols"]) {
		assert.ok(!files.includes(gone), `${gone} is not shipped`);
		assert.ok(!existsSync(new URL(`../${gone}`, import.meta.url)), `${gone} is removed`);
	}
	assert.match(readFileSync(new URL("../fonts/LICENSE-mini-icons", import.meta.url), "utf8"), /MIT License[\s\S]*Evgeni Chasnovski/);
});

// The expected glyphs and hues are mini.icons 98faae3's answers (MiniIcons.get('file', name)) with LazyVim's options.
test("a file's exact name beats its extension, case-sensitively as mini.icons", () => {
	assert.deepEqual(nerdIcon("README.md"), { char: "\u{F4ED}", color: HUE_ROLES.yellow });
	assert.deepEqual(nerdIcon("notes.md"), { char: "\u{F0354}", color: HUE_ROLES.grey });
	assert.deepEqual(nerdIcon("readme.md"), nerdIcon("notes.md"), "readme.md is not README.md");
	assert.equal(nerdIcon("README.md"), byFileName["README.md"]);
	assert.deepEqual(nerdIcon("LICENSE"), { char: "\u{E60A}", color: HUE_ROLES.cyan });
	assert.deepEqual(nerdIcon("Dockerfile"), { char: "\u{F0868}", color: HUE_ROLES.blue });
	assert.deepEqual(nerdIcon(".gitignore"), { char: "\u{F02A2}", color: HUE_ROLES.purple });
	assert.deepEqual(nerdIcon("devcontainer.json"), { char: "\u{F4B7}", color: HUE_ROLES.azure }, "LazyVim's own entry");
	assert.deepEqual(nerdIcon("package.json"), { char: "\u{F0626}", color: HUE_ROLES.yellow });
});

test("extensions: lowercased, the part after the first dot that is not the leading one, longest first", () => {
	assert.deepEqual(nerdIcon("index.ts"), { char: "\u{F06E6}", color: HUE_ROLES.azure });
	assert.equal(nerdIcon("INDEX.TS"), nerdIcon("index.ts"));
	assert.deepEqual(nerdIcon("app.tsx"), { char: "\u{E7BA}", color: HUE_ROLES.blue });
	assert.equal(nerdIcon("tree.test.ts"), byExtension.ts, "test.ts is not mapped: ts");
	assert.equal(nerdIcon("env.d.ts"), byExtension.ts);
	assert.deepEqual(nerdIcon("backup.tar.gz"), { char: "\u{F05C4}", color: HUE_ROLES.grey });
	assert.equal(nerdIcon(".eslintrc.json"), byExtension.json, "a leading dot does not start the extension");
});

test("a name with no known file name or extension gets mini.icons' default file icon", () => {
	assert.deepEqual(file, { char: "\u{F0214}", color: HUE_ROLES.grey });
	assert.equal(nerdIcon("notes.zzzunknown"), file);
	assert.equal(nerdIcon("x"), file);
	assert.equal(nerdIcon(""), file);
	assert.equal(nerdIcon("constructor"), file, "no prototype keys");
	assert.equal(nerdIcon("a.tostring"), file);
});

test("the nine hues are painted with the closest Pi theme roles", () => {
	assert.deepEqual(HUE_ROLES, { azure: "syntaxFunction", blue: "mdLink", cyan: "mdCode", green: "success", grey: "text", orange: "warning", purple: "syntaxNumber", red: "error", yellow: "warning" });
});

test("folders draw Neo-tree's own icons in its Directory color, whatever their name", () => {
	assert.equal(FOLDER_ROLE, "accent");
	assert.deepEqual(nerdIcon("src", { isDirectory: true }), { char: "\u{E5FF}", color: "accent" });
	assert.deepEqual(nerdIcon("src", { isDirectory: true, open: true }), { char: "\u{E5FE}", color: "accent" });
	assert.deepEqual(nerdIcon("empty", { isDirectory: true, empty: true }), { char: "\u{F0256}", color: "accent" });
	assert.deepEqual(nerdIcon("empty", { isDirectory: true, empty: true, open: true }), { char: "\u{F0DCF}", color: "accent" });
	assert.equal(nerdIcon("package.json", { isDirectory: true }), folder, "a folder never takes a file icon");
	assert.equal(nerdIcon(".git", { isDirectory: true, open: true }), folderOpen);
});

test("/gentle-quiet cycles the TREE icons between emoji and nerd, emoji by default, and saves the choice", async () => {
	writeConfig({});
	const { select, seen } = picker(/^Blocks and agents ›$/, /^Tree icons: emoji/, /^Back|^← Back/);
	const { commands, ctx } = await load({ select });
	await commands["gentle-quiet"].handler("", ctx);
	assert.equal(readConfig().sidebar.treeIcons, "nerd");
	assert.ok(seen.some(({ items }) => items.includes("Tree icons: nerd")), "the menu shows the new state");
	assert.ok(seen.some(({ items }) => items.join("\n").match(/Tree icons/)), "the item is listed");

	const back = picker(/^Blocks and agents ›$/, /^Tree icons: nerd/, /^Back|^← Back/);
	const again = await load({ select: back.select });
	await again.commands["gentle-quiet"].handler("", again.ctx);
	assert.equal(readConfig().sidebar.treeIcons, "emoji");
});

test("a saved \"symbols\" (the old icon font) reads as nerd and cycles on to emoji", async () => {
	writeConfig({ sidebar: { treeIcons: "symbols" } });
	const { select, seen } = picker(/^Blocks and agents ›$/, /^Tree icons: nerd/, /^Back|^← Back/);
	const { commands, ctx } = await load({ select });
	await commands["gentle-quiet"].handler("", ctx);
	assert.ok(seen.some(({ items }) => items.includes("Tree icons: emoji")), "picked from nerd, not from an unknown value");
	assert.equal(readConfig().sidebar.treeIcons, "emoji");
});

test("/gentle-quiet toggles the TREE hidden items between hide and show, hide by default, and saves the choice", async () => {
	writeConfig({});
	const { select, seen } = picker(/^Blocks and agents ›$/, /^Tree hidden items: hide/, /^Back|^← Back/);
	const { commands, ctx } = await load({ select });
	await commands["gentle-quiet"].handler("", ctx);
	assert.equal(readConfig().sidebar.treeHidden, true);
	assert.ok(seen.some(({ items }) => items.includes("Tree hidden items: show")), "the menu shows the new state");

	const back = picker(/^Blocks and agents ›$/, /^Tree hidden items: show/, /^Back|^← Back/);
	const again = await load({ select: back.select });
	await again.commands["gentle-quiet"].handler("", again.ctx);
	assert.equal(readConfig().sidebar.treeHidden, false);
});
