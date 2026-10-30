import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { configFile, lines, load, painted, theme } from "./helpers.mjs";

// Stand-ins for gentle-pi's image paste files, installed where Pi keeps npm packages. They follow
// gentle-pi's interface: the clipboard read resolves to the image or null, and ImageAttachments
// numbers the [Image#N] chips and turns the ones still in the draft into attachments on submit.
const agentDir = path.dirname(configFile);
const lib = path.join(agentDir, "npm/node_modules/gentle-pi/lib");
const settingsFile = path.join(agentDir, "settings.json");
mkdirSync(lib, { recursive: true });
const writeLib = () => {
	writeFileSync(path.join(lib, "clipboard-image.ts"), `
export async function readClipboardImage() { globalThis.clipboardReads = (globalThis.clipboardReads ?? 0) + 1; return globalThis.clipboardImage ?? null; }
`);
	writeFileSync(path.join(lib, "image-attachments.ts"), `
const PATTERN = /\\[Image#(\\d+)\\]/g;
export class ImageAttachments {
	entries = new Map();
	counter = 0;
	get size() { return this.entries.size; }
	add(image) {
		const id = ++this.counter;
		const attachment = { id, token: "[Image#" + id + "]", mimeType: image.mimeType, byteLength: image.bytes.length, base64: Buffer.from(image.bytes).toString("base64") };
		this.entries.set(id, attachment);
		return attachment;
	}
	referenced(text) {
		return [...new Set([...text.matchAll(PATTERN)].map((match) => Number(match[1])))].map((id) => this.entries.get(id)).filter(Boolean);
	}
	submit(text, accepts, currentDraft = "") {
		const sent = this.referenced(text);
		const keep = new Set(this.referenced(currentDraft).map((attachment) => attachment.id));
		for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.entries.delete(id);
		if (sent.length === 0) return undefined;
		if (accepts) return { text, images: sent.map((attachment) => ({ type: "image", data: attachment.base64, mimeType: attachment.mimeType })), omitted: 0 };
		return { text: text.replace(PATTERN, (token) => token.slice(0, -1) + " omitted]"), images: [], omitted: sent.length };
	}
	clear() { this.entries.clear(); }
	segment(text, segments) { globalThis.segmented = text; return segments; }
}
export function describeAttachment(attachment) { return attachment.mimeType.replace("image/", "") + " · " + attachment.byteLength + " B"; }
`);
};
writeLib();

const shellOff = () => writeFileSync(settingsFile, JSON.stringify({ packages: [{ source: "npm:gentle-pi", extensions: ["-extensions/gentle-shell.ts"] }] }));
const png = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" };
const tuiStub = () => ({ renders: 0, requestRender() { this.renders++; } });
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Pi's side of a custom editor: build it, then wire its own paste handler, as Pi does after construction. */
function promptEditor(factory, tui = tuiStub()) {
	const editor = factory(tui, {}, {});
	const pi = { pastes: 0 };
	if (!editor.onPasteImage) editor.onPasteImage = () => pi.pastes++;
	editor.setText("look at ");
	return { editor, pi, tui };
}

async function session(options = {}) {
	shellOff();
	globalThis.clipboardImage = options.clipboard === undefined ? png : options.clipboard;
	globalThis.clipboardReads = 0;
	const loaded = await load({ mode: "tui", session: options.session });
	return { ...loaded, ...promptEditor(loaded.editor()) };
}

const widget = (widgets) => widgets["gentle-quiet-images"]?.({}, theme);

test("pasting an image puts gentle-pi's [Image#1] chip in the draft instead of the file path", async () => {
	const { editor, pi, tui } = await session();
	editor.onPasteImage();
	await flush();
	assert.equal(editor.getText(), "look at [Image#1]");
	assert.equal(pi.pastes, 0, "Pi's own paste (temp file + path) does not run");
	assert.ok(tui.renders > 0, "the prompt redraws with the chip");
});

test("the chip sits apart from the word before it", async () => {
	const { editor } = await session();
	editor.setText("look");
	editor.onPasteImage();
	await flush();
	assert.equal(editor.getText(), "look [Image#1]");
});

test("without an image in the clipboard Pi's own paste runs (files, text)", async () => {
	const { editor, pi } = await session({ clipboard: null });
	editor.onPasteImage();
	await flush();
	assert.equal(pi.pastes, 1);
	assert.equal(editor.getText(), "look at ");
});

test("a second paste key while the clipboard is still being read inserts nothing more", async () => {
	const { editor } = await session();
	editor.onPasteImage();
	editor.onPasteImage();
	await flush();
	assert.equal(globalThis.clipboardReads, 1);
	assert.equal(editor.getText(), "look at [Image#1]");
});

test("a paste read that finishes after the draft was sent is dropped with a notice", async () => {
	const { editor, notices } = await session();
	editor.onPasteImage();
	editor.submitValue();
	await flush();
	assert.equal(editor.getText(), "", "the next draft stays empty");
	assert.match(notices.at(-1)[0], /Image paste discarded/);
});

test("the editor's segmentation goes through gentle-pi's chips, so a chip moves and deletes as one unit", async () => {
	const { editor } = await session();
	const segments = [...editor.segment("a [Image#1]")];
	assert.equal(globalThis.segmented, "a [Image#1]");
	assert.equal(segments.length, 11);
});

test("the chip list above the prompt: token in accent, description dimmed, at Pi's margin", async () => {
	const { editor, widgets } = await session();
	assert.deepEqual(widget(widgets).render(80), [], "nothing while the draft holds no chip");
	editor.onPasteImage();
	await flush();
	const rows = widget(widgets).render(80);
	assert.deepEqual(rows.map((row) => row.replace(/\x1b\[[0-9;:]*m/g, "")), [" [Image#1] png · 4 B"]);
	assert.ok(painted(rows[0], "accent", "[Image#1]"));
	assert.ok(painted(rows[0], "dim", "png · 4 B"));
	editor.setText("look at ");
	assert.deepEqual(widget(widgets).render(80), [], "a chip deleted from the draft leaves the list");
});

test("the thumbnail shows under the chip while idle in a terminal with an image protocol", async () => {
	globalThis.testImageProtocol = "kitty";
	try {
		const { editor, widgets, ctx } = await session();
		editor.onPasteImage();
		await flush();
		ctx.isIdle = () => true;
		assert.deepEqual(lines(widget(widgets)), [" [Image#1] png · 4 B", " <image image/png 40x6>", " "]);
		ctx.isIdle = () => false; // while the agent streams, labels only
		assert.deepEqual(lines(widget(widgets)), [" [Image#1] png · 4 B"]);
	} finally {
		delete globalThis.testImageProtocol;
	}
});

test("on submit the chips still in the draft travel as real image attachments", async () => {
	const { editor, emit, ctx } = await session();
	editor.onPasteImage();
	await flush();
	ctx.model = { input: ["text", "image"] };
	editor.setText(""); // Pi empties the draft before the input handlers run
	assert.deepEqual(await emit("input", { source: "interactive", text: "look at [Image#1]" }), [{ action: "transform", text: "look at [Image#1]", images: [{ type: "image", data: Buffer.from(png.bytes).toString("base64"), mimeType: "image/png" }] }]);
});

test("a model without image input gets a note instead of the image, and a warning", async () => {
	const { editor, emit, ctx, notices, widgets } = await session();
	editor.onPasteImage();
	await flush();
	ctx.model = { input: ["text"] };
	assert.match(lines(widget(widgets))[0], /not sent: the current model does not accept images/);
	editor.setText("");
	const [result] = await emit("input", { source: "interactive", text: "look at [Image#1]" });
	assert.deepEqual(result, { action: "transform", text: "look at [Image#1 omitted]", images: [] });
	assert.match(notices.at(-1)[0], /1 pasted image was not sent/);
});

test("prompts without chips, and prompts from other sources, pass through untouched", async () => {
	const { editor, emit } = await session();
	assert.deepEqual(await emit("input", { source: "interactive", text: "hi" }), [{ action: "continue" }]);
	editor.onPasteImage();
	await flush();
	assert.deepEqual(await emit("input", { source: "extension", text: "look at [Image#1]" }), [{ action: "continue" }]);
});

test("while Gentle Shell is on it keeps the image paste: Pi's handler stays in place", async () => {
	writeFileSync(settingsFile, JSON.stringify({ packages: ["npm:gentle-pi"] }));
	const loaded = await load({ mode: "tui" });
	const { editor, pi } = promptEditor(loaded.editor());
	editor.onPasteImage();
	assert.equal(pi.pastes, 1);
	assert.equal(loaded.widgets["gentle-quiet-images"], undefined);
});

test("without gentle-pi's image files Pi's own paste stays in place", async () => {
	rmSync(path.join(lib, "image-attachments.ts"));
	try {
		shellOff();
		const loaded = await load({ mode: "tui" });
		const { editor, pi } = promptEditor(loaded.editor());
		editor.onPasteImage();
		assert.equal(pi.pastes, 1);
		assert.equal(loaded.widgets["gentle-quiet-images"], undefined);
	} finally {
		writeLib();
	}
});
