import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { plain, role, theme } from "./helpers.mjs";
import { openPreview } from "../extensions/sidebar/tree-preview.ts";

// Like Pi's TUI (which pi-tui does not export): compositeOverlays copies the base lines, pads them to the
// terminal height and draws each visible overlay over them, here as whole rows from the top.
class StubTUI {
	constructor() {
		this.terminal = { rows: 12, columns: 100 };
		this.overlayStack = [];
	}
	requestRender() {}
	isOverlayVisible(entry) {
		return !entry.hidden;
	}
	compositeOverlays(lines, termWidth, termHeight) {
		this.received = lines;
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];
		while (result.length < termHeight) result.push("");
		let row = 0;
		for (const entry of this.overlayStack.filter((e) => this.isOverlayVisible(e))) {
			for (const line of entry.component.render(70)) result[row++] = line;
		}
		return result;
	}
}

const RED = "\x1b[31m";
const IMAGE = "\x1b_Ga=T,f=100;AAAA\x1b\\";
// The conversation under the pop-up: colored rows, a blank one and an inline image.
const BASE = Array.from({ length: 16 }, (_, i) => `${RED}row ${i}\x1b[39m \x1b[1mbold\x1b[22m`);
BASE[15] = "";
BASE[14] = IMAGE;

function file(name, content) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gq-backdrop-"));
	const full = path.join(dir, name);
	writeFileSync(full, content);
	return full;
}

async function open(tui, name, paint = theme) {
	let component;
	const ctx = {
		hasUI: true,
		ui: {
			custom: (factory) => {
				component = factory(tui, paint, {}, () => {});
				tui.overlayStack.push({ component });
				return new Promise(() => {});
			},
		},
	};
	assert.equal(openPreview(ctx, { file: file(name, "# Title\n\nSome *text*.\n"), relPath: name, onEdit: () => {} }), true);
	await component.ready;
	return component;
}

// A screen as tall as the base lines unless `height` says otherwise.
const draw = (tui, height = BASE.length) => tui.compositeOverlays(BASE, 100, height);
// The base rows the overlay leaves visible, under its last row.
const under = (tui, rows) => draw(tui).slice(rows);

test("a Markdown preview dims every base line under it; the overlay keeps its colors", async () => {
	const tui = new StubTUI();
	const preview = await open(tui, "README.md");
	const out = draw(tui);
	const rows = preview.render(70).length;
	assert.deepEqual(out.slice(0, rows), preview.render(70), "the overlay is drawn as it renders");
	const base = out.slice(rows);
	for (const [i, line] of base.entries()) {
		const original = BASE[rows + i] ?? "";
		if (original === IMAGE) assert.equal(line, IMAGE, "an image line stays as it is");
		else if (!plain(original).trim()) assert.equal(line, plain(original), "a blank line stays blank");
		else {
			assert.ok(!line.includes(RED) && !line.includes("\x1b[1m"), `no original color left: ${JSON.stringify(line)}`);
			assert.equal(line, `\x1b[38;2;31;31;31m${plain(original)}\x1b[39m`, "painted a fixed near-black #1f1f1f whatever the theme, as wide as before");
		}
	}
});

test("the source view of a Markdown file dims too; closing the preview restores the base lines", async () => {
	const tui = new StubTUI();
	const preview = await open(tui, "notes.markdown");
	preview.handleInput("m");
	const rows = preview.render(70).length;
	assert.ok(under(tui, rows).some((line) => line.startsWith("\x1b[38;2;31;31;31m")));
	tui.overlayStack.pop();
	assert.deepEqual(draw(tui), BASE, "no overlay: the lines as they were");
	tui.overlayStack.push({ component: preview, hidden: true });
	assert.deepEqual(draw(tui).slice(0, BASE.length), BASE, "a hidden preview dims nothing");
	const proto = Object.getPrototypeOf(tui);
	const wrapped = proto.compositeOverlays;
	await open(tui, "again.md");
	assert.equal(proto.compositeOverlays, wrapped, "patched once per process");
});

test("only the lines on screen dim: the scrollback above stays as it is", async () => {
	const tui = new StubTUI();
	await open(tui, "README.md");
	// A 12-row screen over 16 lines: the screen starts at line 4.
	tui.compositeOverlays(BASE, 100, 12);
	assert.deepEqual(tui.received.slice(0, 4), BASE.slice(0, 4), "above the screen: untouched");
	assert.equal(tui.received[4], `\x1b[38;2;31;31;31m${plain(BASE[4])}\x1b[39m`, "on the screen: near-black");
});

test("a non-Markdown preview and other pop-ups leave the base lines byte-identical", async () => {
	const tui = new StubTUI();
	const preview = await open(tui, "app.ts");
	const rows = preview.render(70).length;
	assert.deepEqual(under(tui, rows), BASE.slice(rows));
	tui.overlayStack.length = 0;
	tui.overlayStack.push({ component: { render: () => ["Music"], invalidate() {} } });
	assert.deepEqual(under(tui, 1), BASE.slice(1));
});

test("without a theme the base lines go near-black too; an error in the backdrop falls back to Pi's output", async () => {
	const bare = new StubTUI();
	const preview = await open(bare, "a.md", {});
	const rows = preview.render(70).length;
	assert.equal(under(bare, rows)[0], `\x1b[38;2;31;31;31m${plain(BASE[rows])}\x1b[39m`);

	const broken = new StubTUI();
	const failing = await open(broken, "b.md", {});
	const at = failing.render(70).length;
	Object.defineProperty(failing, Symbol.for("gentle-quiet.backdrop"), {
		get() {
			throw new Error("broken backdrop");
		},
	});
	assert.deepEqual(under(broken, at), BASE.slice(at), "the original lines, rendering not broken");
});
