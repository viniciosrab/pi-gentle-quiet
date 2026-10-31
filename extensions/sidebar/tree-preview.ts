// The TREE tab's file preview: a read-only pop-up over Pi, opened by a click on a file (./tree.ts). An outline
// in the border color, drawn at the cells' outer edge (▔ ▁ ▏ ▕ and their corners) so no half-cell of the
// overlay sticks out past it, around "Read-only — <language>", the file's path, then its numbered lines (no
// wrap, long lines cut with "…", tabs as spaces) and the footer "Esc close · e edit · ↑↓ PgUp/PgDn Home/End
// · 43-64 / 168". Esc or q closes it, and so does a click anywhere outside it (that click does nothing else);
// ↑↓ j k a line, PgUp/PgDn a page, Home/End (g/G) the ends, the wheel three lines; e closes it and opens the
// file in the editor tab, as a click did before.
//
// A Markdown file is shown rendered, as Pi renders assistant messages (pi-tui's Markdown with Pi's Markdown
// theme) but with code blocks framed instead of fenced and "•" bullets, without line numbers; m toggles it with the numbered source ("m source" / "m rendered" in the
// footer). Where this Pi cannot render Markdown, the source is shown and there is no m.
// While a Markdown file's preview is open (either view), Pi's screen behind it is drawn dim (BACKDROP, below).
//
// Given text instead of a file (a memory from the MEM tab, ./mem.ts) shows the same way: "Read-only — <label>",
// its title on the path row, the body rendered as Markdown (m for its source), and no e, as there is no file.
//
// Opened from the GIT tab with `changes` (./git.ts), a file shows its changes inline, as VS Code's diff does:
// "Read-only — <language> · changes", every row of the file with a gutter before its number, "+" on added rows
// and "-" on removed ones, which stand where they were removed from with no number, both painted in the theme's
// toolDiffAdded / toolDiffRemoved. It opens at the first change; n/N (or ] and [) jump to the next or previous
// change, and the footer shows "+12 −3". A Markdown file is its source there, never rendered (no m). When git
// gives no diff (no change, a binary file, a failure) it is the plain preview.
//
// At most previewLimits.maxBytes are read. A NUL byte in the first 8 KB makes it a binary file, drawn as one
// row. Pi's highlighter colors the code when this Pi exports it; otherwise the lines are plain.
// @ts-nocheck

import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { open } from "node:fs/promises";
import path from "node:path";
import { addedRows, changeBlocks, parseFileDiff } from "./diff-preview.ts";

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
const LEAD = 3; // rows shown above a change the view jumps to
const TINT = 0.25; // how much of the theme's diff color a changed row's background takes

// Whether an SGR's parameters reset the background: a full reset ("", 0) or 49. The arguments of a 38/48/58
// color (5;n or 2;r;g;b) are skipped, so the 0 of "38;5;0" is a color, not a reset.
function endsBackground(params) {
	const parts = params === "" ? ["0"] : params.split(/[;:]/);
	for (let i = 0; i < parts.length; i++) {
		const code = Number(parts[i] || 0);
		if (code === 0 || code === 49) return true;
		if (code === 38 || code === 48 || code === 58) i += parts[i + 1] === "5" ? 2 : parts[i + 1] === "2" ? 4 : 1;
	}
	return false;
}

// A theme role's color as [r, g, b] when it is a truecolor one: Pi's resolved colors, or its escape.
function themeRgb(theme, role) {
	const color = theme?.colors?.[role];
	if (color?.kind === "rgb") return [color.r, color.g, color.b].map(Math.round);
	const ansi = typeof theme?.getFgAnsi === "function" ? theme.getFgAnsi(role) : theme?.fg?.(role, "");
	const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(ansi ?? "");
	return m ? m.slice(1).map(Number) : undefined;
}
// Two diff colors a monochrome theme gave: both gray (no channel spread), or too close to tell apart.
const gray = (rgb) => Math.max(...rgb) - Math.min(...rgb) < 24;
const monochrome = (a, b) => (gray(a) && gray(b)) || Math.hypot(...a.map((channel, i) => channel - b[i])) < 48;
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

/**
 * The preview of a file with its changes: { lines, rows, added, removed, blocks } from the diff `changes.diff`
 * resolves to, or from the whole file added with `changes.untracked`; readPreview's answer when there is none.
 */
export async function changesPreview(file, changes) {
	try {
		if (changes?.untracked) {
			const content = await readPreview(file);
			return content.lines ? withRows(content, addedRows(content.lines)) : content;
		}
		const parsed = parseFileDiff(await changes?.diff);
		if (parsed) return withRows({ cut: 0 }, parsed.rows.map((row) => ({ ...row, text: sanitize(row.text) })));
	} catch {
		// git failed: the plain preview
	}
	return readPreview(file);
}

function withRows(content, rows) {
	const count = (sign) => rows.filter((row) => row.sign === sign).length;
	// The widest numbers of each column.
	const last = rows.reduce((most, row) => Math.max(most, row.number ?? 0), 1);
	const lastOld = rows.reduce((most, row) => Math.max(most, row.old ?? 0), 1);
	return { ...content, lines: rows.map((row) => row.text), rows, last, lastOld, added: count("+"), removed: count("-"), blocks: changeBlocks(rows) };
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
/** Pi's highlighter and language lookup, swappable in tests; Pi's own when unset. */
export const previewDeps = { highlightCode: undefined, getLanguageFromPath: undefined };

function highlighted(file, lines) {
	try {
		const highlightCode = previewDeps.highlightCode ?? PiCodingAgent.highlightCode;
		const getLanguageFromPath = previewDeps.getLanguageFromPath ?? PiCodingAgent.getLanguageFromPath;
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

// Mark the rows Pi draws for a code block's fence lines and code lines, so the block can be redrawn framed.
// Control characters, which Pi measures as zero columns wide.
const FENCE = "\u0000\u0001";
const CODE = "\u0000\u0002";

// Pi's Markdown theme at `width`, minus the syntax Pi still shows: a code block's fence lines (Pi 1.4.0 draws
// them as "```lang" and "```") become rows marked FENCE, and its lines, without Pi's indent, rows marked CODE
// that are cut with "…" to fit the frame, so Pi does not wrap them. A list item's "- " marker becomes "• " of
// the same width, so wrapped and nested items stay aligned. Ordered numbers stay.
function previewTheme(theme, width) {
	const room = Math.max(1, width - 4 - visibleWidth(CODE));
	const code = (line) => CODE + (visibleWidth(line) > room ? truncateToWidth(line, room, "…") : line);
	const block = theme.codeBlock ?? ((text) => text);
	const bullet = theme.listBullet ?? ((text) => text);
	return {
		...theme,
		codeBlockIndent: "",
		codeBlock: (line) => code(block(line)),
		...(typeof theme.highlightCode === "function" && { highlightCode: (text, lang) => theme.highlightCode(text, lang).map((line) => code(String(line))) }),
		codeBlockBorder: (text) => FENCE + String(text).replace(/^`+/, ""),
		listBullet: (text) => bullet(String(text).replace(/^[-*+] /, "• ")),
	};
}

// A code block as a square frame in the border color, as wide as `width`: its language (dim) in the top line,
// each code row padded (or cut with "…") between "│ " and " │".
// ┌ sh ─────┐
// │ npm test │
// └──────────┘
function framedCode(language, rows, width, paint) {
	const inner = Math.max(1, width - 4);
	const line = (text) => paint("border", text);
	const fit = (row) => {
		const cut = visibleWidth(row) > inner ? truncateToWidth(row, inner, "…") : row;
		return cut + " ".repeat(Math.max(0, inner - visibleWidth(cut)));
	};
	const label = visibleWidth(language) > width - 5 ? truncateToWidth(language, Math.max(1, width - 5), "…") : language;
	const top = label ? `${line("┌ ")}${paint("dim", label)}${line(` ${"─".repeat(Math.max(1, width - visibleWidth(label) - 4))}┐`)}` : line(`┌${"─".repeat(inner + 2)}┐`);
	return [top, ...rows.map((row) => `${line("│")} ${fit(row)} ${line("│")}`), line(`└${"─".repeat(inner + 2)}┘`)];
}

// The file rendered as Markdown at `width`, trailing blank rows dropped; undefined when this Pi cannot. Each
// code block is drawn framed, without its fence lines, colored through `paint(role, text)`.
function renderedMarkdown(lines, width, paint = (_role, text) => text) {
	try {
		const { Markdown } = PiTui;
		const { getMarkdownTheme } = PiCodingAgent;
		if (typeof Markdown !== "function" || typeof getMarkdownTheme !== "function") return undefined;
		const rows = new Markdown(lines.join("\n"), 0, 0, previewTheme(getMarkdownTheme(), width)).render(width);
		if (!Array.isArray(rows)) return undefined;
		const out = [];
		let block; // { prefix, language, rows } of the code block being read
		const close = () => {
			out.push(...framedCode(block.language, block.rows, width - visibleWidth(block.prefix), paint).map((row) => block.prefix + row));
			block = undefined;
		};
		for (const row of rows.map(String)) {
			const fence = row.indexOf(FENCE);
			if (fence >= 0) {
				if (block) close();
				else block = { prefix: row.slice(0, fence), language: row.slice(fence + FENCE.length).replace(/\x1b\[[0-9;:]*m/g, "").trim(), rows: [] };
			} else if (block) {
				// A code row, or the rest of one Pi wrapped anyway (in a narrower list item or quote).
				const at = row.indexOf(CODE);
				block.rows.push((at >= 0 ? row.slice(at + CODE.length) : row).replace(/ +$/, ""));
			} else out.push(row);
		}
		if (block) close();
		while (out.length && !out.at(-1).trim()) out.pop();
		return out.length ? out : undefined;
	} catch {
		return undefined;
	}
}

// Outline strokes at the outer edge of their cells.
const EDGE = { top: "▔", bottom: "▁", left: "▏", right: "▕", topLeft: "\u{1FB7D}", topRight: "\u{1FB7E}", bottomRight: "\u{1FB7F}", bottomLeft: "\u{1FB7C}" };

// Answers the rest of a click that closed the pop-up (release, click), so it reaches nothing under it.
const SWALLOW = { handleMouse: () => undefined, invalidate() {} };

// Pi 1.4.0 hands an overlay the mouse only inside its box (TUI.dispatchMouseToOverlay), has no overlay option
// for a click outside it, and its terminal input listeners never see mouse sequences (the viewport's own
// listener takes them first). So while the pop-up is open the TUI's dispatchMouseToOverlay is wrapped on the
// instance: a press that lands on no overlay, with the pop-up on top, closes it and is answered with a target
// that swallows the release and the click. Pi then sends that press nowhere else. Returns the unwrap.
function closeOnOutsidePress(tui, preview) {
	const original = tui?.dispatchMouseToOverlay;
	if (typeof original !== "function") return () => {};
	const own = Object.hasOwn(tui, "dispatchMouseToOverlay");
	const wrapped = function (event) {
		const routed = original.call(this, event);
		if (routed?.hit || event?.type !== "press" || preview.closed) return routed;
		try {
			const top = tui.getTopmostVisibleOverlay?.();
			if (top && top.component !== preview) return routed; // another overlay is over it
		} catch {
			// an older TUI: the pop-up is the one on top
		}
		preview.close();
		const target = { component: SWALLOW, originX: 0, originY: 0, width: event.width, height: event.height };
		return { hit: true, result: { handled: true, render: true, target } };
	};
	try {
		tui.dispatchMouseToOverlay = wrapped;
	} catch {
		return () => {};
	}
	return () => {
		if (tui.dispatchMouseToOverlay !== wrapped) return; // wrapped again since: ours stays, inert once closed
		if (own) tui.dispatchMouseToOverlay = original;
		else delete tui.dispatchMouseToOverlay;
	};
}

// A Markdown file's preview dims Pi behind it. Pi has no overlay option for a backdrop, and pi-tui does not
// export its TUI class, so the prototype that owns the live TUI's compositeOverlays is wrapped, once per
// process: while a visible overlay carries BACKDROP, the base lines are redrawn without their colors, in the
// preview theme's dim (faint without one), before Pi draws the overlays over them. Image lines stay; blank
// lines stay blank. Only the last `termHeight` lines, the screen, change: on the main screen Pi hands over the
// whole conversation, and a changed line above the screen would make it clear the scrollback and redraw all. The wrapper calls the latest loaded copy of backdropLines, so /reload applies, and any
// error leaves Pi's lines as they were.
const BACKDROP = Symbol.for("gentle-quiet.backdrop");
const BACKDROP_PATCHED = Symbol.for("gentle-quiet.backdropPatched");
const BACKDROP_LINES = Symbol.for("gentle-quiet.backdropLines");
const SGR = /\x1b\[[0-9;:]*m/g;
const isImageLine = (line) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");

function backdropLines(tui, lines, termHeight) {
	const entry = tui.overlayStack?.find((candidate) => candidate?.component?.[BACKDROP] && tui.isOverlayVisible(candidate));
	if (!entry) return lines;
	// A fixed near-black (#1f1f1f), not a theme role: under the "system" theme in a terminal that reports no colors
	// (herdr) every role is an ANSI index the terminal paints lighter, and some terminals ignore faint.
	const dim = (text) => `\x1b[38;2;31;31;31m${text}\x1b[39m`;
	const top = Math.max(0, lines.length - (Number(termHeight) || lines.length));
	return lines.map((line, index) => {
		if (index < top || typeof line !== "string" || !line || isImageLine(line)) return line;
		const bare = line.replace(SGR, "");
		return bare.trim() ? dim(bare) : bare;
	});
}
globalThis[BACKDROP_LINES] = backdropLines;

function patchBackdrop(tui) {
	let proto = tui;
	while (proto && !Object.hasOwn(proto, "compositeOverlays")) proto = Object.getPrototypeOf(proto);
	if (!proto || proto === tui || typeof proto.compositeOverlays !== "function" || proto[BACKDROP_PATCHED]) return;
	const original = proto.compositeOverlays;
	proto.compositeOverlays = function (lines, termWidth, termHeight, ...rest) {
		let base = lines;
		try {
			if (Array.isArray(lines)) base = globalThis[BACKDROP_LINES]?.(this, lines, termHeight) ?? lines;
		} catch {
			base = lines;
		}
		return original.call(this, base, termWidth, termHeight, ...rest);
	};
	proto[BACKDROP_PATCHED] = true;
}

class FilePreview {
	constructor({ file, relPath, tui, theme, done, onEdit, loading, label, changes = false }) {
		Object.assign(this, { file, relPath, tui, theme, done, onEdit, label, changes });
		if (file !== undefined && languageOf(file) === "Markdown") this[BACKDROP] = true;
		try {
			patchBackdrop(tui);
		} catch {
			// a TUI that cannot be patched: no backdrop
		}
		this.unwrapMouse = closeOnOutsidePress(tui, this);
		this.top = 0;
		this.content = undefined;
		this.closed = false;
		// Rendered, until m or a failed render; from the GIT tab a Markdown file is its source.
		this.markdown = !changes && (file === undefined || languageOf(file) === "Markdown");
		this.rendered = undefined; // { width, rows } of the last Markdown render
		this.ready = loading.then((content) => {
			this.content = content.lines ? { ...content, shown: this.colored(content) } : content;
			if (content.blocks?.length) this.top = Math.max(0, content.blocks[0] - LEAD); // render keeps it in range
			this.redraw();
		});
	}

	// The lines as drawn: highlighted as the files they make up, the new one (unchanged and added rows) and the
	// old one (unchanged and removed rows), so each row gets the colors of its own file.
	colored({ lines, rows }) {
		if (this.file === undefined) return lines;
		if (!rows) return highlighted(this.file, lines);
		const shown = [...lines];
		const take = (skip) => {
			const picked = rows.flatMap((row, index) => (row.sign === skip ? [] : [index]));
			if (!picked.length) return;
			const code = highlighted(this.file, picked.map((index) => lines[index]));
			picked.forEach((index, at) => {
				if (skip === "+" ? rows[index].sign === "-" : true) shown[index] = code[at];
			});
		};
		take("-"); // the new file
		if (rows.some((row) => row.sign === "-")) take("+"); // the old file, for its removed rows
		return shown;
	}

	// The background of a changed row, from the theme: its toolDiffAdded / toolDiffRemoved color blended TINT of
	// the way over the screen's background when the theme has a truecolor one, else its toolSuccessBg /
	// toolErrorBg role. { open } of the escape that sets it, or undefined (no tint) when the theme has neither.
	tints() {
		const theme = this.theme;
		const tint = (role, bgRole) => {
			try {
				const color = (theme.getColorMode?.() ?? "truecolor") === "truecolor" ? themeRgb(theme, role) : undefined;
				if (color) {
					const base = theme.appearance === "light" ? 255 : 0; // Pi's guess for an unreported background
					return { open: `\x1b[48;2;${color.map((channel) => Math.round(base + (channel - base) * TINT)).join(";")}m`, rgb: color };
				}
				const open = typeof theme.getBgAnsi === "function" ? theme.getBgAnsi(bgRole) : typeof theme.bg === "function" ? theme.bg(bgRole, "\0").split("\0")[0] : "";
				return open && open !== "\x1b[49m" ? { open } : undefined; // a role left to the terminal's default: no tint
			} catch {
				return undefined;
			}
		};
		const added = tint("toolDiffAdded", "toolSuccessBg");
		const removed = tint("toolDiffRemoved", "toolErrorBg");
		// A monochrome theme gives both roles a gray: the hue cannot tell them apart, so removed rows go half as
		// strong and fade their code to dim.
		if (removed?.rgb && added?.rgb && monochrome(added.rgb, removed.rgb)) {
			const base = this.theme.appearance === "light" ? 255 : 0;
			return { "+": added, "-": { open: `\x1b[48;2;${removed.rgb.map((channel) => Math.round(base + (channel - base) * (TINT / 2))).join(";")}m`, faded: true } };
		}
		return { "+": added, "-": removed };
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
			const rows = renderedMarkdown(this.content.lines, width, (role, text) => this.paint(role, text));
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

	// The next (dir 1) or previous (-1) change, by where the view would stand on it.
	jump(dir) {
		const blocks = this.content?.blocks ?? [];
		const stops = blocks.map((start) => Math.max(0, Math.min(start - LEAD, this.total() - this.page())));
		const stop = dir > 0 ? stops.find((at) => at > this.top) : stops.findLast((at) => at < this.top);
		return stop === undefined ? false : this.scrollTo(stop);
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
		this.unwrapMouse();
		this.done(undefined);
		this.redraw(true); // repaint every cell behind the closed overlay
		if (edit) this.onEdit?.();
	}

	handleInput(data) {
		if (pressed(data, "escape") || letter(data, "q")) return this.close();
		if (letter(data, "e")) return this.onEdit ? this.close(true) : false;
		if (letter(data, "m")) return this.toggleMarkdown();
		if (this.content?.rows && (letter(data, "n") || data === "]")) return this.jump(1);
		if (this.content?.rows && (letter(data, "N") || data === "[")) return this.jump(-1);
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
		// A row between the side strokes; a { text, tint } row has the tint behind it from stroke to stroke, set again
		// after every escape inside it so a reset in the highlighted code does not end it.
		const fit = (row) => {
			const line = typeof row === "string" ? row : row.text;
			const cut = visibleWidth(line) > inner ? truncateToWidth(line, inner, "…") : line;
			let middle = ` ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} `;
			if (row?.tint) middle = `${row.tint.open}${middle.replace(/\x1b\[([0-9;:]*)m/g, (sgr, params) => (endsBackground(params) ? sgr + row.tint.open : sgr))}\x1b[49m`;
			return `${this.paint("border", EDGE.left)}${middle}${this.paint("border", EDGE.right)}`;
		};
		// Plain text cut before it is painted, so the color reaches the "…".
		const text = (role, plain, bold = false) => {
			const cut = visibleWidth(plain) > inner ? truncateToWidth(plain, inner, "…") : plain;
			return this.paint(role, bold ? this.bold(cut) : cut);
		};
		const content = this.content;
		const cut = content?.cut ? ` · first ${sizeLabel(content.cut)}` : "";
		const body = [];
		let range = []; // the footer after "Esc close · e edit", as [role, text] parts
		if (!content) body.push(text("dim", "Reading…"));
		else if (content.error) body.push(text("warning", `${this.file === undefined ? "Cannot read" : "Cannot read the file"}: ${content.error}`));
		else if (content.binary) body.push(text("muted", "Binary file — press e to open it in the editor"));
		else if (content.empty) body.push(text("muted", this.file === undefined ? "(empty)" : "(empty file)"));
		else {
			const rows = this.markdownRows(inner);
			const total = this.total();
			this.top = Math.max(0, Math.min(this.top, total - this.page()));
			const to = Math.min(total, this.top + this.page());
			const diff = content.rows;
			const digits = String(diff ? content.last : total).length;
			const oldDigits = diff ? String(content.lastOld).length : 0;
			// VS Code's gutter: "<old> <new> <sign> " before the code.
			const gutter = diff ? oldDigits + 1 + 3 : 0;
			const room = Math.max(1, inner - digits - 1 - gutter);
			const SIGN = { "+": ["toolDiffAdded", "+"], "-": ["toolDiffRemoved", "−"] };
			const tints = diff ? this.tints() : {};
			const number = (value, width) => this.paint("dim", value === undefined ? " ".repeat(width) : String(value).padStart(width));
			for (let index = this.top; index < to; index++) {
				if (rows) {
					body.push(rows[index]);
					continue;
				}
				const code = content.shown[index];
				const line = visibleWidth(code) > room ? truncateToWidth(code, room, "…") : code;
				if (!diff) {
					body.push(`${number(index + 1, digits)} ${line}`);
					continue;
				}
				const row = diff[index];
				const [role, mark] = SIGN[row.sign] ?? [];
				const shown = tints[row.sign]?.faded ? this.paint("dim", line.replace(SGR, "")) : line;
				const text = `${number(row.old, oldDigits)} ${number(row.number, digits)} ${role ? this.paint(role, mark) : " "} ${shown}`;
				body.push(role && tints[row.sign] ? { text, tint: tints[row.sign] } : text);
			}
			const toggle = this.canRender ? ` · m ${rows ? "source" : "rendered"}` : "";
			const changes = diff ? [["dim", " · n/N change · "], ["toolDiffAdded", `+${content.added}`], ["dim", " "], ["toolDiffRemoved", `−${content.removed}`]] : [];
			const keys = " · ↑↓ PgUp/PgDn Home/End";
			range = [["dim", toggle], ...changes, ["dim", keys], ["dim", ` · ${this.top + 1}-${to} / ${total}`]];
			// The scroll keys give way first, so the range stays.
			const width = visibleWidth(`Esc close${this.onEdit ? " · e edit" : ""}`) + visibleWidth(range.map(([, part]) => part).join(""));
			if (width > inner) range = range.filter(([, part]) => part !== keys);
		}
		return [
			this.paint("border", `${EDGE.topLeft}${EDGE.top.repeat(inner + 2)}${EDGE.topRight}`),
			fit(text("toolTitle", `Read-only — ${this.label ?? languageOf(this.file)}${content?.rows ? " · changes" : ""}`, true)),
			fit(text("muted", `${this.relPath}${cut}`)),
			fit(""),
			...body.map(fit),
			fit([["dim", `Esc close${this.onEdit ? " · e edit" : ""}`], ...range].map(([role, part]) => (part ? this.paint(role, part) : "")).join("")),
			this.paint("border", `${EDGE.bottomLeft}${EDGE.bottom.repeat(inner + 2)}${EDGE.bottomRight}`),
		];
	}

	invalidate() {}

	// Pi disposes the component when it closes the overlay, by whatever path.
	dispose() {
		this.closed = true;
		this.unwrapMouse();
	}
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
 * With `changes` ({ diff }: a promise of the file's `git diff` with the whole file as context, or { untracked })
 * shows the file with its changes inline, and a Markdown file as its source.
 */
export function openPreview(ctx, { file, relPath, onEdit, text, title, label, changes }) {
	try {
		if (!ctx?.hasUI || typeof ctx.ui?.custom !== "function") return false;
		const given = text !== undefined;
		const loading = given ? textPreview(text) : changes ? changesPreview(file, changes) : readPreview(file);
		let host;
		const result = ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				host = tui;
				return given
					? new FilePreview({ relPath: title ?? "", tui, theme, done, loading, label: label ?? "Text" })
					: new FilePreview({ file, relPath, tui, theme, done, onEdit, loading, changes: Boolean(changes) });
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
