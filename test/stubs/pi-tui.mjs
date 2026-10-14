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
