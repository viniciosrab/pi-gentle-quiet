// The TREE tab's file preview: a read-only pop-up over Pi, opened by a click on a file (./tree.ts). An outline
// in the border color, drawn at the cells' outer edge (▔ ▁ ▏ ▕ and their corners) so no half-cell of the
// overlay sticks out past it, around "Read-only — <language>", the file's path, then its numbered lines (no
// wrap, long lines cut with "…", tabs as spaces) and the footer "Esc close · e edit · ↑↓ PgUp/PgDn Home/End
// · 43-64 / 168". Esc or q closes it, ↑↓ j k a line, PgUp/PgDn a page, Home/End (g/G) the ends, the wheel
// three lines; e closes it and opens the file in the editor tab, as a click did before.
//
// A Markdown file is shown rendered, as Pi renders assistant messages (pi-tui's Markdown with Pi's Markdown
// theme), without line numbers; m toggles it with the numbered source ("m source" / "m rendered" in the
// footer). Where this Pi cannot render Markdown, the source is shown and there is no m.
//
// Given text instead of a file (a memory from the MEM tab, ./mem.ts) shows the same way: "Read-only — <label>",
// its title on the path row, the body rendered as Markdown (m for its source), and no e, as there is no file.
//
// At most previewLimits.maxBytes are read. A NUL byte in the first 8 KB makes it a binary file, drawn as one
// row. Pi's highlighter colors the code when this Pi exports it; otherwise the lines are plain.
// @ts-nocheck

import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { open } from "node:fs/promises";
import path from "node:path";

/** How much of a file is read, how much is checked for NUL bytes, and up to what size it is highlighted. */
export const previewLimits = { maxBytes: 1024 * 1024, sniffBytes: 8192, highlightBytes: 256 * 1024 };

const LANGUAGES = {
	TypeScript: ["ts", "tsx", "mts", "cts"],
	JavaScript: ["js", "jsx", "mjs", "cjs"],
	JSON: ["json"],
	Markdown: ["md", "markdown"],
	Python: ["py"],
	Go: ["go"],
	Rust: ["rs"],
	Shell: ["sh", "bash", "zsh"],
	CSS: ["css"],
	HTML: ["html", "htm"],
	YAML: ["yaml", "yml"],
	TOML: ["toml"],
};
const BY_EXTENSION = new Map(Object.entries(LANGUAGES).flatMap(([name, extensions]) => extensions.map((extension) => [extension, name])));

/** The language named on the title row, from the file's extension. */
export function languageOf(file) {
	return BY_EXTENSION.get(path.extname(String(file)).slice(1).toLowerCase()) ?? "Text";
}

// Raw sequences next to Pi's key ids, for terminals (and tests) that send them as they are.
const RAW = { pageUp: ["\x1b[5~"], pageDown: ["\x1b[6~"], home: ["\x1b[H", "\x1b[1~", "\x1bOH"], end: ["\x1b[F", "\x1b[4~", "\x1bOF"] };
const pressed = (data, name) => {
	try {
		if (matchesKey(data, Key?.[name] ?? name)) return true;
	} catch {
		// an id this pi-tui does not know
	}
	return (RAW[name] ?? []).includes(data);
};
const letter = (data, char) => data === char || pressed(data, char === char.toLowerCase() ? char : `shift+${char.toLowerCase()}`);

const CHROME = 6; // top, title, path, blank row, footer, bottom
const WHEEL_LINES = 3;
const TAB_STOP = 4;

const expandTabs = (line) => {
	if (!line.includes("\t")) return line;
	let out = "";
	for (const char of line) out += char === "\t" ? " ".repeat(TAB_STOP - (visibleWidth(out) % TAB_STOP)) : char;
	return out;
};
// Escape sequences and other control characters in the file would drive the terminal: draw them as "�".
const sanitize = (line) => expandTabs(line).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "�");

const sizeLabel = (bytes) => (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MB` : bytes >= 1024 && bytes % 1024 === 0 ? `${bytes / 1024} KB` : `${bytes} bytes`);

/** Reads `file` for the preview: { lines, cut } for text, or { binary }, { empty }, { error }. */
export async function readPreview(file) {
	let handle;
	try {
		handle = await open(file, "r");
		const size = (await handle.stat()).size;
		const length = Math.min(size, previewLimits.maxBytes);
		const buffer = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const { bytesRead } = await handle.read(buffer, read, length - read, read);
			if (!bytesRead) break;
			read += bytesRead;
		}
		const bytes = buffer.subarray(0, read);
		if (!bytes.length) return { empty: true };
		if (bytes.subarray(0, previewLimits.sniffBytes).includes(0)) return { binary: true };
		const lines = bytes.toString("utf8").split(/\r?\n/);
		if (lines.length > 1 && lines.at(-1) === "") lines.pop();
		return { lines: lines.map(sanitize), cut: size > read ? read : 0 };
	} catch (error) {
		return { error: error?.message ?? String(error) };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** Given text for the preview, as readPreview gives a file's: { lines } or { empty }, { error } when it fails. */
export async function textPreview(text) {
	try {
		const body = String((await text) ?? "");
		if (!body.trim()) return { empty: true };
		const lines = body.split(/\r?\n/);
		if (lines.length > 1 && lines.at(-1) === "") lines.pop();
		return { lines: lines.map(sanitize), cut: 0 };
	} catch (error) {
		return { error: error?.message ?? String(error) };
	}
}

// Pi's highlighter, when this Pi exports it and the file is small enough; the plain lines otherwise.
function highlighted(file, lines) {
	try {
		const { highlightCode, getLanguageFromPath } = PiCodingAgent;
		if (typeof highlightCode !== "function") return lines;
		if (lines.reduce((sum, line) => sum + line.length + 1, 0) > previewLimits.highlightBytes) return lines;
		const language = typeof getLanguageFromPath === "function" ? getLanguageFromPath(file) : undefined;
		if (!language) return lines;
		const colored = highlightCode(lines.join("\n"), language);
		return Array.isArray(colored) && colored.length === lines.length ? colored.map(String) : lines;
	} catch {
		return lines;
	}
}

// The file rendered as Markdown at `width`, trailing blank rows dropped; undefined when this Pi cannot.
function renderedMarkdown(lines, width) {
	try {
		const { Markdown } = PiTui;
		const { getMarkdownTheme } = PiCodingAgent;
		if (typeof Markdown !== "function" || typeof getMarkdownTheme !== "function") return undefined;
		const rows = new Markdown(lines.join("\n"), 0, 0, getMarkdownTheme()).render(width);
		if (!Array.isArray(rows)) return undefined;
		const out = rows.map(String);
		while (out.length && !out.at(-1).trim()) out.pop();
		return out.length ? out : undefined;
	} catch {
		return undefined;
	}
}

// Outline strokes at the outer edge of their cells.
const EDGE = { top: "▔", bottom: "▁", left: "▏", right: "▕", topLeft: "\u{1FB7D}", topRight: "\u{1FB7E}", bottomRight: "\u{1FB7F}", bottomLeft: "\u{1FB7C}" };

class FilePreview {
	constructor({ file, relPath, tui, theme, done, onEdit, loading, label }) {
		Object.assign(this, { file, relPath, tui, theme, done, onEdit, label });
		this.top = 0;
		this.content = undefined;
		this.closed = false;
		this.markdown = file === undefined || languageOf(file) === "Markdown"; // rendered, until m or a failed render
		this.rendered = undefined; // { width, rows } of the last Markdown render
		this.ready = loading.then((content) => {
			this.content = content.lines ? { ...content, shown: file === undefined ? content.lines : highlighted(file, content.lines) } : content;
			this.redraw();
		});
	}

	paint(role, text) {
		try {
			return this.theme?.fg ? this.theme.fg(role, text) : text;
		} catch {
			return text;
		}
	}

	bold(text) {
		try {
			return this.theme?.bold ? this.theme.bold(text) : text;
		} catch {
			return text;
		}
	}

	redraw(force) {
		try {
			this.tui?.requestRender?.(force);
		} catch {
			// a dead terminal must not break the preview
		}
	}

	// Rows of code the overlay has room for: Pi caps it at 85% of the terminal.
	page() {
		const rows = Number(this.tui?.terminal?.rows) || 24;
		return Math.max(1, Math.floor(rows * 0.85) - CHROME);
	}

	// The Markdown rows at `width`, rendered again only when the width changes; undefined in source view.
	markdownRows(width) {
		if (!this.markdown || !this.content?.lines) return undefined;
		if (this.rendered?.width !== width) {
			const rows = renderedMarkdown(this.content.lines, width);
			if (!rows) {
				this.markdown = this.canRender = false;
				return undefined;
			}
			this.rendered = { width, rows };
			this.canRender = true;
		}
		return this.rendered.rows;
	}

	total() {
		if (this.markdown && this.rendered) return this.rendered.rows.length;
		return this.content?.lines?.length ?? 0;
	}

	toggleMarkdown() {
		if (!this.canRender) return false;
		this.markdown = !this.markdown;
		this.top = 0;
		this.redraw();
		return true;
	}

	scrollTo(top) {
		const next = Math.max(0, Math.min(top, this.total() - this.page()));
		if (next === this.top) return false;
		this.top = next;
		this.redraw();
		return true;
	}

	close(edit = false) {
		if (this.closed) return;
		this.closed = true;
		this.done(undefined);
		this.redraw(true); // repaint every cell behind the closed overlay
		if (edit) this.onEdit?.();
	}

	handleInput(data) {
		if (pressed(data, "escape") || letter(data, "q")) return this.close();
		if (letter(data, "e")) return this.onEdit ? this.close(true) : false;
		if (letter(data, "m")) return this.toggleMarkdown();
		if (pressed(data, "down") || letter(data, "j")) return this.scrollTo(this.top + 1);
		if (pressed(data, "up") || letter(data, "k")) return this.scrollTo(this.top - 1);
		if (pressed(data, "pageDown")) return this.scrollTo(this.top + this.page());
		if (pressed(data, "pageUp")) return this.scrollTo(this.top - this.page());
		if (pressed(data, "home") || letter(data, "g")) return this.scrollTo(0);
		if (pressed(data, "end") || letter(data, "G")) return this.scrollTo(this.total());
	}

	handleMouse(event) {
		if (event?.type !== "wheel" || !event.wheelDelta) return undefined;
		this.scrollTo(this.top + (event.wheelDelta > 0 ? WHEEL_LINES : -WHEEL_LINES));
		return { handled: true, render: true };
	}

	render(width) {
		const inner = Math.max(1, width - 4);
		const fit = (row) => {
			const cut = visibleWidth(row) > inner ? truncateToWidth(row, inner, "…") : row;
			return `${this.paint("border", EDGE.left)} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${this.paint("border", EDGE.right)}`;
		};
		// Plain text cut before it is painted, so the color reaches the "…".
		const text = (role, plain, bold = false) => {
			const cut = visibleWidth(plain) > inner ? truncateToWidth(plain, inner, "…") : plain;
			return this.paint(role, bold ? this.bold(cut) : cut);
		};
		const content = this.content;
		const cut = content?.cut ? ` · first ${sizeLabel(content.cut)}` : "";
		const body = [];
		let range = "";
		if (!content) body.push(text("dim", "Reading…"));
		else if (content.error) body.push(text("warning", `${this.file === undefined ? "Cannot read" : "Cannot read the file"}: ${content.error}`));
		else if (content.binary) body.push(text("muted", "Binary file — press e to open it in the editor"));
		else if (content.empty) body.push(text("muted", this.file === undefined ? "(empty)" : "(empty file)"));
		else {
			const rows = this.markdownRows(inner);
			const total = this.total();
			this.top = Math.max(0, Math.min(this.top, total - this.page()));
			const to = Math.min(total, this.top + this.page());
			const digits = String(total).length;
			const room = Math.max(1, inner - digits - 1);
			for (let index = this.top; index < to; index++) {
				if (rows) {
					body.push(rows[index]);
					continue;
				}
				const code = content.shown[index];
				const line = visibleWidth(code) > room ? truncateToWidth(code, room, "…") : code;
				body.push(`${this.paint("dim", String(index + 1).padStart(digits))} ${line}`);
			}
			const toggle = this.canRender ? ` · m ${rows ? "source" : "rendered"}` : "";
			range = `${toggle} · ↑↓ PgUp/PgDn Home/End · ${this.top + 1}-${to} / ${total}`;
		}
		return [
			this.paint("border", `${EDGE.topLeft}${EDGE.top.repeat(inner + 2)}${EDGE.topRight}`),
			fit(text("toolTitle", `Read-only — ${this.label ?? languageOf(this.file)}`, true)),
			fit(text("muted", `${this.relPath}${cut}`)),
			fit(""),
			...body.map(fit),
			fit(text("dim", `Esc close${this.onEdit ? " · e edit" : ""}${range}`)),
			this.paint("border", `${EDGE.bottomLeft}${EDGE.bottom.repeat(inner + 2)}${EDGE.bottomRight}`),
		];
	}

	invalidate() {}
}

/** The pop-up's width on a terminal `columns` wide: 65% of it, between 60 and 125 columns, so lines stay readable. */
export function previewWidthFor(columns) {
	return Math.max(60, Math.min(125, Math.floor((Number(columns) || 0) * 0.65)));
}

/**
 * Opens the read-only preview of `file` (shown as `relPath`) over Pi. `onEdit` runs when e closes it. Returns
 * false, having opened nothing, when Pi has no overlay UI here: the caller then opens the editor itself.
 * With `text` (a string, or a promise of one) instead of `file`, shows that text as Markdown under `title`,
 * named `label` on the title row ("Text" without one), with no e.
 */
export function openPreview(ctx, { file, relPath, onEdit, text, title, label }) {
	try {
		if (!ctx?.hasUI || typeof ctx.ui?.custom !== "function") return false;
		const given = text !== undefined;
		const loading = given ? textPreview(text) : readPreview(file);
		let host;
		const result = ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				host = tui;
				return given
					? new FilePreview({ relPath: title ?? "", tui, theme, done, loading, label: label ?? "Text" })
					: new FilePreview({ file, relPath, tui, theme, done, onEdit, loading });
			},
			{
				overlay: true,
				// Pi resolves this once the pop-up exists, so the width follows the terminal it opens on.
				overlayOptions: () => ({ anchor: "center", width: previewWidthFor(host?.terminal?.columns), minWidth: 60, maxHeight: "85%" }),
			},
		);
		Promise.resolve(result).catch(() => undefined);
		return true;
	} catch {
		return false; // a stale ctx or a UI without overlays
	}
}
