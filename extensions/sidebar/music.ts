// MAIN's Music card: the cliamp player (https://github.com/bjarneo/cliamp) playing on this machine, drawn under
// the Status and Context cards, with previous, play/pause and next under the track. cliamp is one player per
// user, behind ~/.config/cliamp/cliamp.sock: every Pi window shows and controls the same player, and closing a
// Pi window leaves it playing.
//
// With cliamp installed (`cliamp --version`, asked once) and no player answering, the card is one row, "▶ Start
// cliamp"; without cliamp it is left out. Nothing starts by itself: a click runs `cliamp --daemon`, cliamp with
// no window of its own, detached from Pi (its own session, no stdio), so it keeps playing after Pi closes. The
// card says "Starting…" and reads the status every musicTiming.startPollMs up to musicTiming.startMs; once the
// player answers the card is drawn and the playlist picker opens, else it says "cliamp did not start" for a few
// seconds. The ⏻ after next stops the player: cliamp v2.3 has no quit over its socket (only MPRIS's Quit), so it
// is SIGTERM, which cliamp handles by saving where it was and leaving, sent to the pid in cliamp.sock.pid only
// when /proc/<pid>/comm says that process is cliamp (a stale pid file is never signalled).
//
// Under the artist, cliamp's own seek bar (━ played, ● the head, ─ the rest); a click on it jumps there with
// seek.absolute.
//
// The status is `cliamp status --json`, read when the card is drawn and then every musicTiming.pollMs while it
// keeps being drawn; between reads a playing track's position moves on with the clock. A click on a control
// runs `cliamp prev`, `cliamp toggle` or `cliamp next`, then reads the status again. First comes shuffle (󰒝 in
// accent while on, 󰒞 dim while cliamp plays in order), then repeat (󰑗 dim off, 󰑖 all, 󰑘 one, in accent; a
// click runs `cliamp repeat cycle` and shows the next mode at once): a shuffle click runs `cliamp shuffle toggle`, flips it at once and
// reads the status, which settles it. Then a heart (Nerd Font's: JetBrains Mono has no ♡; 󰋑 filled in error on a
// favorite, 󰋕 outlined dim otherwise) toggles the track's favorite, filled the moment it is saved, shown only
// when its category is known. cliamp's
// tracks never say whether they are favorites and its remote calls cannot change them, so both go through its
// favorites.toml (./music-favorites.ts): the paths read from it with the playlists, whenever the picker opens
// and after every toggle; a toggle written to it under cliamp's own lock, with a one-time backup. A toggle that
// fails says why in a dim row under the controls for a few seconds.
//
// Over the track sits the category playing, "󰲸 Lofi · 120 tracks ▾" (the count from provider.playlists, "1 track"
// for one): the playlist id is the first segment of the track's
// path (https://radio.cliamp.stream/lofi/tracks/…), named from cliamp's provider.playlists, asked with the local
// provider's (for Favorites) once the player first answers; a track from no known category shows "Playlists". A
// click on that row opens a picker over Pi (./music-picker.ts): Favorites and the categories, then a list's
// tracks; a click on the row under it, "<artist> · <title>" (the artist muted, the title as cliamp gives it, one
// row cut with … when it does not fit), opens the tracks of the category playing. Picking a track runs
// provider.load at its index, which plays it (never queue.play: the live queue may hold another list). Then
// the status is read and, when the player is not playing, `cliamp play` runs. A failure changes nothing.
// @ts-nocheck

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cliampDir, readFavoritePaths, toggleFavorite } from "./music-favorites.ts";
import { LOVED, UNLOVED, openMusicPicker } from "./music-picker.ts";

/**
 * How cliamp is asked: its stdout, or undefined when it fails (not installed, no player); and its favorites:
 * their paths (undefined when they cannot be read) and a toggle (true added, false removed, rejects with the
 * reason); and the player's process: spawn (node's), the pid in cliamp.sock.pid, a process's name (its
 * /proc/<pid>/comm, undefined when there is no such process) and kill. Tests swap them.
 */
export const musicDeps = {
	run: (args) =>
		new Promise((resolve) => {
			execFile("cliamp", args, { timeout: 2000 }, (error, stdout) => resolve(error ? undefined : String(stdout)));
		}),
	favoritePaths: () => readFavoritePaths(),
	toggleFavorite: (track) => toggleFavorite(track),
	spawn: (command, args, options) => spawn(command, args, options),
	readPid: async () => {
		try {
			const pid = Number.parseInt(await fs.promises.readFile(path.join(cliampDir(), "cliamp.sock.pid"), "utf8"), 10);
			return Number.isInteger(pid) && pid > 0 ? pid : undefined;
		} catch {
			return undefined;
		}
	},
	processName: async (pid) => {
		try {
			return (await fs.promises.readFile(`/proc/${pid}/comm`, "utf8")).trim();
		} catch {
			return undefined;
		}
	},
	kill: (pid, signal) => process.kill(pid, signal),
};

/**
 * How often the status is read while the card is drawn, how long after the last draw the timer stops, how long a
 * notice stays, and how often and how long a player just started (or stopped) is waited for.
 */
export const musicTiming = { pollMs: 1500, idleMs: 4000, noticeMs: 5000, startPollMs: 300, startMs: 5000 };

// Nerd Font's Material icons, as the branch icon in the Status card: JetBrains Mono has no ⏮ ⏸ ⏭.
const PREV = "\u{F04AE}";
const PLAY = "\u{F040A}";
const PAUSE = "\u{F03E4}";
const NEXT = "\u{F04AD}";
const LIST = "\u{F0CB8}";
const POWER = "⏻";
const SHUFFLE = "\u{F049D}";
const SEQUENCE = "\u{F049E}"; // shuffle-disabled: tracks in order
// Repeat, by cliamp's mode (playlist.RepeatMode: Off, All, One; `repeat cycle` goes Off → All → One → Off).
const REPEAT = { off: "\u{F0457}", all: "\u{F0456}", one: "\u{F0458}" };
const NEXT_REPEAT = { off: "all", all: "one", one: "off" };

/** The id of the category a track was streamed from: the first segment of its http(s) path, else "". */
function playlistOf(path) {
	if (typeof path !== "string" || !/^https?:\/\//.test(path)) return "";
	try {
		return new URL(path).pathname.split("/").filter(Boolean)[0] ?? "";
	} catch {
		return "";
	}
}

/** cliamp's `remote call … --wait` answer: its job's result when the job succeeded, else undefined. */
function jobResult(text) {
	try {
		const data = JSON.parse(text);
		const result = data?.ok === true && data.job?.state === "succeeded" ? data.job.result : undefined;
		return result && result.ok !== false ? result : undefined;
	} catch {
		return undefined;
	}
}

/** provider.playlists' answer as [{ provider, id, name, tracks }], undefined when it failed. */
export function parsePlaylists(text) {
	const list = jobResult(text)?.playlists;
	if (!Array.isArray(list)) return undefined;
	return list
		.filter((item) => typeof item?.id === "string" && item.id)
		.map((item) => ({
			provider: typeof item.provider === "string" && item.provider ? item.provider : "cliamp",
			id: item.id,
			name: typeof item.name === "string" && item.name ? item.name : item.id,
			tracks: Number.isFinite(item.track_count) ? item.track_count : 0,
		}));
}

/** provider.tracks' answer: cliamp's track objects as given (title, artist, path, bookmark…), undefined when it failed. */
export function parseTracks(text) {
	const list = jobResult(text)?.tracks;
	return Array.isArray(list) ? list.filter((track) => track && typeof track === "object") : undefined;
}

/** cliamp's `status --json`: the state, the track and where it is; undefined when no player answered. */
export function parseStatus(text) {
	if (typeof text !== "string") return undefined;
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!data || data.ok !== true) return undefined;
	const number = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
	const track = data.track && typeof data.track === "object" ? data.track : undefined;
	return {
		state: typeof data.state === "string" ? data.state : "stopped",
		title: typeof track?.title === "string" ? track.title : "",
		artist: typeof track?.artist === "string" ? track.artist : "",
		path: typeof track?.path === "string" ? track.path : "",
		playlist: playlistOf(track?.path),
		track, // as cliamp gave it
		shuffle: data.shuffle === true,
		repeat: ["all", "one"].includes(String(data.repeat).toLowerCase()) ? String(data.repeat).toLowerCase() : "off",
		position: number(data.position),
		duration: number(data.duration),
	};
}

/** "2:16", "1:02:05". */
export function formatTime(seconds) {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const remote = (method, params) => ["remote", "call", method, "--params", JSON.stringify(params), "--wait"];

/**
 * The Music card's controller. `paint(role, text)`, `requestRender()` and `ctx()` (Pi's, for the picker) come
 * from gentle-quiet.
 * rows(inner): the card's rows under its title, [] while no player answers.
 * click(line, x, at): a left click on row `line` of rows() at column `x` (`at`: its screenX/screenY, to place
 * the picker); true when it hit a control or opened the picker.
 */
export function createMusic({ paint, requestRender, ctx = () => undefined }) {
	const state = {
		status: undefined,
		at: 0,
		pending: false,
		again: false,
		readAt: 0,
		drawnAt: 0,
		timer: undefined,
		controls: undefined,
		playlists: undefined, // cliamp's categories
		favorites: undefined, // the local provider's Favorites
		asked: false,
		lines: undefined, // where the category, the track and the artist rows are
		loved: new Set(), // the paths in favorites.toml
		notice: undefined, // { text, until }: why the last ♥ or ⏻ did not work, or that cliamp did not start
		installed: undefined, // whether `cliamp --version` answered; undefined until asked
		starting: false, // a `cliamp --daemon` started from here, not answering yet
		stopping: false, // a SIGTERM sent from here, the player still answering
		lovedAt: 0, // bumped by each Favorites read and each flip: a read older than a flip is dropped
	};

	// One read at a time; a read asked for meanwhile (after a control) runs once it is back.
	const read = () => {
		if (state.pending) {
			state.again = true;
			return;
		}
		state.pending = true;
		state.readAt = Date.now();
		musicDeps
			.run(["status", "--json"])
			.catch(() => undefined)
			.then((text) => {
				state.pending = false;
				if (state.again) {
					state.again = false;
					read();
				}
				const next = parseStatus(text);
				const changed = JSON.stringify(next) !== JSON.stringify(state.status);
				state.status = next;
				state.at = Date.now();
				if (next) askPlaylists();
				else askInstalled();
				if (changed || next?.state === "playing") requestRender();
			});
	};

	// While the card is drawn the status is read every pollMs; the timer stops once draws stop coming.
	const keepReading = () => {
		if (state.timer) return;
		state.timer = setInterval(() => {
			if (Date.now() - state.drawnAt > musicTiming.idleMs) {
				clearInterval(state.timer);
				state.timer = undefined;
				return;
			}
			read();
		}, musicTiming.pollMs);
		state.timer.unref?.();
	};

	const ask = (args) => musicDeps.run(args).catch(() => undefined);

	// The favorites' paths; a failed read keeps the ones known.
	const readFavorites = () => {
		const at = ++state.lovedAt;
		Promise.resolve()
			.then(() => musicDeps.favoritePaths())
			.catch(() => undefined)
			.then((paths) => {
				if (!(paths instanceof Set) || at !== state.lovedAt) return;
				state.loved = paths;
				requestRender();
			});
	};

	const flipFavorite = (path) => {
		if (typeof path !== "string" || !path) return;
		if (!state.loved.delete(path)) state.loved.add(path);
		state.lovedAt++;
		requestRender();
	};

	// The categories, the local lists (for Favorites) and the favorites' paths, asked once; failed categories
	// are asked again by the next click on the row.
	const askPlaylists = () => {
		if (state.asked) return state.listing;
		state.asked = true;
		const lists = [ask(remote("provider.playlists", { provider: "cliamp", limit: 50 })), ask(remote("provider.playlists", { provider: "local", limit: 20 }))];
		readFavorites();
		state.listing = Promise.all(lists).then(([categories, local]) => {
			state.playlists = parsePlaylists(categories);
			state.favorites = parsePlaylists(local)?.find((playlist) => playlist.id === "Favorites");
			if (state.favorites) state.favorites = { ...state.favorites, provider: "local" };
			if (!state.playlists) state.asked = false;
			else requestRender();
		});
		return state.listing;
	};

	const say = (text) => {
		state.notice = { text, until: Date.now() + musicTiming.noticeMs };
		setTimeout(requestRender, musicTiming.noticeMs + 50).unref?.();
		requestRender();
	};
	const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	// Reads the status every startPollMs until `done(status)` or startMs; true when done.
	const waitFor = async (done) => {
		for (const end = Date.now() + musicTiming.startMs; Date.now() < end; ) {
			await pause(musicTiming.startPollMs);
			const now = parseStatus(await ask(["status", "--json"]));
			if (done(now)) {
				state.status = now;
				state.at = Date.now();
				return true;
			}
		}
		return false;
	};

	// Whether cliamp is installed, asked once, only once no player has answered.
	const askInstalled = () => {
		if (state.installed !== undefined || state.askingInstalled) return;
		state.askingInstalled = true;
		ask(["--version"]).then((text) => {
			state.installed = typeof text === "string" && /cliamp/i.test(text);
			if (state.installed) requestRender();
		});
	};

	// `cliamp --daemon`, cliamp with no window, detached from Pi so it outlives it; then the card and the picker.
	const start = async (at) => {
		state.starting = true;
		state.notice = undefined;
		requestRender();
		try {
			const child = musicDeps.spawn("cliamp", ["--daemon"], { detached: true, stdio: "ignore" });
			child?.on?.("error", () => undefined); // a cliamp gone since --version: the wait below says so
			child?.unref?.();
		} catch {
			// as above
		}
		const up = await waitFor(Boolean);
		state.starting = false;
		if (!up) return say("cliamp did not start");
		requestRender();
		await askPlaylists();
		if (state.status && state.playlists?.length) openPicker(at);
	};

	// SIGTERM to the cliamp in cliamp.sock.pid, once /proc says that pid is cliamp; then waits for it to be gone.
	const stop = async () => {
		const pid = await musicDeps.readPid();
		const name = pid ? await musicDeps.processName(pid) : undefined;
		if (!pid) return say("⏻ not stopped: no cliamp pid file");
		if (name !== "cliamp") return say("⏻ not stopped: the pid file is stale");
		try {
			musicDeps.kill(pid, "SIGTERM");
		} catch (error) {
			return say(`⏻ not stopped: ${error?.code || error?.message || error}`);
		}
		state.stopping = true;
		requestRender();
		const gone = await waitFor((now) => !now);
		state.stopping = false;
		if (!gone) say("⏻ cliamp is still running");
		requestRender();
	};

	const tracksOf = async (playlist) => parseTracks(await ask(remote("provider.tracks", { provider: playlist.provider, playlist: playlist.id, limit: 500 })));

	// Track `index` of `playlist`: provider.load at that index, even for the category playing, since the live queue
	// may hold another list (Favorites, loaded in cliamp or another Pi window); then the status, and `play` when the
	// player is not playing. A failure stops there.
	const playTrack = async (playlist, index) => {
		const answer = await ask(remote("provider.load", { provider: playlist.provider, playlist: playlist.id, index }));
		if (!jobResult(answer)) return;
		const now = parseStatus(await ask(["status", "--json"]));
		if (now) {
			state.status = now;
			state.at = Date.now();
			requestRender();
		}
		if (now?.state !== "playing") await ask(["play"]);
		read();
	};

	// Toggles a track's ♥ in favorites.toml, as f in cliamp, and reads the favorites again; true when it was
	// saved. `early` flips the ♥ before it is (and back when it fails), else once it is. A failure says why.
	const love = async (track, early = false) => {
		if (early) flipFavorite(track?.path);
		let done = false;
		try {
			await musicDeps.toggleFavorite({ path: track?.path, title: track?.title, artist: track?.artist, album: track?.album });
			done = true;
		} catch (error) {
			say(`${LOVED} not saved: ${String(error?.message || error || "unknown error").split("\n")[0]}`);
		}
		if (done !== early) flipFavorite(track?.path);
		if (done) readFavorites();
		requestRender();
		return done;
	};

	// The pop-up: the Favorites, then the categories; `open` starts on that category's tracks.
	const openPicker = (at, open) => {
		const status = state.status;
		const playlists = [...(state.favorites ? [state.favorites] : []), ...state.playlists];
		const opened = openMusicPicker(ctx(), {
			playlists,
			current: status.playlist,
			currentPath: status.path,
			open,
			at,
			tracksOf,
			onPlay: (playlist, index) => void playTrack(playlist, index).catch(() => undefined),
			isFavorite: (track) => state.loved.has(track?.path),
			favoritesCount: () => state.loved.size,
			onBookmark: (_playlist, track) => love(track, true).catch(() => false),
		});
		if (opened) readFavorites(); // a ♥ toggled elsewhere (cliamp's own f) shows
		return opened;
	};

	const position = (status) => {
		const moved = status.state === "playing" ? (Date.now() - state.at) / 1000 : 0;
		return status.duration ? Math.min(status.duration, status.position + moved) : status.position + moved;
	};

	return {
		rows(inner) {
			state.drawnAt = Date.now();
			if (!state.readAt) read();
			keepReading();
			const status = state.status;
			state.controls = undefined;
			state.lines = undefined;
			const cut = (text) => (visibleWidth(text) <= inner ? text : truncateToWidth(text, inner, "…"));
			if (state.stopping) return [paint("dim", "Stopping…")];
			if (!status) {
				// No player: once a read said so, the Start row when cliamp is installed.
				if (!state.at) return [];
				askInstalled();
				if (state.starting) return [paint("dim", "Starting…")];
				if (state.notice && Date.now() < state.notice.until) return [paint("dim", cut(state.notice.text))];
				state.notice = undefined;
				if (!state.installed) return [];
				state.lines = { start: 0 };
				return [paint("accent", cut("▶ Start cliamp"))];
			}
			const rows = [];
			// The category with how many tracks it has: "󰲸 Lofi · 120 tracks ▾"; the count gives way first.
			const playing = state.playlists?.find((playlist) => playlist.id === status.playlist);
			const name = playing?.name ?? "Playlists";
			const count = playing?.tracks ? ` · ${playing.tracks} ${playing.tracks === 1 ? "track" : "tracks"}` : "";
			const full = `${LIST} ${name}${count} ▾`;
			const shown = visibleWidth(full) <= inner ? count : "";
			const label = cut(`${LIST} ${name}${shown} ▾`);
			state.lines = { category: rows.length, track: [] };
			rows.push(label.endsWith(" ▾") ? `${LIST} ${paint("text", label.slice(LIST.length + 1, label.length - 2 - shown.length))}${shown ? paint("muted", shown) : ""}${paint("dim", " ▾")}` : paint("text", label));
			// The artist, then the title, on one row: cut with … at the end, never a second row.
			state.lines.track.push(rows.length);
			const title = status.title || (status.state === "stopped" ? "Stopped" : "Unknown track");
			const lead = status.artist ? `${status.artist} · ` : "";
			const line = cut(`${lead}${title}`);
			rows.push(line.length > lead.length && line.startsWith(lead) ? `${lead ? paint("muted", lead) : ""}${paint("text", line.slice(lead.length))}` : paint("muted", line));
			const at = position(status);
			if (status.duration) {
				// cliamp's own seek bar (ui/model/view.go renderSeekBar): played ━ and the head ● in accent, the rest ─ dim.
				state.lines.bar = { line: rows.length, width: inner };
				const filled = Math.min(inner, Math.floor((Math.min(at, status.duration) / status.duration) * inner));
				rows.push(filled >= inner ? paint("accent", "━".repeat(inner)) : [filled && paint("accent", "━".repeat(filled)), paint("accent", "●"), filled < inner - 1 && paint("dim", "─".repeat(inner - filled - 1))].filter(Boolean).join(""));
			} else {
				// No duration yet (a new track loading): cliamp's buffering bar, all ─ dim, so the card does not jump.
				rows.push(paint("dim", "─".repeat(inner)));
			}
			const time = status.duration ? `${formatTime(at)} / ${formatTime(status.duration)}` : formatTime(at);
			const middle = status.state === "playing" ? PAUSE : PLAY;
			// The ♥ only when the track's category is known.
			const loved = state.loved.has(status.path);
			const heart = status.playlist && status.track ? (loved ? LOVED : UNLOVED) : undefined;
			const shuffle = { glyph: status.shuffle ? SHUFFLE : SEQUENCE, role: status.shuffle ? "accent" : "dim", shuffle: true };
			const repeat = { glyph: REPEAT[status.repeat] ?? REPEAT.off, role: status.repeat && status.repeat !== "off" ? "accent" : "dim", repeat: true };
			const buttons = [shuffle, repeat, ...(heart ? [{ glyph: heart, role: loved ? "error" : "dim", heart: true }] : []), { glyph: PREV, role: "text", command: "prev" }, { glyph: middle, role: "accent", command: "toggle" }, { glyph: NEXT, role: "text", command: "next" }, { glyph: POWER, role: "dim", power: true }];
			const controls = buttons.map((button) => button.glyph).join("  ");
			const gap = inner - visibleWidth(time) - visibleWidth(controls);
			const timeText = paint("muted", time);
			const controlsText = buttons.map((button) => paint(button.role, button.glyph)).join("  ");
			const start = gap >= 2 ? inner - visibleWidth(controls) : 0;
			state.controls = { line: rows.length, hits: buttons.map((button, index) => ({ ...button, from: start + index * 3, to: start + index * 3 + 1 })) };
			rows.push(gap >= 2 ? `${timeText}${" ".repeat(gap)}${controlsText}` : controlsText);
			if (state.notice && Date.now() < state.notice.until) rows.push(paint("dim", cut(state.notice.text)));
			else state.notice = undefined;
			return rows;
		},
		click(line, x, at) {
			const status = state.status;
			const lines = state.lines;
			if (!status) {
				if (lines?.start !== line || state.starting) return false;
				void start(at).catch(() => undefined);
				return true;
			}
			if (lines && (line === lines.category || lines.track.includes(line))) {
				if (!state.playlists?.length) {
					askPlaylists();
					return false;
				}
				const playing = lines.track.includes(line) ? state.playlists.find((playlist) => playlist.id === status.playlist)?.id : undefined;
				return openPicker(at, playing);
			}
			// A click on the seek bar jumps to that point of the track, as on cliamp's own bar.
			if (lines?.bar && line === lines.bar.line && status.duration) {
				const value = Math.round((Math.max(0, Math.min(lines.bar.width - 1, x)) / lines.bar.width) * status.duration);
				status.position = value;
				state.at = Date.now();
				requestRender();
				void ask(remote("seek.absolute", { value })).then(read);
				return true;
			}
			const controls = state.controls;
			if (!controls || line !== controls.line) return false;
			const hit = controls.hits.find((candidate) => x >= candidate.from - 1 && x <= candidate.to);
			if (!hit) return false;
			if (hit.heart) {
				void love(status.track).catch(() => undefined);
				return true;
			}
			if (hit.repeat) {
				// Shown in the next mode at once; the status read after it settles it.
				state.status = { ...status, repeat: NEXT_REPEAT[status.repeat] ?? "all" };
				requestRender();
				ask(["repeat", "cycle"]).then(read);
				return true;
			}
			if (hit.shuffle) {
				// Flipped at once; the status read after it says what cliamp did.
				state.status = { ...status, shuffle: !status.shuffle };
				requestRender();
				ask(["shuffle", "toggle"]).then(read);
				return true;
			}
			if (hit.power) {
				if (!state.stopping) void stop().catch(() => undefined);
				return true;
			}
			ask([hit.command]).then(read);
			return true;
		},
		dispose() {
			clearInterval(state.timer);
			state.timer = undefined;
		},
	};
}
