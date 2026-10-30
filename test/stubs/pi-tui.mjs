// Minimal stand-in for @earendil-works/pi-tui: just what gentle-quiet imports.
const strip = (text) => text.replace(/\x1b\[[0-9;:]*m/g, "");

export const visibleWidth = (text) => [...strip(text)].length;

// Word wrap on visible width; escape sequences stay attached to their words.
export function wrapTextWithAnsi(text, width) {
	const lines = [];
	let line = "";
	for (const word of text.split(" ")) {
		const next = line === "" ? word : `${line} ${word}`;
		if (line !== "" && visibleWidth(next) > width) {
			lines.push(line);
			line = word;
		} else line = next;
	}
	lines.push(line);
	return lines;
}

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

// Like Pi's: a blank row, then " <spinner> <message>" padded to the width.
export class Loader extends Text {
	constructor(ui, spinnerColorFn, messageColorFn, message = "Loading...") {
		super("", 1);
		this.message = message;
		this.text = `⠋ ${message}`;
	}
	render(width) {
		return ["", ...super.render(width).map((line) => line + " ".repeat(Math.max(0, width - visibleWidth(line))))];
	}
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
		this.scrollbar = options.scrollbar ?? "auto";
	}
	// Like Pi's: only an "always" scrollbar keeps a column of its own; "auto" paints over the content's last column.
	getContentWidth(width) {
		return this.scrollbar === "always" && width > 1 ? width - 1 : width;
	}
	render(width) {
		return this.content.render(width);
	}
	// Like Pi's: the content and viewport heights the owner computed; scrollTop stays within them.
	updateLayout(contentHeight, viewportHeight) {
		this.contentHeight = contentHeight;
		this.viewportHeight = viewportHeight;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, contentHeight - viewportHeight));
	}
	handleMouse() {}
	scrollBy() {}
	setScrollbar() {}
}

// Terminal capabilities: no image protocol unless a test sets globalThis.testImageProtocol.
export const getCapabilities = () => ({ images: globalThis.testImageProtocol ?? null, trueColor: true, hyperlinks: true });

// Like Pi's: an inline image, here drawn as its size so tests can see where it lands.
export class Image {
	constructor(base64Data, mimeType, theme, options = {}) {
		Object.assign(this, { base64Data, mimeType, theme, options });
	}
	render() {
		return [`<image ${this.mimeType} ${this.options.maxWidthCells}x${this.options.maxHeightCells}>`, ""];
	}
	invalidate() {}
}
