// The PROF tab's model picker (./prof.ts): a small pop-up over Pi, under the row that was clicked and inside the
// side column, at most 55 columns wide. The outline is drawn at the cells' outer edge like the TREE preview's
// (./tree-preview.ts), around "Model · <agent> · <profile>", a filter row, the choices (the current one marked
// ●, the cursor ▸ in accent bold) and "Esc close · ↑↓ · enter pick". Typing filters the list, Backspace
// undoes it; ↑↓ PgUp/PgDn move, Enter or a click on a choice picks it; Esc, or a click anywhere outside the
// pop-up (that click does nothing else), closes it without picking.
// @ts-nocheck

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const PICKER_MAX_WIDTH = 55;
const MAX_CHOICES = 12;
const CHROME = 5; // top, title, filter, footer, bottom
const EDGE = { top: "▔", bottom: "▁", left: "▏", right: "▕", topLeft: "\u{1FB7D}", topRight: "\u{1FB7E}", bottomRight: "\u{1FB7F}", bottomLeft: "\u{1FB7C}" };
const RAW = { pageUp: ["\x1b[5~"], pageDown: ["\x1b[6~"], backspace: ["\x7f", "\b"], "ctrl+s": ["\x13"] };
/** True when `data` is the key `name` (a Key name or a pi-tui key id such as "ctrl+s"), raw sequences included. */
export const pressed = (data, name) => {
	try {
		if (matchesKey(data, Key?.[name] ?? name)) return true;
	} catch {
		// an id this pi-tui does not know
	}
	return (RAW[name] ?? []).includes(data);
};

// Answers the rest of a click that closed the pop-up (release, click), so it reaches nothing under it.
const SWALLOW = { handleMouse: () => undefined, invalidate() {} };

// As the TREE preview does (Pi gives an overlay no option for a click outside it): while the picker is open
// the TUI's dispatchMouseToOverlay is wrapped on the instance, and a press that lands on no overlay, with the
// picker on top, closes it and is swallowed. Returns the unwrap.
function closeOnOutsidePress(tui, picker) {
	const original = tui?.dispatchMouseToOverlay;
	if (typeof original !== "function") return () => {};
	const own = Object.hasOwn(tui, "dispatchMouseToOverlay");
	const wrapped = function (event) {
		const routed = original.call(this, event);
		if (routed?.hit || event?.type !== "press" || picker.closed) return routed;
		try {
			const top = tui.getTopmostVisibleOverlay?.();
			if (top && top.component !== picker) return routed; // another overlay is over it
		} catch {
			// an older TUI: the picker is the one on top
		}
		picker.close();
		const target = { component: SWALLOW, originX: 0, originY: 0, width: event.width, height: event.height };
		return { hit: true, result: { handled: true, render: true, target } };
	};
	try {
		tui.dispatchMouseToOverlay = wrapped;
	} catch {
		return () => {};
	}
	return () => {
		if (tui.dispatchMouseToOverlay !== wrapped) return;
		if (own) tui.dispatchMouseToOverlay = original;
		else delete tui.dispatchMouseToOverlay;
	};
}

class Picker {
	constructor({ tui, theme, done, title, choices, current, onPick }) {
		Object.assign(this, { tui, theme, done, title, choices, current, onPick });
		this.query = "";
		this.cursor = Math.max(0, choices.indexOf(current));
		this.top = 0;
		this.closed = false;
		this.unwrapMouse = closeOnOutsidePress(tui, this);
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
			// a dead terminal must not break the picker
		}
	}

	shown() {
		const query = this.query.toLowerCase();
		return query ? this.choices.filter((choice) => choice.toLowerCase().includes(query)) : this.choices;
	}

	// The choices it has room for: at most MAX_CHOICES, and what the terminal leaves.
	page() {
		const rows = Number(this.tui?.terminal?.rows) || 24;
		return Math.max(1, Math.min(MAX_CHOICES, rows - CHROME));
	}

	move(to) {
		const count = this.shown().length;
		if (!count) return;
		this.cursor = Math.max(0, Math.min(count - 1, to));
		if (this.cursor < this.top) this.top = this.cursor;
		if (this.cursor >= this.top + this.page()) this.top = this.cursor - this.page() + 1;
		this.redraw();
	}

	filter(query) {
		this.query = query;
		this.cursor = 0;
		this.top = 0;
		this.redraw();
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		this.unwrapMouse();
		this.done(undefined);
		this.redraw(true); // repaint every cell behind the closed overlay
	}

	pick(choice) {
		if (choice === undefined || this.closed) return;
		this.close();
		this.onPick(choice);
	}

	handleInput(data) {
		if (pressed(data, "escape")) return this.close();
		if (pressed(data, "enter")) return this.pick(this.shown()[this.cursor]);
		if (pressed(data, "down")) return this.move(this.cursor + 1);
		if (pressed(data, "up")) return this.move(this.cursor - 1);
		if (pressed(data, "pageDown")) return this.move(this.cursor + this.page());
		if (pressed(data, "pageUp")) return this.move(this.cursor - this.page());
		if (pressed(data, "backspace")) return this.filter(this.query.slice(0, -1));
		if (typeof data === "string" && data.length === 1 && data >= " " && data !== "\x7f") return this.filter(this.query + data);
	}

	handleMouse(event) {
		if (event?.type === "wheel" && event.wheelDelta) {
			this.move(this.cursor + (event.wheelDelta > 0 ? 1 : -1));
			return { handled: true, render: true };
		}
		if (event?.type !== "click" || event.button !== "left") return event?.type === "press" || event?.type === "release" ? { handled: true } : undefined;
		const index = this.top + (event.y - 3); // top, title, filter, then the choices
		const shown = this.shown();
		if (event.y >= 3 && index < Math.min(shown.length, this.top + this.page())) this.pick(shown[index]);
		return { handled: true, render: true };
	}

	render(width) {
		const inner = Math.max(1, width - 4);
		const text = (role, plain, bold = false) => {
			const cut = visibleWidth(plain) > inner ? truncateToWidth(plain, inner, "…") : plain;
			return this.paint(role, bold ? this.bold(cut) : cut);
		};
		const fit = (row) => `${this.paint("border", EDGE.left)} ${row}${" ".repeat(Math.max(0, inner - visibleWidth(row)))} ${this.paint("border", EDGE.right)}`;
		const shown = this.shown();
		const rows = [];
		for (let index = this.top; index < Math.min(shown.length, this.top + this.page()); index++) {
			const choice = shown[index];
			const mark = choice === this.current ? "● " : "";
			const label = `${index === this.cursor ? "▸" : " "} ${mark}${choice}`;
			rows.push(index === this.cursor ? text("accent", label, true) : text(choice === this.current ? "text" : "muted", label));
		}
		if (!shown.length) rows.push(text("dim", "  no model matches"));
		const more = shown.length > this.page() ? ` · ${this.cursor + 1}/${shown.length}` : "";
		return [
			this.paint("border", `${EDGE.topLeft}${EDGE.top.repeat(inner + 2)}${EDGE.topRight}`),
			fit(text("toolTitle", this.title, true)),
			fit(this.query ? text("text", `filter: ${this.query}▏`) : text("dim", "type to filter")),
			...rows.map(fit),
			fit(text("dim", `Esc close · ↑↓ · enter pick${more}`)),
			this.paint("border", `${EDGE.bottomLeft}${EDGE.bottom.repeat(inner + 2)}${EDGE.bottomRight}`),
		];
	}

	invalidate() {}

	dispose() {
		this.closed = true;
		this.unwrapMouse();
	}
}

/**
 * Opens the picker over Pi: `choices` (strings) under `title`, `current` marked, placed under the clicked row
 * (`at`: the click's screenX/screenY and its x in the row, when known) and kept on screen. `onPick(choice)`
 * runs once a choice is picked; nothing runs when it closes otherwise. `onOpen(picker)` gets the pop-up once Pi
 * builds it (its handleInput, its `closed`), for a caller that hands it keys. False when Pi has no overlay UI here.
 */
export function openPicker(ctx, { title, choices, current, onPick, at, onOpen }) {
	try {
		if (!ctx?.hasUI || typeof ctx.ui?.custom !== "function") return false;
		let host;
		const result = ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				host = tui;
				const picker = new Picker({ tui, theme, done, title, choices, current, onPick });
				onOpen?.(picker);
				return picker;
			},
			{
				overlay: true,
				overlayOptions: () => {
					const columns = Number(host?.terminal?.columns) || 80;
					const rows = Number(host?.terminal?.rows) || 24;
					const width = Math.min(PICKER_MAX_WIDTH, columns);
					const height = CHROME + Math.max(1, Math.min(choices.length, MAX_CHOICES, rows - CHROME));
					if (!Number.isFinite(at?.screenY)) return { anchor: "center", width, maxHeight: "85%" };
					// The column's content starts at screenX - x; the picker sits inside it, flush with its right edge.
					const left = Number.isFinite(at.screenX) && Number.isFinite(at.x) ? at.screenX - at.x : columns - width;
					const col = Math.max(0, Math.min(columns - width, left + 1));
					const row = Math.max(0, Math.min(rows - height, at.screenY + 1));
					return { row, col, width, maxHeight: rows };
				},
			},
		);
		Promise.resolve(result).catch(() => undefined);
		return true;
	} catch {
		return false; // a stale ctx or a UI without overlays
	}
}
