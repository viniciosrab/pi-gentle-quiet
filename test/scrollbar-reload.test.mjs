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
	await import("../extensions/gentle-quiet.ts");
	const view = new ScrollView({}, { scrollbar: "auto" });
	assert.equal(view.getContentWidth(80), 79, "the scrollbar keeps its own column");
	assert.equal(plain(view.scrollbarTrackStyle("│")), "▐", "and hugs the right edge without restarting Pi");
	assert.equal(new ScrollView({}, { scrollbar: "always" }).getContentWidth(80), 79);
	assert.equal(new ScrollView({}, { scrollbar: "hidden" }).getContentWidth(80), 80);
});
