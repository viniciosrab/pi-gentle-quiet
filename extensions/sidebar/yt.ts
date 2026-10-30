// The YT tab of gentle-quiet's side column (the contract is in ./tabs.ts), after pi-cinlodev-cute's YouTube
// card (src/youtube/youtube-card.ts). It reads the player pi-youtube-player publishes on
// globalThis[Symbol.for("pi-youtube-player")] (getState, on("stateChange"), and its controls) and draws two
// cards, each folded and opened by a click on its title as cute's sections:
//
//   ♪ YouTube Music   the play state (♪ Playing, ♪ Paused), as cute's ♪ SONANDO; the cover (./yt-cover.ts,
//                     where the terminal draws Kitty images; cute's ┌─────┐ stand-in elsewhere) beside the
//                     play mark and the title, and 👤 the artist; the scrubber with the times
//                     at its ends; [ ⏮  Prev ] [ ⏸  Pause ] [ ⏭  Next ] centered; repeat, volume down and up,
//                     shuffle and picture in picture (lit while the player floats); the track that comes next.
//   ≡ Queue (n)       the queue, twelve tracks at a time (the wheel over it scrolls it), the playing one
//                     marked ♪; a click plays a track.
//
// With no browser connected, cute's waiting card; without pi-youtube-player, one card saying so. The service
// publishes no seek, so the scrubber seeks only when the player has a seek(seconds) of its own.
// The player sends its whole state every second, changed or not. The tab draws each one at the last width
// and asks for a redraw only when the rows differ from the drawn ones (the progress, every second while
// playing; nothing while paused), and lets go of the player once its redraws stop being drawn: another tab
// is showing. Its next render listens again.
// @ts-nocheck

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createCover } from "./yt-cover.ts";
import type { SidebarHost, SidebarTab } from "./tabs.ts";

export const YOUTUBE_PLAYER_SYMBOL = Symbol.for("pi-youtube-player");
export const PLAYER_REPO = "github.com/CinloDev/pi-youtube-player";

const QUEUE_ROWS = 12;
const HIDDEN_MS = 1500; // a redraw asked for and not drawn for this long: the tab is not showing
const strip = (text) => String(text).replace(/\x1b\[[0-9;:]*m/g, "");
const cut = (text, width) => (visibleWidth(text) <= width ? text : truncateToWidth(text, Math.max(0, width), "…"));

/** cute's mm:ss, h:mm:ss past an hour. */
export function formatTime(seconds) {
	const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	const pad = (value) => String(value).padStart(2, "0");
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${pad(minutes)}:${pad(total % 60)}`;
}

const cleanTitle = (title) =>
	String(title ?? "")
		.replace(/[\u00A0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, " ")
		.replace(/\s+/g, " ")
		.toLowerCase()
		.trim();

/** cute's artist: "Artist • Song • 2016" without the song, "YouTube Music" when there is none. */
export function cleanArtist(artist, title) {
	if (!artist || !String(artist).trim()) return "YouTube Music";
	const parts = String(artist).trim().split(/\s+[•·]\s+/);
	if (parts.length < 2) return String(artist).trim();
	const current = cleanTitle(title);
	const kept = parts.filter((part) => {
		const clean = cleanTitle(part);
		return clean && !(current && (clean === current || current.includes(clean) || clean.includes(current)));
	});
	return (kept[0] ?? parts[0]).trim();
}

const player = () => {
	const published = globalThis[YOUTUBE_PLAYER_SYMBOL];
	return published && typeof published.getState === "function" ? published : undefined;
};

export function createTab(host: SidebarHost, options = {}): SidebarTab {
	const fg = (role, text) => host.fg(role, text);
	const now = options.now ?? Date.now;
	const cover = options.cover ?? createCover(() => host.requestRender());
	const open = { nowPlaying: true, queue: true };
	let queueTop = 0;
	let hitboxes = []; // { line, startX, endX, action }
	let queueLines = [-1, -1]; // the queue card's first and last line
	let listening; // { source, stop }
	let drawnWidth; // the width the last render drew at
	let drawn = ""; // the rows the last render drew
	let pendingSince; // when a redraw was asked for that no render has drawn yet

	const stop = () => {
		try {
			listening?.stop?.();
		} catch {
			// the player went away: nothing to let go of
		}
		listening = undefined;
	};
	const listen = (source) => {
		if (listening?.source === source) return;
		stop();
		if (!source || typeof source.on !== "function") return;
		try {
			const off = source.on("stateChange", () => {
				if (pendingSince !== undefined) {
					if (now() - pendingSince > HIDDEN_MS) stop();
					return;
				}
				if (!changed()) return;
				pendingSince = now();
				host.requestRender();
			});
			listening = { source, stop: off };
		} catch {
			listening = undefined;
		}
	};

	// Whether the player's state now draws other rows than the last render drew (the hitboxes stay the drawn ones).
	const changed = () => {
		if (drawnWidth === undefined) return true;
		const kept = [hitboxes, queueLines];
		try {
			return rows(drawnWidth).join("\n") !== drawn;
		} catch {
			return true;
		} finally {
			[hitboxes, queueLines] = kept;
		}
	};

	// A card with its rows' hitboxes moved to where the card puts them: rows start two under the title.
	const card = (title, rows, width, titleAction, top) => {
		const lines = host.card(title, rows.map((row) => (typeof row === "string" ? row : row.text)), width);
		const titleLine = Math.max(0, lines.findIndex((line) => strip(line).includes(title)));
		const offset = Math.ceil((width - host.inner(width)) / 2);
		if (titleAction) hitboxes.push({ line: top + titleLine, startX: 0, endX: width, action: titleAction });
		rows.forEach((row, index) => {
			for (const span of row.spans ?? []) hitboxes.push({ ...span, line: top + titleLine + 2 + index, startX: span.startX + offset, endX: span.endX + offset });
		});
		return lines;
	};

	// Buttons in a row, centered in `inner`: [{ raw, styled, action }] with a gap after each.
	const buttons = (items, gap, inner) => {
		const total = items.reduce((sum, item, index) => sum + visibleWidth(item.raw) + (index < items.length - 1 ? visibleWidth(item.gap ?? gap) : 0), 0);
		const pad = Math.max(0, Math.floor((inner - total) / 2));
		const spans = [];
		let x = pad;
		const parts = [" ".repeat(pad)];
		items.forEach((item, index) => {
			const width = visibleWidth(item.raw);
			if (item.action) spans.push({ startX: x, endX: x + width, action: item.action });
			parts.push(item.styled);
			x += width;
			if (index < items.length - 1) {
				const between = item.gap ?? gap;
				parts.push(between);
				x += visibleWidth(between);
			}
		});
		return { text: parts.join(""), spans };
	};

	const nowPlayingRows = (state, source, inner) => {
		const playing = state.status === "playing";
		const mark = playing ? fg("success", "▶ ") : fg("warning", "⏸ ");
		const label = playing ? fg("success", host.bold("♪ Playing")) : state.status === "paused" ? fg("warning", host.bold("♪ Paused")) : fg("muted", host.bold(`♪ ${state.status === "stopped" ? "Stopped" : "Idle"}`));
		const title = state.title || "Unknown";
		const artist = cleanArtist(state.artist, title);
		const image = cover.draw(state, inner);
		const columns = image?.columns ?? 7;
		const room = Math.max(4, inner - 1 - columns - 2 - 2);
		const art = image ? [image.sequence + " ".repeat(columns), " ".repeat(columns), " ".repeat(columns)] : ["┌─────┐", `│  ${fg("accent", "◉")}  │`, "└─────┘"];
		const rows = [
			label,
			"",
			` ${art[0]}  ${mark}${fg("accent", host.bold(cut(title, room)))}`,
			` ${art[1]}  ${fg("dim", "👤")} ${fg("muted", cut(artist, room - 1))}`,
			` ${art[2]}`,
			"",
		];

		// The scrubber, the times at its ends.
		const time = Number.isFinite(state.currentTime) ? Math.max(0, state.currentTime) : 0;
		const duration = Number.isFinite(state.duration) ? Math.max(0, state.duration) : 0;
		const start = `${formatTime(time)} `;
		const end = ` ${formatTime(duration)}`;
		const width = Math.max(4, inner - visibleWidth(start) - visibleWidth(end));
		const filled = duration > 0 ? Math.max(0, Math.min(width, Math.round((time / duration) * width))) : 0;
		const bar = `${filled ? fg("success", "━".repeat(filled)) : ""}${filled < width ? fg("dim", "─".repeat(width - filled)) : ""}`;
		const seek = typeof source.seek === "function" && duration > 0;
		rows.push({
			text: `${fg("success", formatTime(time))} ${bar} ${fg("muted", formatTime(duration))}`,
			spans: seek ? [{ startX: visibleWidth(start), endX: visibleWidth(start) + width, action: "seek", cells: width, duration }] : [],
		});
		rows.push("");

		const play = playing ? "[ ⏸  Pause ]" : "[ ▶  Play ]";
		rows.push(
			buttons(
				[
					{ raw: "[ ⏮  Prev ]", styled: fg("text", "[ ⏮  Prev ]"), action: () => source.previous?.() },
					{ raw: play, styled: fg("accent", host.bold(play)), action: () => source.togglePlay?.() },
					{ raw: "[ ⏭  Next ]", styled: fg("text", "[ ⏭  Next ]"), action: () => source.next?.() },
				],
				"  ",
				inner,
			),
		);
		rows.push("");

		const raw = Number.isFinite(state.volume) ? state.volume : 1;
		const volume = Math.round(raw <= 1 ? raw * 100 : raw);
		const repeat = state.repeatMode === "ONE" ? "[ 🔂 ]" : "[ 🔁 ]";
		const lit = (on, role, text) => (on ? fg(role, host.bold(text)) : fg("dim", text));
		rows.push(
			buttons(
				[
					{ raw: repeat, styled: state.repeatMode === "ONE" ? lit(true, "accent", repeat) : lit(state.repeatMode === "ALL", "success", repeat), action: () => source.toggleRepeat?.() },
					{ raw: "[ - ]", styled: fg("warning", "[ - ]"), action: () => source.setVolume?.(volume - 10), gap: ` 🔊 ${volume}% ` },
					{ raw: "[ + ]", styled: fg("success", "[ + ]"), action: () => source.setVolume?.(volume + 10) },
					{ raw: "[ 🔀 ]", styled: lit(Boolean(state.shuffle), "success", "[ 🔀 ]"), action: () => source.toggleShuffle?.() },
					{
						raw: "[ 📺 ]",
						styled: lit(Boolean(state.isPip), "accent", "[ 📺 ]"),
						action: () => (typeof source.togglePip === "function" ? source.togglePip() : source.dispatchCommand?.("TOGGLE_PIP")),
					},
				],
				" ",
				inner,
			),
		);
		rows.push("");

		const queue = Array.isArray(state.queue) ? state.queue : [];
		const current = playingIndex(state, queue);
		const next = queue[current >= 0 ? current + 1 : 1]?.title || "End of queue";
		rows.push(cut(`${fg("dim", "↳")} ${fg("muted", "Next:")} ${fg("text", next)}`, inner));
		return rows;
	};

	const playingIndex = (state, queue) => {
		const flagged = queue.findIndex((track) => track?.isCurrent);
		if (flagged >= 0) return flagged;
		const current = cleanTitle(state.title);
		if (!current) return -1;
		return queue.findIndex((track) => {
			const title = cleanTitle(track?.title);
			return title && (title === current || current.startsWith(title) || title.startsWith(current));
		});
	};

	const queueRows = (state, source, inner) => {
		const queue = Array.isArray(state.queue) ? state.queue : [];
		if (!queue.length) return [fg("dim", "The queue is empty")];
		queueTop = Math.max(0, Math.min(queueTop, queue.length - QUEUE_ROWS));
		const current = playingIndex(state, queue);
		const rows = queue.slice(queueTop, queueTop + QUEUE_ROWS).map((track, offset) => {
			const index = queueTop + offset;
			const title = track?.title || "Unknown";
			const artist = track?.artist ? `  ${fg("dim", "·")}  ${fg("muted", cleanArtist(track.artist, title))}` : "";
			const left =
				index === current
					? ` ${fg("success", "♪")}  ${fg("success", host.bold(title))}${artist}`
					: `${fg("muted", String(index + 1).padStart(2, "0"))}  ${fg("text", title)}${artist}`;
			const right = track?.duration ? fg("dim", String(track.duration)) : "";
			const room = Math.max(1, inner - (right ? visibleWidth(right) + 1 : 0));
			const shown = cut(left, room);
			const gap = Math.max(right ? 1 : 0, inner - visibleWidth(shown) - visibleWidth(right));
			return { text: `${shown}${" ".repeat(gap)}${right}`, spans: [{ startX: 0, endX: inner, action: () => source.playQueueIndex?.(track?.index ?? index) }] };
		});
		if (queue.length > QUEUE_ROWS) {
			const below = queue.length - queueTop - QUEUE_ROWS;
			const parts = [queueTop > 0 && `▲ ${queueTop} above`, below > 0 && `▼ ${below} below`].filter(Boolean);
			rows.push(fg("dim", `… ${parts.join(" · ")} (wheel)`));
		}
		return rows;
	};

	const draw = (width) => {
		hitboxes = [];
		queueLines = [-1, -1];
		const inner = Math.max(1, host.inner(width));
		const source = player();
		let state;
		try {
			state = source?.getState();
		} catch {
			state = undefined;
		}
		if (!source) {
			stop();
			return host.card("♪ YouTube", [fg("muted", "pi-youtube-player is not installed."), fg("dim", "Set it up from its README (it is not on npm):"), fg("accent", PLAYER_REPO)], width);
		}
		listen(source);
		const brand = state?.platform === "youtube" ? "YouTube" : "YouTube Music";
		if (!state || !(state.connectedClients > 0) || state.status === "disconnected") {
			return host.card(`♪ ${brand} · offline`, [`${fg("accent", "✦")} ${fg("text", "Waiting for Chrome…")}`, fg("muted", "Open youtube.com or music.youtube.com")], width);
		}
		const toggle = (section) => () => {
			open[section] = !open[section];
		};
		const first = card(`${open.nowPlaying ? "▾" : "▸"} ♪ ${brand}`, open.nowPlaying ? nowPlayingRows(state, source, inner) : [], width, toggle("nowPlaying"), 0);
		const count = Array.isArray(state.queue) ? state.queue.length : 0;
		const second = card(`${open.queue ? "▾" : "▸"} ≡ Queue (${count})`, open.queue ? queueRows(state, source, inner) : [], width, toggle("queue"), first.length);
		queueLines = [first.length, first.length + second.length - 1];
		return [...first, ...second];
	};

	const rows = (width) => draw(width).map((line) => cut(line, width));

	return {
		id: "yt",
		render(width) {
			pendingSince = undefined;
			const out = rows(width);
			drawnWidth = width;
			drawn = out.join("\n");
			return out;
		},
		handleClick(line, button, x) {
			if (button !== "left") return false;
			const hit = hitboxes.find((box) => box.line === line && x >= box.startX && x < box.endX);
			if (!hit) return false;
			try {
				if (hit.action === "seek") {
					const cell = Math.max(0, Math.min(hit.cells - 1, x - hit.startX));
					player()?.seek?.(Math.round((cell / Math.max(1, hit.cells - 1)) * hit.duration));
				} else hit.action();
			} catch {
				// the player went away between the render and the click
			}
			host.requestRender();
			return true;
		},
		handleWheel(delta, line) {
			if (!delta || !open.queue || line < queueLines[0] || line > queueLines[1]) return false;
			let queue;
			try {
				queue = player()?.getState()?.queue;
			} catch {
				queue = undefined;
			}
			const length = Array.isArray(queue) ? queue.length : 0;
			const top = Math.max(0, Math.min(Math.max(0, length - QUEUE_ROWS), queueTop + (delta > 0 ? 1 : -1)));
			if (top === queueTop) return false;
			queueTop = top;
			host.requestRender();
			return true;
		},
		onShow() {
			listen(player());
		},
		dispose() {
			stop();
		},
	};
}
