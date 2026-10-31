// A live pop-up over Pi for one piece of running work, opened from a ↗ on its row: the Agents card's subagents
// (openAgentPopup, below) and the Jobs card's jobs (openJobPopup, at the end). The same outline as the file preview (./tree-preview.ts)
// around a title row, a muted subtitle, then the body and the footer "Esc close · ↑↓ PgUp/PgDn Home/End · following".
// The body comes from a source that the pop-up asks again every `interval` ms (500 by default) while it is open; a
// change redraws it. It follows the end while the user has not scrolled up; ↑↓ a row, PgUp/PgDn a page, Home/End
// the ends, the wheel three rows; End or f follows again, as does scrolling back down to the end. Esc or q closes
// it, and so does a click anywhere outside it (that click does nothing else). Its height stays the same while the
// body grows, so it does not jump as the work goes on.
//
// A subagent's pop-up reads gentle-pi's presence file for the session (./run-data.ts): the title is gentle-pi's
// task header (agent · status · model · elapsed), the subtitle the task's label, the body its thread drawn with
// gentle-pi's own renderThreadItem, as the alt+k window draws it, after "… N earlier items not kept" when gentle-pi
// dropped some. When the task leaves the file (it finished) the last thread stays, under the status "finished".
// Without gentle-pi's renderer or header the same rows are drawn here.
//
// A job's pop-up shows "label · id", its status ("running · 12s", "finished · exit 1 · 1m02s") and the tail of
// its log, like tail -f: the last 256 KiB, without escape sequences, each line cut to the width.
// @ts-nocheck

import * as PiTui from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readActivity, readTail } from "./run-data.ts";
import { previewWidthFor } from "./tree-preview.ts";

const CHROME = 6; // top, title, subtitle, blank row, footer, bottom
const WHEEL_LINES = 3;
const INTERVAL_MS = 500;

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

const paint = (theme, role, text) => {
	try {
		return theme?.fg ? theme.fg(role, text) : text;
	} catch {
		return text;
	}
};
const bold = (theme, text) => {
	try {
		return theme?.bold ? theme.bold(text) : text;
	} catch {
		return text;
	}
};

// Outline strokes at the outer edge of their cells, as the file preview draws them.
const EDGE = { top: "▔", bottom: "▁", left: "▏", right: "▕", topLeft: "\u{1FB7D}", topRight: "\u{1FB7E}", bottomRight: "\u{1FB7F}", bottomLeft: "\u{1FB7C}" };

// Answers the rest of a click that closed the pop-up (release, click), so it reaches nothing under it.
const SWALLOW = { handleMouse: () => undefined, invalidate() {} };

// As the file preview does it (tree-preview.ts closeOnOutsidePress): Pi 1.4.0 hands an overlay the mouse only
// inside its box, so while the pop-up is open the TUI's dispatchMouseToOverlay is wrapped on the instance: a press
// that lands on no overlay, with the pop-up on top, closes it and is answered with a target that swallows the
// release and the click. Returns the unwrap.
function closeOnOutsidePress(tui, popup) {
	const original = tui?.dispatchMouseToOverlay;
	if (typeof original !== "function") return () => {};
	const own = Object.hasOwn(tui, "dispatchMouseToOverlay");
	const wrapped = function (event) {
		const routed = original.call(this, event);
		if (routed?.hit || event?.type !== "press" || popup.closed) return routed;
		try {
			const top = tui.getTopmostVisibleOverlay?.();
			if (top && top.component !== popup) return routed; // another overlay is over it
		} catch {
			// an older TUI: the pop-up is the one on top
		}
		popup.close();
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

/**
 * The live pop-up. `load()` gives the current view, { title, subtitle, key, lines(width, theme) }, or undefined
 * to keep the last one; a view whose key or title changed is drawn.
 */
class LivePopup {
	constructor({ tui, theme, done, load, interval }) {
		Object.assign(this, { tui, theme, done, load });
		this.unwrapMouse = closeOnOutsidePress(tui, this);
		this.top = 0;
		this.follow = true;
		this.closed = false;
		this.view = undefined;
		this.drawn = undefined; // { view, width, rows } of the last body drawn
		this.refresh(false);
		this.timer = setInterval(() => this.refresh(), interval ?? INTERVAL_MS);
		this.timer.unref?.();
	}

	/** Asks the source again; redraws when what it shows changed. */
	refresh(redraw = true) {
		if (this.closed) return;
		let next;
		try {
			next = this.load();
		} catch {
			next = undefined; // a failing source keeps the last view
		}
		if (!next || (next.key === this.view?.key && next.title === this.view?.title && next.subtitle === this.view?.subtitle)) return;
		this.view = next;
		if (redraw) this.redraw();
	}

	redraw(force) {
		try {
			this.tui?.requestRender?.(force);
		} catch {
			// a dead terminal must not break the pop-up
		}
	}

	// Body rows the overlay has room for: Pi caps it at 85% of the terminal.
	page() {
		const rows = Number(this.tui?.terminal?.rows) || 24;
		return Math.max(1, Math.floor(rows * 0.85) - CHROME);
	}

	rows(width) {
		const view = this.view;
		if (!view) return [];
		if (this.drawn?.view !== view || this.drawn.width !== width) {
			let rows;
			try {
				rows = view.lines(width, this.theme).map(String);
			} catch {
				rows = [paint(this.theme, "warning", "Cannot draw this thread")];
			}
			this.drawn = { view, width, rows };
		}
		return this.drawn.rows;
	}

	last() {
		return Math.max(0, (this.drawn?.rows.length ?? 0) - this.page());
	}

	scrollTo(top) {
		const next = Math.max(0, Math.min(top, this.last()));
		this.follow = next >= this.last();
		if (next !== this.top) this.top = next;
		this.redraw();
		return true;
	}

	followEnd() {
		this.follow = true;
		this.redraw();
		return true;
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.timer);
		this.unwrapMouse();
		this.done(undefined);
		this.redraw(true); // repaint every cell behind the closed overlay
	}

	handleInput(data) {
		if (pressed(data, "escape") || letter(data, "q")) return this.close();
		if (pressed(data, "end") || letter(data, "f") || letter(data, "G")) return this.followEnd();
		if (pressed(data, "down") || letter(data, "j")) return this.scrollTo(this.top + 1);
		if (pressed(data, "up") || letter(data, "k")) return this.scrollTo(this.top - 1);
		if (pressed(data, "pageDown")) return this.scrollTo(this.top + this.page());
		if (pressed(data, "pageUp")) return this.scrollTo(this.top - this.page());
		if (pressed(data, "home") || letter(data, "g")) return this.scrollTo(0);
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
			return `${paint(this.theme, "border", EDGE.left)} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${paint(this.theme, "border", EDGE.right)}`;
		};
		// Plain text cut before it is painted, so the color reaches the "…".
		const text = (role, plain, strong = false) => {
			const cut = visibleWidth(plain) > inner ? truncateToWidth(plain, inner, "…") : plain;
			return paint(this.theme, role, strong ? bold(this.theme, cut) : cut);
		};
		const page = this.page();
		let body;
		let footer = "Esc close";
		try {
			const rows = this.rows(inner);
			if (this.follow) this.top = this.last();
			this.top = Math.max(0, Math.min(this.top, this.last()));
			body = this.view ? rows.slice(this.top, this.top + page) : [text("dim", "Reading…")];
			footer += ` · ↑↓ PgUp/PgDn Home/End · ${this.follow ? "following" : "f follow"}`;
		} catch {
			body = [text("warning", "Cannot draw this thread")];
		}
		while (body.length < page) body.push("");
		return [
			paint(this.theme, "border", `${EDGE.topLeft}${EDGE.top.repeat(inner + 2)}${EDGE.topRight}`),
			fit(text("toolTitle", this.view?.title ?? "", true)),
			fit(text("muted", this.view?.subtitle ?? "")),
			fit(""),
			...body.map(fit),
			fit(text("dim", footer)),
			paint(this.theme, "border", `${EDGE.bottomLeft}${EDGE.bottom.repeat(inner + 2)}${EDGE.bottomRight}`),
		];
	}

	invalidate() {}

	// Pi disposes the component when it closes the overlay, by whatever path.
	dispose() {
		this.closed = true;
		clearInterval(this.timer);
		this.unwrapMouse();
	}
}

/**
 * Opens a live pop-up over Pi that asks `load()` for its view every `interval` ms (see LivePopup). Returns false,
 * having opened nothing, when Pi has no overlay UI here.
 */
export function openLivePopup(ctx, { load, interval }) {
	try {
		if (!ctx?.hasUI || typeof ctx.ui?.custom !== "function") return false;
		let host;
		const result = ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				host = tui;
				return new LivePopup({ tui, theme, done, load, interval });
			},
			{
				overlay: true,
				// Sized like the file preview, after the terminal it opens on.
				overlayOptions: () => ({ anchor: "center", width: previewWidthFor(host?.terminal?.columns), minWidth: 60, maxHeight: "85%" }),
			},
		);
		Promise.resolve(result).catch(() => undefined);
		return true;
	} catch {
		return false; // a stale ctx or a UI without overlays
	}
}

// ---------------------------------------------------------------------------
// A subagent's thread
// ---------------------------------------------------------------------------

const wrap = (text, width) => {
	try {
		if (typeof PiTui.wrapTextWithAnsi === "function") return PiTui.wrapTextWithAnsi(text, width);
	} catch {
		// an older pi-tui
	}
	return [truncateToWidth(text, width, "…")];
};

// Like gentle-pi's lib/agents-thread-view.ts: each line of a text, indented, wrapped to the width.
function indented(theme, role, text, width, indent) {
	const prefix = " ".repeat(Math.min(indent, Math.max(0, width - 1)));
	const room = Math.max(1, width - prefix.length);
	return String(text).split("\n").flatMap((source) => (source ? wrap(source, room) : [""]).map((part) => paint(theme, role, `${prefix}${part}`)));
}
const labelRow = (theme, role, text, width) => paint(theme, role, truncateToWidth(text, Math.max(1, width), "…"));

/** A thread item drawn as gentle-pi's renderThreadItem draws it, for when gentle-pi's cannot be loaded. */
export function fallbackThreadItem(item, theme, width) {
	if (width <= 0) return [];
	switch (item?.kind) {
		case "text":
			return [labelRow(theme, "customMessageLabel", "Text", width), ...indented(theme, "text", item.text, width, 2)];
		case "thinking":
			return [labelRow(theme, "customMessageLabel", "Thinking", width), ...indented(theme, "dim", item.text, width, 2)];
		case "note":
			return [labelRow(theme, "muted", "Note", width), ...indented(theme, "muted", item.text, width, 2)];
		case "tool": {
			const status = item.isError ? "Error" : item.running ? "Running" : "Complete";
			const header = labelRow(theme, item.isError ? "error" : "accent", `Tool · ${item.name} · ${status}`, width);
			if (!item.output) return [header];
			return [header, labelRow(theme, "muted", "  Output", width), ...indented(theme, "muted", item.output, width, 4)];
		}
		default:
			return [];
	}
}

/** gentle-pi's elapsed format (lib/agents-widget.ts formatElapsed): 42s, 3m07s, 1h05m. */
export function formatElapsed(ms) {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** A task's title row as gentle-pi's taskHeader writes it: agent · status · model · elapsed. */
export function fallbackHeader(task, now) {
	return [task.agent, task.status, task.model, task.startedAt === null ? "" : formatElapsed((task.endedAt ?? now) - task.startedAt)].filter(Boolean).join(" · ");
}

function header(task, lib, now) {
	try {
		if (typeof lib?.taskHeader === "function") return String(lib.taskHeader({ tokens: 0, cost: 0, ...task }, now));
	} catch {
		// gentle-pi changed its header: draw ours
	}
	return fallbackHeader(task, now);
}

/** The thread's rows at `width`: "… N earlier items not kept", then each item. */
export function threadLines(thread, theme, width, lib) {
	const draw = typeof lib?.renderThreadItem === "function" ? lib.renderThreadItem : fallbackThreadItem;
	const rows = thread.dropped > 0 ? [paint(theme, "dim", `… ${thread.dropped} earlier items not kept`)] : [];
	for (const item of thread.items) {
		let drawn;
		try {
			drawn = draw(item, theme, width);
		} catch {
			drawn = fallbackThreadItem(item, theme, width);
		}
		if (Array.isArray(drawn)) rows.push(...drawn);
	}
	return rows;
}

/**
 * The source of a subagent's pop-up: task `taskId` in the activity `file`. `lib` holds gentle-pi's
 * renderThreadItem and taskHeader when they loaded. Once the task has left a file that could be read, the last
 * thread stays, finished at the moment it was last seen.
 */
export function agentSource({ file, taskId, lib, read = readActivity, now = Date.now }) {
	let task;
	let stamp;
	let finished;
	const view = () => ({
		title: header(finished ? { ...task, status: "finished", endedAt: task.endedAt ?? finished } : task, lib, now()),
		subtitle: task.label,
		key: `${finished ? "finished" : "live"}:${stamp}`,
		lines: (width, theme) => threadLines(task.thread, theme, width, lib),
	});
	return () => {
		if (finished) return view();
		const result = read(file);
		if (!result.error && result.stamp !== stamp) {
			const next = result.tasks.find((candidate) => candidate.id === taskId);
			if (next) {
				task = next;
				stamp = result.stamp;
			} else if (task) finished = now();
		}
		return task ? view() : undefined;
	};
}

/**
 * Opens the live pop-up of subagent `taskId` from the activity `file`. Returns false, having opened nothing, when
 * Pi has no overlay UI here or the task cannot be read from the file: the caller then opens gentle-pi's list.
 */
export function openAgentPopup(ctx, { file, taskId, lib, interval }) {
	if (!ctx?.hasUI || typeof ctx.ui?.custom !== "function") return false;
	const load = agentSource({ file, taskId, lib });
	const first = load();
	if (!first) return false;
	let shown = false;
	return openLivePopup(ctx, { load: () => (shown ? load() : ((shown = true), first)), interval });
}

// ---------------------------------------------------------------------------
// A background job's output
// ---------------------------------------------------------------------------

// The status row of a job: "running · 12s", or "finished · exit 1 · 1m02s" once the Jobs card's event has its end.
function jobStatus(job, now) {
	const end = job.status === undefined ? now : job.endedAt ?? now;
	const elapsed = typeof job.startedAt === "number" ? formatElapsed(end - job.startedAt) : "";
	const exit = job.status !== undefined && typeof job.exitCode === "number" ? `exit ${job.exitCode}` : "";
	return [job.status === undefined ? "running" : "finished", exit, elapsed].filter(Boolean).join(" · ");
}

/**
 * The source of a job's pop-up: the tail of its log `file` (./run-data.ts readTail), under "label · id" and its
 * status. `job()` gives the job as the Jobs card last heard of it; once the card drops it, the last one stays. A log
 * that cannot be read for a moment keeps the lines last read.
 */
export function jobSource({ file, id, job, read = readTail, now = Date.now }) {
	let known;
	let tail = { lines: [], stamp: undefined };
	return () => {
		try {
			known = job?.() ?? known;
		} catch {
			// the card's trouble: keep what was known
		}
		const next = read(file);
		if (!next.error) tail = next;
		const shown = tail;
		return {
			title: `${known?.label || id} · ${id}`,
			subtitle: known ? jobStatus(known, now()) : "",
			key: `${shown.stamp}`,
			lines: (width, theme) => (shown.lines.length ? shown.lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line)) : [paint(theme, "dim", "(no output yet)")]),
		};
	};
}

/** Opens the live pop-up of job `id` on its log `file`. Returns false, having opened nothing, without an overlay UI. */
export function openJobPopup(ctx, { file, id, job, interval }) {
	if (!ctx?.hasUI || typeof ctx.ui?.custom !== "function") return false;
	return openLivePopup(ctx, { load: jobSource({ file, id, job }), interval });
}
