import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { painted, plain, theme } from "./helpers.mjs";
import { createTab, formatTime, YOUTUBE_PLAYER_SYMBOL } from "../extensions/sidebar/yt.ts";
import { createCover, pngSize } from "../extensions/sidebar/yt-cover.ts";

// gentle-quiet's card, as railCard draws it with the outline on: square outline, bold toolTitle title, a blank row.
const fit = (row, inner) => {
	const text = plain(row);
	return [...text].length <= inner ? row + " ".repeat(inner - [...text].length) : `${[...text].slice(0, inner - 1).join("")}…`;
};
const boxed = (rows, width) => {
	const inner = width - 4;
	return [theme.fg("border", `┌${"─".repeat(inner + 2)}┐`), ...rows.map((row) => `${theme.fg("border", "│")} ${fit(row, inner)} ${theme.fg("border", "│")}`), theme.fg("border", `└${"─".repeat(inner + 2)}┘`)];
};

/** A stand-in for gentle-quiet's tab host. */
function host() {
	const calls = { renders: 0 };
	const h = {
		theme,
		fg: (name, text) => theme.fg(name, text),
		bold: (text) => theme.bold(text),
		card: (title, rows, width) => boxed([theme.fg("toolTitle", theme.bold(title)), ...(rows.length ? ["", ...rows] : [])], width),
		box: (rows, width) => boxed(rows, width),
		inner: (width) => width - 4,
		cwd: () => "/srv/app",
		ctx: () => undefined,
		pi: undefined,
		agentDir: "/nonexistent/agent",
		requestRender: () => calls.renders++,
		git: async () => undefined,
		changes: () => undefined,
		usage: () => ({ name: "", windows: [] }),
		gauge: (percent) => `${percent}`,
		icons: {},
	};
	return { host: h, calls };
}

const QUEUE = [
	{ index: 0, title: "Starboy", artist: "The Weeknd • Starboy", duration: "03:50", isCurrent: true },
	{ index: 1, title: "Blinding Lights", artist: "The Weeknd", duration: "03:20" },
	{ index: 2, title: "Save Your Tears", artist: "The Weeknd", duration: "03:35" },
];

const PLAYING = {
	status: "playing",
	platform: "music",
	title: "Starboy",
	artist: "The Weeknd • Starboy • 2016",
	currentTime: 75,
	duration: 230,
	volume: 0.8,
	repeatMode: "NONE",
	shuffle: false,
	isPip: false,
	queue: QUEUE,
	connectedClients: 1,
	lastUpdated: 1,
};

/** pi-youtube-player's published service, as YouTubePlayerService puts it on the global symbol. */
function publish(state, { seek = false } = {}) {
	const calls = [];
	const listeners = new Set();
	const record = (name) => (...args) => calls.push([name, ...args]);
	const player = {
		state: { ...state },
		getState: () => ({ ...player.state }),
		on(event, listener) {
			if (event === "stateChange") listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(change = {}) {
			player.state = { ...player.state, ...change };
			for (const listener of [...listeners]) listener(player.getState());
		},
		listeners,
		calls,
		play: record("play"),
		pause: record("pause"),
		togglePlay: record("togglePlay"),
		next: record("next"),
		previous: record("previous"),
		setVolume: record("setVolume"),
		toggleMute: record("toggleMute"),
		toggleRepeat: record("toggleRepeat"),
		toggleShuffle: record("toggleShuffle"),
		togglePip: record("togglePip"),
		playQueueIndex: record("playQueueIndex"),
		isConnected: () => player.state.connectedClients > 0 && player.state.status !== "disconnected",
	};
	if (seek) player.seek = record("seek");
	globalThis[YOUTUBE_PLAYER_SYMBOL] = player;
	return player;
}

afterEach(() => {
	delete globalThis[YOUTUBE_PLAYER_SYMBOL];
});

/** Opens the tab as gentle-quiet does (onShow, then render). */
function opened(options = {}, width = 59, height = 40) {
	const { host: h, calls } = host();
	const tab = createTab(h, options);
	tab.onShow?.();
	const draw = () => tab.render(width, height);
	const rows = () => draw().map(plain).map((row) => row.replace(/ +│$/, ""));
	// The line and column of `text` in the rows, as the column hands them to handleClick.
	const at = (text, after = 0) => {
		const out = rows();
		const line = out.findIndex((row, index) => index >= after && row.includes(text));
		assert.ok(line >= 0, `"${text}" is drawn`);
		return { line, x: [...out[line].slice(0, out[line].indexOf(text))].length };
	};
	const click = (text, button = "left", shift = 0) => {
		const { line, x } = at(text);
		return tab.handleClick(line, button, x + shift);
	};
	return { tab, calls, h, draw, rows, at, click };
}

test("formatTime draws cute's mm:ss, and h:mm:ss past an hour", () => {
	assert.equal(formatTime(75), "01:15");
	assert.equal(formatTime(0), "00:00");
	assert.equal(formatTime(Number.NaN), "00:00");
	assert.equal(formatTime(3725), "1:02:05");
});

test("without pi-youtube-player one short card says it is not installed and where to get it, and nothing throws", () => {
	const { rows, draw, tab } = opened();
	const out = rows();
	assert.ok(out[0].startsWith("┌") && out.at(-1).startsWith("└"));
	assert.equal(out[1], "│ ♪ YouTube");
	assert.ok(out.some((row) => row.includes("pi-youtube-player is not installed")));
	assert.ok(out.some((row) => row.includes("github.com/CinloDev/pi-youtube-player")));
	assert.ok(out.length <= 8, "one short card");
	assert.ok(draw().every((row) => [...plain(row)].length <= 59));
	assert.equal(tab.handleClick(2, "left", 4), false);
	assert.equal(tab.handleWheel(1, 2, 4), false);
	globalThis[YOUTUBE_PLAYER_SYMBOL] = { getState: () => { throw new Error("gone"); } };
	assert.doesNotThrow(() => draw());
	globalThis[YOUTUBE_PLAYER_SYMBOL] = 42;
	assert.ok(rows().some((row) => row.includes("not installed")), "something else on the symbol is no player");
});

test("with no browser connected the card waits for Chrome, as cute's offline card", () => {
	publish({ ...PLAYING, status: "disconnected", connectedClients: 0 });
	const out = opened().rows();
	assert.equal(out[1], "│ ♪ YouTube Music · offline");
	assert.ok(out.some((row) => row.includes("Waiting for Chrome")));
	assert.ok(out.some((row) => row.includes("Open youtube.com or music.youtube.com")));
	assert.ok(!out.some((row) => row.includes("Queue")));
});

test("playing: title and artist beside the cover, the scrubber, centered controls, the next track and the queue", () => {
	publish(PLAYING);
	const { rows, draw } = opened();
	const out = rows();
	const raw = draw();
	assert.equal(out[1], "│ ▾ ♪ YouTube Music");
	const titleRow = out.findIndex((row) => row.includes("▶ Starboy"));
	assert.ok(titleRow > 1);
	assert.match(out[titleRow], /┌─────┐ +▶ Starboy/, "the stand-in cover where the terminal draws no images");
	assert.match(out[titleRow + 1], /│  ◉  │ +The Weeknd$/, "the artist, cleaned of the album and year");
	assert.match(out[titleRow + 2], /└─────┘/);
	assert.ok(painted(raw.join(""), "success", "▶ "), "the play mark in success");
	assert.ok(raw.join("").includes(theme.fg("accent", theme.bold("Starboy"))), "the title in accent bold");

	const scrub = out.find((row) => row.includes("01:15"));
	assert.match(scrub, /^│ 01:15 ━+─+ 03:50$/);
	const bar = scrub.slice("│ 01:15 ".length, -" 03:50".length);
	assert.equal([...bar].length, 55 - 12, "the bar fills the card between the times");
	assert.equal(bar.split("━").length - 1, Math.round((75 / 230) * 43));

	const controls = out.find((row) => row.includes("Prev"));
	assert.match(controls, /\[ ⏮  Prev \]  \[ ⏸  Pause \]  \[ ⏭  Next \]/);
	const left = controls.indexOf("[") - 2;
	const right = 55 - (left + "[ ⏮  Prev ]  [ ⏸  Pause ]  [ ⏭  Next ]".length);
	assert.ok(Math.abs(left - right) <= 1, "centered");
	assert.ok(out.some((row) => /\[ 🔁 \] \[ - \] 🔊 80% \[ \+ \] \[ 🔀 \] \[ 📺 \]/.test(row)), "repeat, volume, shuffle and picture in picture");
	assert.ok(out.some((row) => row.includes("↳ Next: Blinding Lights")));

	const queueTitle = out.findIndex((row) => row === "│ ▾ ≡ Queue (3)");
	assert.ok(queueTitle > titleRow);
	const queue = out.slice(queueTitle + 2, queueTitle + 5);
	assert.match(queue[0], /^│  ♪  Starboy  ·  The Weeknd +03:50$/, "the playing track marked, its artist cleaned");
	assert.match(queue[1], /^│ 02  Blinding Lights  ·  The Weeknd +03:20$/);
	assert.match(queue[2], /^│ 03  Save Your Tears/);
	assert.ok(raw.join("").includes(theme.fg("success", theme.bold("Starboy"))), "the playing track in success bold");
	assert.ok(raw.every((row) => [...plain(row)].length <= 59));
});

test("paused: the pause mark in warning and a Play button; repeat one, shuffle and picture in picture lit", () => {
	publish({ ...PLAYING, status: "paused", repeatMode: "ONE", shuffle: true, isPip: true, platform: "youtube" });
	const { rows, draw } = opened();
	const out = rows();
	const raw = draw().join("");
	assert.equal(out[1], "│ ▾ ♪ YouTube");
	assert.ok(out.some((row) => row.includes("⏸ Starboy")));
	assert.ok(painted(raw, "warning", "⏸ "));
	assert.ok(out.some((row) => row.includes("[ ▶  Play ]")));
	assert.ok(out.some((row) => row.includes("[ 🔂 ]")));
	assert.ok(raw.includes(theme.fg("accent", theme.bold("[ 🔂 ]"))));
	assert.ok(raw.includes(theme.fg("success", theme.bold("[ 🔀 ]"))));
	assert.ok(raw.includes(theme.fg("accent", theme.bold("[ 📺 ]"))));
});

test("empty: connected with nothing queued, the queue says so and the next track is the end of the queue", () => {
	publish({ ...PLAYING, status: "paused", title: "", artist: "", currentTime: 0, duration: 0, queue: [] });
	const out = opened().rows();
	assert.ok(out.some((row) => row.includes("⏸ Unknown")));
	assert.ok(out.some((row) => row.includes("YouTube Music")), "cute's artist when there is none");
	assert.ok(out.some((row) => /^│ 00:00 ─+ 00:00$/.test(row)), "an empty bar");
	assert.ok(out.some((row) => row.includes("↳ Next: End of queue")));
	assert.ok(out.includes("│ ▾ ≡ Queue (0)"));
	assert.ok(out.some((row) => row.includes("The queue is empty")));
});

test("every control calls the player: prev, play/pause, next, repeat, volume down and up, shuffle, picture in picture", () => {
	const player = publish(PLAYING);
	const { click } = opened();
	for (const [label, call] of [
		["Prev", ["previous"]],
		["Pause", ["togglePlay"]],
		["Next ]", ["next"]],
		["🔁", ["toggleRepeat"]],
		["[ - ]", ["setVolume", 70]],
		["[ + ]", ["setVolume", 90]],
		["🔀", ["toggleShuffle"]],
		["📺", ["togglePip"]],
	]) {
		player.calls.length = 0;
		assert.equal(click(label), true, label);
		assert.deepEqual(player.calls, [call], label);
	}
	player.calls.length = 0;
	assert.equal(click("Prev", "right"), false, "only the left button");
	assert.equal(click("↳ Next"), false, "the next-track row is not a button");
	assert.deepEqual(player.calls, []);
});

test("the edges of a button are its own: a click on its brackets acts, the gap between two buttons does not", () => {
	const player = publish(PLAYING);
	const { click, at, tab } = opened();
	assert.equal(click("[ ⏮", "left", 0), true);
	assert.equal(click("Prev ]", "left", "Prev ]".length - 1), true);
	const { line, x } = at("[ ⏸");
	assert.equal(tab.handleClick(line, "left", x - 1), false, "the gap before Pause");
	assert.deepEqual(player.calls, [["previous"], ["previous"]]);
});

test("picture in picture falls back to the TOGGLE_PIP command on a service without togglePip", () => {
	const player = publish(PLAYING);
	delete player.togglePip;
	player.dispatchCommand = (...args) => player.calls.push(["dispatchCommand", ...args]);
	opened().click("📺");
	assert.deepEqual(player.calls, [["dispatchCommand", "TOGGLE_PIP"]]);
});

test("a click on a queue track plays it by its index in the queue", () => {
	const player = publish(PLAYING);
	const { click } = opened();
	assert.equal(click("Save Your Tears"), true);
	assert.deepEqual(player.calls, [["playQueueIndex", 2]]);
});

test("a click on a card's title folds it and opens it again, as cute's sections", () => {
	publish(PLAYING);
	const { click, rows } = opened();
	assert.equal(click("▾ ♪ YouTube Music"), true);
	assert.ok(rows().includes("│ ▸ ♪ YouTube Music"));
	assert.ok(!rows().some((row) => row.includes("Prev")));
	assert.equal(click("▾ ≡ Queue"), true);
	assert.ok(rows().includes("│ ▸ ≡ Queue (3)"));
	assert.ok(!rows().some((row) => row.includes("Blinding Lights")));
	click("▸ ♪ YouTube Music");
	assert.ok(rows().some((row) => row.includes("Prev")));
});

test("the scrubber seeks where it is clicked when the player can seek, and is left alone when it cannot", () => {
	const player = publish(PLAYING, { seek: true });
	const { at, tab } = opened();
	const { line, x } = at("━");
	assert.equal(tab.handleClick(line, "left", x), true, "the bar's first cell: the start");
	assert.equal(tab.handleClick(line, "left", x + 42), true, "the bar's last cell: the end");
	assert.equal(tab.handleClick(line, "left", x + 21), true);
	assert.deepEqual(player.calls.map(([name]) => name), ["seek", "seek", "seek"]);
	const [start, end, middle] = player.calls.map(([, seconds]) => seconds);
	assert.equal(start, 0);
	assert.equal(end, 230);
	assert.ok(Math.abs(middle - 115) <= 6, `the middle: ${middle}`);
	assert.equal(tab.handleClick(line, "left", x - 3), false, "the elapsed time is not the bar");

	const published = publish(PLAYING);
	const unseekable = opened();
	const bar = unseekable.at("━");
	assert.equal(unseekable.tab.handleClick(bar.line, "left", bar.x + 5), false, "pi-youtube-player publishes no seek");
	assert.deepEqual(published.calls, []);
});

test("the wheel over a long queue scrolls it twelve at a time and lets the column scroll elsewhere", () => {
	const queue = Array.from({ length: 20 }, (_, index) => ({ index, title: `Track ${index + 1}`, artist: "Band", duration: "02:00", isCurrent: index === 0 }));
	publish({ ...PLAYING, title: "Track 1", queue });
	const { at, rows, tab } = opened();
	const { line } = at("02  Track 2");
	assert.ok(rows().some((row) => row.includes("▼ 8 below")));
	assert.ok(!rows().some((row) => row.includes("Track 13")));
	assert.equal(tab.handleWheel(-1, line, 4), false, "already at the top");
	assert.equal(tab.handleWheel(1, line, 4), true);
	assert.ok(!rows().some((row) => row.includes("♪  Track 1 ")), "scrolled past the first");
	assert.ok(rows().some((row) => row.includes("Track 13")));
	assert.ok(rows().some((row) => row.includes("▲ 1 above · ▼ 7 below")));
	for (let i = 0; i < 20; i++) tab.handleWheel(1, line, 4);
	assert.ok(rows().some((row) => row.includes("Track 20")));
	assert.equal(tab.handleWheel(1, line, 4), false, "at the bottom");
	assert.equal(tab.handleWheel(-1, 3, 4), false, "over the Now playing card: the column's");

	publish(PLAYING);
	const short = opened();
	assert.equal(short.tab.handleWheel(1, short.at("02  Blinding Lights").line, 4), false, "a short queue does not scroll");
});

test("refresh: a render on each change while playing, none while paused, none once hidden; dispose lets go", () => {
	const player = publish(PLAYING);
	let now = 0;
	const { tab, calls, draw } = opened({ now: () => now });
	draw();
	assert.equal(player.listeners.size, 1, "subscribed to stateChange");
	player.emit({ currentTime: 76 });
	assert.equal(calls.renders, 1, "the progress moves");
	draw();
	now += 1000;
	player.emit({ currentTime: 77 });
	assert.equal(calls.renders, 2);
	draw();

	player.emit({ status: "paused" });
	assert.equal(calls.renders, 3, "the pause itself redraws");
	draw();
	player.emit({});
	player.emit({ lastUpdated: 2 });
	assert.equal(calls.renders, 3, "paused, the same state: no redraw");

	player.emit({ status: "playing", currentTime: 78 });
	assert.equal(calls.renders, 4);
	now += 5000; // the column drew another tab: no render came
	player.emit({ currentTime: 83 });
	assert.equal(calls.renders, 4, "hidden: no redraw");
	assert.equal(player.listeners.size, 0, "and no longer listening");

	tab.onShow();
	draw();
	assert.equal(player.listeners.size, 1, "shown again: listening again");
	tab.dispose();
	assert.equal(player.listeners.size, 0);
});

test("a player published after the tab opened is picked up on the next render", () => {
	const { rows, draw } = opened();
	assert.ok(rows().some((row) => row.includes("not installed")));
	const player = publish(PLAYING);
	draw();
	assert.equal(player.listeners.size, 1);
	assert.ok(rows().some((row) => row.includes("▶ Starboy")));
});

// --- the cover ---

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function kitty({ images = "kitty", toPng } = {}) {
	const drawn = [];
	const deps = {
		images: () => images,
		allocateImageId: () => 7,
		renderImage: (base64, dimensions, options) => {
			drawn.push({ base64, dimensions, options });
			return { sequence: `<IMG ${options.imageId}>`, columns: options.maxWidthCells, rows: 3, imageId: options.imageId };
		},
		toPng: toPng ?? (async () => undefined),
	};
	return { deps, drawn };
}

test("pngSize reads a PNG's width and height from its header", () => {
	assert.deepEqual(pngSize(Buffer.from(PNG_1x1, "base64")), { widthPx: 1, heightPx: 1 });
	assert.equal(pngSize(Buffer.from("not a png")), undefined);
});

test("where the terminal draws Kitty images the cover is read in the background and drawn beside the title", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gentle-quiet-yt-"));
	const file = path.join(dir, "cover.png");
	writeFileSync(file, Buffer.from(PNG_1x1, "base64"));
	publish({ ...PLAYING, thumbnailPath: file });
	const { deps, drawn } = kitty();
	let renders = 0;
	const cover = createCover(() => renders++, deps);
	const { rows } = opened({ cover });
	assert.ok(rows().some((row) => row.includes("┌─────┐")), "the stand-in while it loads");
	await settle();
	assert.equal(renders, 1, "a redraw once it is read");
	const out = rows();
	const title = out.find((row) => row.includes("▶ Starboy"));
	assert.match(title, /^│  <IMG 7> {7} {2}▶ Starboy/, "the image, then room for its columns");
	assert.ok(!out.some((row) => row.includes("┌─────┐")));
	assert.equal(drawn.at(-1).options.maxHeightCells, 3);
	assert.equal(drawn.at(-1).options.moveCursor, false);
	assert.deepEqual(drawn.at(-1).dimensions, { widthPx: 1, heightPx: 1 });
});

test("a JPEG cover is converted to PNG off the render; without a converter or an image protocol the stand-in stays", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "gentle-quiet-yt-"));
	const file = path.join(dir, "cover.jpg");
	writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
	publish({ ...PLAYING, thumbnailPath: file });
	const converted = [];
	const { deps } = kitty({ toPng: async (buffer) => (converted.push(buffer[0]), Buffer.from(PNG_1x1, "base64")) });
	const first = opened({ cover: createCover(() => {}, deps) });
	first.rows();
	await settle();
	assert.deepEqual(converted, [0xff]);
	assert.ok(first.rows().some((row) => row.includes("<IMG 7>")));

	const none = kitty();
	const second = opened({ cover: createCover(() => {}, none.deps) });
	second.rows();
	await settle();
	assert.ok(second.rows().some((row) => row.includes("┌─────┐")), "no converter: the stand-in");

	const text = kitty({ images: null });
	const third = opened({ cover: createCover(() => {}, text.deps) });
	third.rows();
	await settle();
	assert.ok(third.rows().some((row) => row.includes("┌─────┐")));
	assert.equal(text.drawn.length, 0, "no image protocol: nothing read or drawn");
});

test("the published base64 cover is used when there is no file", async () => {
	publish({ ...PLAYING, thumbnailBase64: PNG_1x1 });
	const { deps } = kitty();
	const { rows } = opened({ cover: createCover(() => {}, deps) });
	rows();
	await settle();
	assert.ok(rows().some((row) => row.includes("<IMG 7>")));
});
