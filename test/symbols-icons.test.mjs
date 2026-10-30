import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { load, picker, readConfig, writeConfig } from "./helpers.mjs";
import { byExtension, byFileName, byFolderName, byFolderNameOpen, file, folder, folderOpen, symbolIcon } from "../extensions/sidebar/symbols-icons.ts";

const cp = (icon) => icon.char.codePointAt(0);

test("every Symbols icon is one private-use glyph from U+100100 with a hex color", () => {
	const all = [file, folder, folderOpen, ...Object.values(byFileName), ...Object.values(byExtension), ...Object.values(byFolderName), ...Object.values(byFolderNameOpen)];
	for (const icon of all) {
		assert.equal([...icon.char].length, 1);
		assert.ok(cp(icon) >= 0x100100 && cp(icon) <= 0x10fffd, `U+${cp(icon).toString(16)}`);
		assert.match(icon.color, /^#[0-9a-f]{6}$/);
	}
	assert.ok(existsSync(new URL("../fonts/GentleSymbols.ttf", import.meta.url)), "the font sits next to the module's source");
});

test("a file's exact name beats its extension, case-insensitively", () => {
	assert.equal(symbolIcon("package.json"), byFileName["package.json"]);
	assert.notEqual(byFileName["package.json"], byExtension.json);
	assert.equal(symbolIcon("README.md"), byFileName["readme.md"]);
	assert.equal(symbolIcon("Dockerfile"), byFileName.dockerfile);
	assert.equal(symbolIcon("index.TS"), byExtension.ts);
});

test("the longest matching extension wins: test.ts before ts, d.ts before ts", () => {
	assert.equal(symbolIcon("tree.test.ts"), byExtension["test.ts"]);
	assert.equal(symbolIcon("env.d.ts"), byExtension["d.ts"]);
	assert.equal(symbolIcon("util.ts"), byExtension.ts);
	assert.notEqual(byExtension["test.ts"], byExtension.ts);
	assert.notEqual(byExtension["d.ts"], byExtension.ts);
	assert.equal(symbolIcon("backup.tar.gz"), byExtension["tar.gz"]);
});

test("a file with no known name or extension gets the default file icon", () => {
	assert.equal(symbolIcon("notes.zzzunknown"), file);
	assert.equal(symbolIcon("LICENSE-whatever"), file);
	assert.equal(symbolIcon(""), file);
});

test("folders by name, open or closed, with the default folder icons otherwise", () => {
	assert.equal(symbolIcon("src", { isDirectory: true }), byFolderName.src);
	assert.equal(symbolIcon("Docs", { isDirectory: true }), byFolderName.docs);
	assert.notEqual(byFolderName.src, folder);
	// Symbols has no open variants: an open folder keeps its closed icon.
	assert.equal(symbolIcon("src", { isDirectory: true, open: true }), byFolderNameOpen.src ?? byFolderName.src);
	assert.equal(symbolIcon("some-folder", { isDirectory: true }), folder);
	assert.equal(symbolIcon("some-folder", { isDirectory: true, open: true }), folderOpen);
	assert.equal(symbolIcon("package.json", { isDirectory: true }), folder, "a folder never takes a file icon");
});

test("/gentle-quiet picks the TREE icons, emoji by default, and saves the choice", async () => {
	writeConfig({});
	const { select, seen } = picker(/^Blocks and agents ›$/, /^Tree icons: emoji/, /^Back|^← Back/);
	const { commands, ctx } = await load({ select });
	await commands["gentle-quiet"].handler("", ctx);
	assert.equal(readConfig().sidebar.treeIcons, "symbols");
	assert.ok(seen.some(({ items }) => items.includes("Tree icons: symbols")), "the menu shows the new state");

	const back = picker(/^Blocks and agents ›$/, /^Tree icons: symbols/, /^Back|^← Back/);
	const again = await load({ select: back.select });
	await again.commands["gentle-quiet"].handler("", again.ctx);
	assert.equal(readConfig().sidebar.treeIcons, "emoji");
});
