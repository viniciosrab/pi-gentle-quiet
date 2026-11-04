// The scrollbar of gentle-quiet's pop-ups (the TREE / MEM / GIT preview in ./tree-preview.ts, the live pop-up in
// ./run-popup.ts, the music picker and the model picker), drawn and dragged as Pi draws and drags its own: one
// column, the cell just before the right stroke of each body row, shown only while the body does not fit. Its thumb
// is sized and placed as pi-tui's getScrollbarGeometry places it (layout.js), and a press on it, or on its track,
// works as pi-tui's scrollbar does (tui-alt-screen.js handleScrollbarMouseEvent): a press on the thumb grabs it
// where it was pressed, one on the track puts the thumb's middle there, each drag moves it after the pointer
// (clamped, past the ends and outside the box too) and the release lets it go. The view does not jump to where the
// pointer puts it: Pi reports the mouse by cell, and a cell of a long file's track is many lines, so a press on the
// track or a drag glides the view there, a frame each FRAME_MS, each a third of the lines left (at least one, so it
// ends line by line and never lags far behind a fast drag). A new target retargets the glide; the release lets it
// finish; it stops when the pop-up closes or when something else (the wheel, a key) moved the view. The press asks Pi for the mouse
// (capture), so the drag and the release come here; the click Pi sends after a press and release that did not
// move is swallowed, so it does nothing else. As Pi's own, the pointer resting on the bar's column, within its track,
// grows the thumb, and leaving the column gives it back; Pi sends an overlay only the events inside its box, so each
// pop-up also ends the hover when an event hits no overlay or another one (leave, from its closeOnOutsidePress).
// The glyphs are the ones this extension gives Pi's own conversation scrollbar (../gentle-quiet.ts hugRightEdge):
// the track and the idle thumb U+1FB75, the hovered or held thumb U+1FB88, in the theme's scrollbarTrack and
// scrollbarThumb. A diff's overview ruler (./tree-preview.ts) draws no glyph thumb: there the thumb is scrollbarThumb
// at 60%, two columns wide (the ruler and the gap before it, both taking presses), laid over the ruler's marks, which
// show through it dimmed, as VS Code's slider.
// @ts-nocheck

export const TRACK = "\u{1FB75}";
export const HELD = "\u{1FB88}";
export const FRAME_MS = 16; // a glide's frame

// The glide's timer, swapped by tests to run its frames by hand.
export const scrollbarDeps = {
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (timer) => clearInterval(timer),
};

const paint = (theme, role, text) => {
	try {
		return theme?.fg ? theme.fg(role, text) : text;
	} catch {
		return text;
	}
};

/**
 * The geometry of a scrollbar `height` rows tall over `total` rows scrolled to `top`, as pi-tui's:
 * { height, total, maxTop, thumbTop, thumbHeight }, thumbTop counted from the track's top; undefined when they fit.
 */
export function scrollbarGeometry(height, total, top) {
	if (!(height > 0) || !(total > height)) return undefined;
	const thumbHeight = Math.max(Math.min(2, height), Math.min(height, Math.round((height * height) / total)));
	const maxTop = total - height;
	const thumbTop = maxTop === 0 ? 0 : Math.round((Math.max(0, Math.min(maxTop, top)) / maxTop) * (height - thumbHeight));
	return { height, total, maxTop, thumbTop, thumbHeight };
}

/** The theme's selectedBg as the escape that sets it, for a shade behind a cell; "" when the theme has none. */
export function shadeOf(theme) {
	try {
		const open = typeof theme?.getBgAnsi === "function" ? theme.getBgAnsi("selectedBg") : typeof theme?.bg === "function" ? theme.bg("selectedBg", "\0").split("\0")[0] : "";
		return open && open !== "\x1b[49m" ? open : "";
	} catch {
		return "";
	}
}

/** One pop-up's scrollbar: where its last render put it, and the drag in progress. */
export class Scrollbar {
	constructor() {
		this.at = undefined; // { column, width, trackTop, height, total } of the last render, while the body does not fit
		this.drag = undefined; // { grab, x, y, moved } while the thumb is held
		this.clickPending = false; // the click Pi sends after a press and release on the bar
		this.hover = false; // the pointer on the bar
		this.seen = false; // set by every event handleMouse gets: see leave()
		this.glide = undefined; // { target, set, scrollTo, currentTop, timer } while the view glides
	}

	/**
	 * Places the bar for a render: in `column`, from row `trackTop`, `height` rows over `total`, scrolled to `top`;
	 * `hover: false` for a bar with no thumb glyph to grow; `width` columns ending at `column` take its presses (a
	 * diff's ruler, whose thumb is two columns wide). Returns its `height` cells, painted, or undefined when the body
	 * fits (no bar).
	 */
	place({ column, trackTop, height, total, top, hover = true, width = 1 }, theme) {
		const geometry = scrollbarGeometry(height, total, top);
		this.at = geometry ? { column, width, trackTop, height, total, hover } : undefined;
		if (!geometry || !hover) this.hover = false;
		if (!geometry) return undefined;
		return Array.from({ length: height }, (_, row) => (this.onThumb(geometry, row) ? this.thumbCell(theme) : paint(theme, "scrollbarTrack", TRACK)));
	}

	/** The geometry the bar last placed has at `top`; undefined when there is no bar. */
	geometry(top) {
		return this.at ? scrollbarGeometry(this.at.height, this.at.total, top) : undefined;
	}

	// Whether `x` is one of the bar's columns.
	onColumn(x) {
		return x <= this.at.column && x > this.at.column - this.at.width;
	}

	onThumb(geometry, row) {
		return row >= geometry.thumbTop && row < geometry.thumbTop + geometry.thumbHeight;
	}

	/** A thumb cell: the idle glyph, or the wider one while hovered or held, in scrollbarThumb. */
	thumbCell(theme) {
		return paint(theme, "scrollbarThumb", this.drag || this.hover ? HELD : TRACK);
	}

	/** Ends the hover; true when that changes the bar, so the pop-up redraws. */
	leave() {
		if (!this.hover) return false;
		this.hover = false;
		return true;
	}

	/**
	 * For a pop-up's wrapped dispatchMouseToOverlay: runs Pi's `dispatch()` and, when the event did not reach the
	 * bar's pop-up (it hit no overlay, or another one), ends the hover, calling `redraw()` if that changed the bar.
	 * Returns what dispatch returned.
	 */
	routed(dispatch, redraw) {
		this.seen = false;
		const routed = dispatch();
		if (!this.seen && this.leave()) redraw();
		return routed;
	}

	// As pi-tui's scrollScrollbarToPointer: the thumb's top follows the pointer, less where it was grabbed. The view
	// glides there; with no `currentTop` to watch the glide by, it jumps.
	follow(y, top, scrollTo, currentTop) {
		const geometry = this.geometry(top);
		if (!geometry) return;
		const room = geometry.height - geometry.thumbHeight;
		const offset = Math.max(0, Math.min(room, y - this.at.trackTop - this.drag.grab));
		const target = room === 0 ? 0 : Math.round((offset / room) * geometry.maxTop);
		if (currentTop) this.glideTo(target, scrollTo, currentTop);
		else scrollTo(target);
	}

	// Glides the view to `target`: a step now, then one each frame. A glide running retargets.
	glideTo(target, scrollTo, currentTop) {
		if (this.glide && currentTop() === this.glide.set) return void Object.assign(this.glide, { target, scrollTo, currentTop });
		this.stop();
		this.glide = { target, scrollTo, currentTop, set: currentTop(), timer: undefined };
		this.step();
		if (!this.glide) return;
		this.glide.timer = scrollbarDeps.setInterval(() => this.step(), FRAME_MS);
		this.glide.timer?.unref?.();
	}

	// One frame: a third of the lines left, at least one. It stops at the target, when the view would not move (it
	// was clamped), and when something else moved the view since the last frame, leaving it there.
	step() {
		const glide = this.glide;
		if (!glide) return;
		const now = glide.currentTop();
		const rest = glide.target - now;
		if (now !== glide.set || rest === 0) return this.stop();
		glide.scrollTo(now + Math.sign(rest) * Math.max(1, Math.ceil(Math.abs(rest) / 3)));
		glide.set = glide.currentTop();
		if (glide.set === glide.target || glide.set === now) this.stop();
	}

	/** Stops the glide where the view is: for the pop-up's close and dispose, and anything else that moves it. */
	stop() {
		if (this.glide?.timer !== undefined) scrollbarDeps.clearInterval(this.glide.timer);
		this.glide = undefined;
	}

	/**
	 * A mouse event, given the view's `top`, the pop-up's `scrollTo(top)` and `currentTop()`, which reads the view's
	 * top as it is (the glide stops when it is not where the glide left it). Returns Pi's answer when the bar takes
	 * it, undefined when it is the pop-up's own.
	 */
	handleMouse(event, top, scrollTo, currentTop) {
		this.seen = true;
		const type = event?.type;
		if (type === "move" || (type === "drag" && !this.drag)) {
			const row = event.y - (this.at?.trackTop ?? 0);
			const on = Boolean(this.at?.hover) && this.onColumn(event.x) && row >= 0 && row < this.at.height;
			const changed = on !== this.hover;
			this.hover = on;
			if (changed) return { handled: true, render: true };
			return on ? { handled: true } : undefined;
		}
		if (type === "press") {
			this.clickPending = false;
			if (event.button !== undefined && event.button !== "left") return undefined;
			const geometry = this.geometry(top);
			const row = event.y - (this.at?.trackTop ?? 0);
			if (!geometry || !this.onColumn(event.x) || row < 0 || row >= geometry.height) return undefined;
			const onThumb = this.onThumb(geometry, row);
			this.drag = { grab: onThumb ? row - geometry.thumbTop : Math.floor(geometry.thumbHeight / 2), x: event.x, y: event.y, moved: false };
			if (!onThumb) this.follow(event.y, top, scrollTo, currentTop);
			return { handled: true, capture: true, render: true };
		}
		if (type === "drag" && this.drag) {
			if (event.x !== this.drag.x || event.y !== this.drag.y) this.drag.moved = true;
			this.follow(event.y, top, scrollTo, currentTop);
			return { handled: true, render: true };
		}
		if (type === "release" && this.drag) {
			this.clickPending = !this.drag.moved && event.x === this.drag.x && event.y === this.drag.y;
			this.drag = undefined;
			return { handled: true, render: true };
		}
		if (type === "click" && this.clickPending) {
			this.clickPending = false;
			return { handled: true };
		}
		return undefined;
	}
}
