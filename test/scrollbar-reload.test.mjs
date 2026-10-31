import assert from "node:assert/strict";
import { test } from "node:test";
import { plain } from "./helpers.mjs";

test("/reload installs the new scrollbar patch over the one a previous load left on ScrollView", async () => {
	const { ScrollView } = await import("@earendil-works/pi-tui");
	// What an older gentle-quiet left behind: its own getContentWidth, marked as applied.
	const original = ScrollView.prototype.getContentWidth;
	ScrollView.prototype.getContentWidth = function (width) {
		return this.scrollbar === "auto" && width > 1 ? width - 1 : original.call(this, width);
	};
	ScrollView.prototype[Symbol.for("gentle-quiet.scrollbarColumn")] = true;
	// The chat view Pi created at startup, wrapped by the previous load's glyph map.
	const live = new ScrollView({}, { scrollbar: "auto" });
	const oldGlyphs = { "│": "▕", "┃": "▐" };
	const track = live.scrollbarTrackStyle;
	const thumb = live.scrollbarThumbStyle;
	live.scrollbarTrackStyle = (text) => track(oldGlyphs[text] ?? text);
	live.scrollbarThumbStyle = (text) => thumb(oldGlyphs[text] ?? text);
	live[Symbol.for("gentle-quiet.scrollbarEdge")] = true;
	await import("../extensions/gentle-quiet.ts");
	live.getContentWidth(80);
	assert.equal(plain(live.scrollbarTrackStyle("│")), "\u{1FB75}", "the live view takes the new track glyph");
	assert.equal(plain(live.scrollbarThumbStyle("┃")), "\u{1FB75}", "and the new thumb glyph");
	const view = new ScrollView({}, { scrollbar: "auto" });
	assert.equal(view.getContentWidth(80), 79, "the scrollbar keeps its own column");
	assert.equal(plain(view.scrollbarTrackStyle("│")), "\u{1FB75}", "and centers the thumb without restarting Pi");
	assert.equal(new ScrollView({}, { scrollbar: "always" }).getContentWidth(80), 79);
	assert.equal(new ScrollView({}, { scrollbar: "hidden" }).getContentWidth(80), 80);
});
