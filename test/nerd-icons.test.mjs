import assert from "node:assert/strict";
import { test } from "node:test";
import { load, picker, readConfig, writeConfig } from "./helpers.mjs";
import { GLYPHS, byExtension, byFileName, byFolderName, byFolderNameOpen, file, folder, folderOpen, nerdIcon } from "../extensions/sidebar/nerd-icons.ts";

const cp = (icon) => icon.char.codePointAt(0);
// Nerd Font's private-use ranges: seti, devicons, codicons, custom (U+E5FA..U+F8FF) and Material Design (U+F0001..).
const nerd = (code) => (code >= 0xe5fa && code <= 0xf8ff) || (code >= 0xf0001 && code <= 0xf1af0);

test("every icon is one Nerd Font glyph from the list the build checked against the font's cmap, with a hex color", () => {
	const checked = new Set(Object.values(GLYPHS));
	assert.ok(checked.size >= 20, "the build lists the glyphs it checked");
	for (const code of checked) assert.ok(nerd(code), `U+${code.toString(16)} is a Nerd Font glyph`);
	const all = [file, folder, folderOpen, ...Object.values(byFileName), ...Object.values(byExtension), ...Object.values(byFolderName), ...Object.values(byFolderNameOpen)];
	for (const icon of all) {
		assert.equal([...icon.char].length, 1);
		assert.ok(checked.has(cp(icon)), `U+${cp(icon).toString(16)} was checked in the font`);
		assert.match(icon.color, /^#[0-9a-f]{6}$/);
	}
});

test("a file's exact name beats its extension, case-insensitively", () => {
	assert.equal(nerdIcon("package.json"), byFileName["package.json"]);
	assert.notDeepEqual(byFileName["package.json"], byExtension.json);
	assert.equal(nerdIcon("README.md"), byFileName["readme.md"]);
	assert.equal(nerdIcon("readme.MD"), byFileName["readme.md"]);
	assert.equal(nerdIcon("Dockerfile"), byFileName.dockerfile);
	assert.equal(nerdIcon("index.TS"), byExtension.ts);
});

test("the longest matching extension wins: test.ts before ts, d.ts before ts", () => {
	assert.equal(nerdIcon("tree.test.ts"), byExtension["test.ts"]);
	assert.equal(nerdIcon("env.d.ts"), byExtension["d.ts"]);
	assert.equal(nerdIcon("util.ts"), byExtension.ts);
	// Symbols tells them apart by color: the test file orange, the types green, the source blue.
	assert.notEqual(byExtension["test.ts"].color, byExtension.ts.color);
	assert.notEqual(byExtension["d.ts"].color, byExtension.ts.color);
	assert.equal(nerdIcon("backup.tar.gz"), byExtension["tar.gz"]);
});

test("a file with no known name or extension gets the default file icon", () => {
	assert.equal(nerdIcon("notes.zzzunknown"), file);
	assert.equal(nerdIcon("LICENSE-whatever"), file);
	assert.equal(nerdIcon(""), file);
	assert.equal(file.char, String.fromCodePoint(GLYPHS["cod-file"]));
});

test("an icon with no Nerd Font counterpart draws the generic file glyph in its own Symbols color", () => {
	// Symbols' vite icon has a glyph; its knip icon has none.
	assert.notEqual(nerdIcon("vite.config.ts").char, file.char);
	const knip = nerdIcon("knip.json");
	assert.equal(knip.char, file.char);
	assert.notEqual(knip.color, file.color);
});

test("folders by name in Symbols' color, drawn as Nerd Font's closed or open folder", () => {
	const closed = String.fromCodePoint(GLYPHS["cod-folder"]);
	const opened = String.fromCodePoint(GLYPHS["cod-folder_opened"]);
	assert.equal(nerdIcon("src", { isDirectory: true }), byFolderName.src);
	assert.equal(nerdIcon("Docs", { isDirectory: true }), byFolderName.docs);
	assert.equal(byFolderName.src.char, closed);
	assert.notEqual(byFolderName.src.color, folder.color);
	const open = nerdIcon("src", { isDirectory: true, open: true });
	assert.equal(open.char, opened);
	assert.equal(open.color, byFolderName.src.color, "opening keeps the folder's color");
	assert.deepEqual(nerdIcon("some-folder", { isDirectory: true }), folder);
	assert.deepEqual(nerdIcon("some-folder", { isDirectory: true, open: true }), folderOpen);
	assert.equal(folder.char, closed);
	assert.equal(folderOpen.char, opened);
	assert.equal(nerdIcon("package.json", { isDirectory: true }), folder, "a folder never takes a file icon");
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
