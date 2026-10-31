// The Music card's picker (./music.ts): a small pop-up over Pi, under the clicked row and inside the side column,
// at most 55 columns wide, drawn like the PROF tab's model picker (./prof-picker.ts), with two levels. First
// "cliamp · Playlists": "󰋑 Favorites" (the local provider's, counted from favorites.toml as favoritesCount says,
// at every draw), then the categories, as "Name · N tracks" ("1 track" for one; the one
// playing marked ●, the cursor ▸ in accent bold). Enter or a click on one opens its tracks in the same pop-up,
// "cliamp · <Name>": "󰋑 Title · Artist" (Nerd Font hearts, as JetBrains Mono has no ♡: filled in error on a favorite,
// as isFavorite says, outlined dim otherwise; the track
// playing marked ●), asked once per list while the pop-up is open, with a "Loading…" row meanwhile. Enter or a
// click on a track plays it; f toggles its ♥ (in Favorites an un-favorited track stays until the list is opened
// again); Esc, ← or h go back to the categories. ↑↓ or k/j and PgUp/PgDn move on
// both levels; q, Esc on the categories, or a click anywhere outside the pop-up (that click does nothing else)
// closes it without playing.
// @ts-nocheck

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PICKER_MAX_WIDTH, pressed } from "./prof-picker.ts";

const MAX_CHOICES = 16; // the Favorites and cliamp's 15 categories
const CHROME = 4; // top, title, footer, bottom
const EDGE = { top: "▔", bottom: "▁", left: "▏", right: "▕", topLeft: "\u{1FB7D}", topRight: "\u{1FB7E}", bottomRight: "\u{1FB7F}", bottomLeft: "\u{1FB7C}" };

const key = (playlist) => `${playlist.provider}/${playlist.id}`;
const tracks = (count) => `${count} ${count === 1 ? "track" : "tracks"}`;

/** Nerd Font's Material hearts: a favorite (filled) and not one (outlined). */
export const LOVED = "\u{F02D1}";
export const UNLOVED = "\u{F02D5}";

// Answers the rest of a click that closed the pop-up (release, click), so it reaches nothing under it.
const SWALLOW = { handleMouse: () => undefined, invalidate() {} };

// As prof-picker.ts does: while the pop-up is open the TUI's dispatchMouseToOverlay is wrapped on the instance,
// and a press that lands on no overlay, with the pop-up on top, closes it and is swallowed. Returns the unwrap.
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
			// an older TUI: the pop-up is the one on top
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
	constructor({ tui, theme, done, playlists, current, currentPath, tracksOf, onPlay, isFavorite, favoritesCount, onBookmark, open }) {
		Object.assign(this, { tui, theme, done, playlists, current, currentPath, tracksOf, onPlay, isFavorite, favoritesCount, onBookmark });
		this.outer = { cursor: 0, top: 0 }; // the categories
		this.inside = undefined; // { playlist, cursor, top } while a list's tracks show
		this.tracks = new Map(); // "provider/id" -> tracks, null when they could not be read, undefined while asked
		this.closed = false;
		this.unwrapMouse = closeOnOutsidePress(tui, this);
		this.move(playlists.findIndex((playlist) => this.playing(playlist)));
		const opened = playlists.find((playlist) => playlist.provider === "cliamp" && playlist.id === open);
		if (opened) this.enter(opened);
	}

	playing(playlist) {
		return playlist.provider === "cliamp" && playlist.id === this.current;
	}

	// A list's track count; the Favorites' is favorites.toml's, which a toggle changes at once.
	count(playlist) {
		if (playlist.provider !== "local" || playlist.id !== "Favorites" || typeof this.favoritesCount !== "function") return playlist.tracks;
		try {
			const count = this.favoritesCount();
			return Number.isFinite(count) ? count : playlist.tracks;
		} catch {
			return playlist.tracks;
		}
	}

	favorite(track) {
		try {
			return !!this.isFavorite?.(track);
		} catch {
			return false;
		}
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

	// The categories it has room for: at most MAX_CHOICES, and what the terminal leaves.
	page() {
		const rows = Number(this.tui?.terminal?.rows) || 24;
		return Math.max(1, Math.min(MAX_CHOICES, rows - CHROME));
	}

	// What the cursor moves over: the categories, or the open category's tracks ([] until they are read).
	list() {
		return this.inside ? this.tracks.get(key(this.inside.playlist)) || [] : this.playlists;
	}

	move(to) {
		const view = this.inside ?? this.outer;
		const count = this.list().length;
		if (!count) return;
		view.cursor = Math.max(0, Math.min(count - 1, to));
		if (view.cursor < view.top) view.top = view.cursor;
		if (view.cursor >= view.top + this.page()) view.top = view.cursor - this.page() + 1;
		this.redraw();
	}

	// The track playing when this is the category playing, else the first.
	firstTrack() {
		const tracks = this.list();
		const index = this.playing(this.inside.playlist) ? tracks.findIndex((track) => track.path === this.currentPath) : -1;
		this.move(Math.max(0, index));
	}

	enter(playlist) {
		this.inside = { playlist, cursor: 0, top: 0 };
		if (this.tracks.has(key(playlist))) return this.firstTrack();
		this.tracks.set(key(playlist), undefined);
		Promise.resolve()
			.then(() => this.tracksOf(playlist))
			.catch(() => undefined)
			.then((tracks) => {
				this.tracks.set(key(playlist), Array.isArray(tracks) ? tracks : null);
				if (this.inside?.playlist === playlist) this.firstTrack();
				this.redraw();
			});
		this.redraw();
	}

	// The selected track's ♥: onBookmark flips it at once (and back when it could not be saved).
	toggle(index) {
		const track = this.list()[index];
		if (!this.inside || !track) return;
		let answer;
		try {
			answer = this.onBookmark?.(this.inside.playlist, track);
		} catch {
			// a toggle that throws changes nothing
		}
		this.redraw();
		Promise.resolve(answer)
			.catch(() => false)
			.then(() => this.redraw());
	}

	back() {
		this.inside = undefined;
		this.redraw();
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		this.unwrapMouse();
		this.done(undefined);
		this.redraw(true); // repaint every cell behind the closed overlay
	}

	// A category opens its tracks; a track is played and the pop-up closes.
	pick(index) {
		const chosen = this.list()[index];
		if (chosen === undefined || this.closed) return;
		if (!this.inside) return this.enter(chosen);
		const playlist = this.inside.playlist;
		this.close();
		this.onPlay(playlist, index);
	}

	handleInput(data) {
		const cursor = (this.inside ?? this.outer).cursor;
		if (data === "q") return this.close();
		if (pressed(data, "escape") || (this.inside && (pressed(data, "left") || data === "\x1b[D" || data === "h"))) return this.inside ? this.back() : this.close();
		if (pressed(data, "enter")) return this.pick(cursor);
		if (data === "f") return this.toggle(cursor);
		if (pressed(data, "down") || data === "j") return this.move(cursor + 1);
		if (pressed(data, "up") || data === "k") return this.move(cursor - 1);
		if (pressed(data, "pageDown")) return this.move(cursor + this.page());
		if (pressed(data, "pageUp")) return this.move(cursor - this.page());
	}

	handleMouse(event) {
		const view = this.inside ?? this.outer;
		if (event?.type === "wheel" && event.wheelDelta) {
			this.move(view.cursor + (event.wheelDelta > 0 ? 1 : -1));
			return { handled: true, render: true };
		}
		if (event?.type !== "click" || event.button !== "left") return event?.type === "press" || event?.type === "release" ? { handled: true } : undefined;
		const index = view.top + (event.y - 2); // top, title, then the rows
		if (event.y >= 2 && index < Math.min(this.list().length, view.top + this.page())) this.pick(index);
		return { handled: true, render: true };
	}

	render(width) {
		const inner = Math.max(1, width - 4);
		const cut = (plain, room) => (visibleWidth(plain) > room ? truncateToWidth(plain, Math.max(1, room), "…") : plain);
		const text = (role, plain, bold = false, room = inner) => this.paint(role, bold ? this.bold(cut(plain, room)) : cut(plain, room));
		const fit = (row) => `${this.paint("border", EDGE.left)} ${row}${" ".repeat(Math.max(0, inner - visibleWidth(row)))} ${this.paint("border", EDGE.right)}`;
		const view = this.inside ?? this.outer;
		const list = this.list();
		const rows = [];
		for (let index = view.top; index < Math.min(list.length, view.top + this.page()); index++) {
			const mark = index === view.cursor ? "▸" : " ";
			if (!this.inside) {
				const playlist = list[index];
				const current = this.playing(playlist);
				const heart = playlist.provider === "local" ? `${this.paint("error", LOVED)} ` : "";
				const label = cut(`${current ? "● " : ""}${playlist.name} · ${tracks(this.count(playlist))}`, inner - 2 - (heart ? 2 : 0));
				const role = index === view.cursor ? "accent" : current ? "text" : "muted";
				const paintRole = (plain) => this.paint(role, index === view.cursor ? this.bold(plain) : plain);
				rows.push(`${paintRole(mark)} ${heart}${paintRole(label)}`);
				continue;
			}
			// The ♥ column is kept on every row, so the titles line up.
			const track = list[index];
			const loved = this.favorite(track);
			const head = `${track.path && track.path === this.currentPath ? "● " : ""}${track.title || "Unknown track"}`;
			const label = track.artist ? `${head} · ${track.artist}` : head;
			const body =
				index === view.cursor || visibleWidth(label) > inner - 4
					? text(index === view.cursor ? "accent" : "text", label, index === view.cursor, inner - 4)
					: `${this.paint("text", head)}${track.artist ? `${this.paint("dim", " · ")}${this.paint("muted", track.artist)}` : ""}`;
			rows.push(`${index === view.cursor ? this.paint("accent", mark) : mark} ${loved ? this.paint("error", LOVED) : this.paint("dim", UNLOVED)} ${body}`);
		}
		if (this.inside && !list.length) {
			const read = this.tracks.get(key(this.inside.playlist));
			rows.push(text("dim", read === undefined ? "  Loading…" : read === null ? "  Could not read the tracks" : "  No tracks"));
		}
		const more = list.length > this.page() ? ` · ${view.cursor + 1}/${list.length}` : "";
		return [
			this.paint("border", `${EDGE.topLeft}${EDGE.top.repeat(inner + 2)}${EDGE.topRight}`),
			fit(text("toolTitle", `cliamp · ${this.inside ? this.inside.playlist.name : "Playlists"}`, true)),
			...rows.map(fit),
			fit(text("dim", this.inside ? `Esc ← back · f ${LOVED} · ↑↓ · enter play${more}` : `Esc close · ↑↓ · enter pick${more}`)),
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
 * Opens the picker over Pi: `playlists` ({ provider, id, name, tracks }), `current` (the cliamp category playing)
 * and `currentPath` (the track playing) marked, `open` (a cliamp id) to start on that category's tracks, placed
 * under the clicked row and centered over the card (`at`: the click's screenX/screenY, its x in the row and the row's width, when known), kept on screen.
 * `tracksOf(playlist)` resolves its tracks (cliamp's objects: title, artist, album, path), undefined when they
 * cannot be read. `onPlay(playlist, index)` runs once a track is picked; nothing runs when it closes otherwise.
 * `favoritesCount()` is how many favorites there are, for the Favorites entry. `isFavorite(track)` says whether a
 * track has its ♥; `onBookmark(playlist, track)` toggles it (isFavorite
 * answering the new state at once) and resolves true once it is saved. False when Pi has no overlay UI here.
 */
export function openMusicPicker(ctx, { playlists, current, currentPath, tracksOf, onPlay, isFavorite, favoritesCount, onBookmark, open, at }) {
	try {
		if (!ctx?.hasUI || typeof ctx.ui?.custom !== "function") return false;
		let host;
		const result = ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				host = tui;
				return new Picker({ tui, theme, done, playlists, current, currentPath, tracksOf, onPlay, isFavorite, favoritesCount, onBookmark, open });
			},
			{
				overlay: true,
				overlayOptions: () => {
					const columns = Number(host?.terminal?.columns) || 80;
					const rows = Number(host?.terminal?.rows) || 24;
					const width = Math.min(PICKER_MAX_WIDTH, columns);
					const height = CHROME + Math.max(1, Math.min(MAX_CHOICES, rows - CHROME));
					if (!Number.isFinite(at?.screenY)) return { anchor: "center", width, maxHeight: "85%" };
					// Centered over the card: its content starts at screenX - x, two columns inside its outline, and is
					// `at.width` wide; without them, against the right edge.
					const known = Number.isFinite(at.screenX) && Number.isFinite(at.x);
					const card = known && Number.isFinite(at.width) ? { left: at.screenX - at.x - 2, width: at.width + 4 } : undefined;
					const left = card ? card.left + Math.floor((card.width - width) / 2) : known ? at.screenX - at.x + 1 : columns - width;
					const col = Math.max(0, Math.min(columns - width, left));
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
