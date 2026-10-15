// Minimal stand-in for @earendil-works/pi-tui: just what gentle-quiet imports.
const strip = (text) => text.replace(/\x1b\[[0-9;:]*m/g, "");

export const visibleWidth = (text) => [...strip(text)].length;

export function truncateToWidth(text, width, ellipsis = "…") {
	if (visibleWidth(text) <= width) return text;
	return [...strip(text)].slice(0, Math.max(0, width - 1)).join("") + ellipsis;
}

export class Text {
	constructor(text = "", paddingX = 0) {
		this.text = text;
		this.paddingX = paddingX;
	}
	render() {
		return this.text.split("\n").map((line) => " ".repeat(this.paddingX) + line);
	}
	invalidate() {}
}

// Raw key sequences; matchesKey compares them directly.
export const Key = { left: "\x1b[D", right: "\x1b[C", up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", tab: "\t", shift: (key) => (key === "tab" ? "\x1b[Z" : `S-${key}`) };
export const matchesKey = (data, key) => data === key;

// Fullscreen scroll container of the side column: renders what it wraps.
export class ScrollView {
	constructor(content, options = {}) {
		this.content = content;
		this.options = options;
		this.scrollTop = 0;
	}
	getContentWidth(width) {
		return width - 1;
	}
	render(width) {
		return this.content.render(width);
	}
	handleMouse() {}
	scrollBy() {}
	setScrollbar() {}
}
