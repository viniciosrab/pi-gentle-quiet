import assert from "node:assert/strict";
import { test } from "node:test";
import { load, painted, plain, theme } from "./helpers.mjs";
import { formatTime, musicDeps, musicTiming, parseStatus } from "../extensions/sidebar/music.ts";

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const PREV = "\u{F04AE}";
const PLAY = "\u{F040A}";
const PAUSE = "\u{F03E4}";
const NEXT = "\u{F04AD}";
const LIST = "\u{F0CB8}";
const POWER = "⏻";
// Nerd Font's Material hearts: JetBrains Mono has no ♡, and its ♥ falls back to another font.
const LOVED = "\u{F02D1}";
const UNLOVED = "\u{F02D5}";
const SHUFFLE = "\u{F049D}";
const SEQUENCE = "\u{F049E}";
const REPEAT_OFF = "\u{F0457}";
const REPEAT_ALL = "\u{F0456}";
const REPEAT_ONE = "\u{F0458}";

const status = (overrides = {}) =>
	JSON.stringify({
		ok: true,
		state: "playing",
		track: { title: "Shimmer ( LoFi , Chill )", artist: "HoliznaCC0", album: "Public Domain Lofi", path: "https://radio.cliamp.stream/lofi/tracks/3d984cd3b593ecfc", stream: true },
		position: 136.4,
		duration: 180.66,
		shuffle: false,
		repeat: "Off",
		...overrides,
	});

// cliamp's 15 categories, as provider.playlists answers.
const CATEGORIES = [
	["lofi", "Lofi", 120], ["meditative", "Meditative", 25], ["synthwave", "Synthwave", 60], ["edm", "EDM", 40], ["omarchy", "Omarchy", 12],
	["chiptune", "Chiptunes", 30], ["amiga", "Amiga", 50], ["ncs", "NCS", 80], ["ncs-house", "NCS House", 20], ["ncs-dubstep", "NCS Dubstep", 21],
	["ncs-dnb", "NCS Drum & Bass", 22], ["ncs-trap", "NCS Trap", 23], ["ncs-phonk", "NCS Phonk", 24], ["ncs-pop", "NCS Pop", 25], ["ncs-chill", "NCS Chill", 26],
];
const PLAYLISTS_ARGS = ["remote", "call", "provider.playlists", "--params", '{"provider":"cliamp","limit":50}', "--wait"];
const playlists = () =>
	JSON.stringify({
		ok: true,
		job: { state: "succeeded", result: { ok: true, total: 15, playlists: CATEGORIES.map(([id, name, track_count]) => ({ id, name, provider: "cliamp", track_count })) } },
	});
const LOCAL_ARGS = ["remote", "call", "provider.playlists", "--params", '{"provider":"local","limit":20}', "--wait"];
const local = () =>
	JSON.stringify({
		ok: true,
		job: { state: "succeeded", result: { ok: true, total: 2, playlists: [{ id: "Favorites", name: "Favorites", provider: "local", track_count: 2 }, { id: "Recently Played", name: "Recently Played", provider: "local", track_count: 9 }] } },
	});
const loadArgs = (id, index, provider = "cliamp") => ["remote", "call", "provider.load", "--params", `{"provider":"${provider}","playlist":"${id}","index":${index}}`, "--wait"];
const tracksArgs = (id, provider = "cliamp") => ["remote", "call", "provider.tracks", "--params", `{"provider":"${provider}","playlist":"${id}","limit":500}`, "--wait"];
// What reached the favorites store: a toggle of { path, title, artist, album }, and the reads of its paths.
const toggled = ({ path, title, artist, album }) => ["toggle", { path, title, artist, album }];
const READ_FAVORITES = ["favorites"];
// Each list's tracks as provider.tracks answers ([title, artist, path after the host]); the first one has no index,
// and none says whether it is a favorite, as cliamp sends them: the Favorites list says it.
const TRACKS = {
	lofi: [["Dawn", "Kyle", "lofi/tracks/a1"], ["Shimmer ( LoFi , Chill )", "HoliznaCC0", "lofi/tracks/3d984cd3b593ecfc"], ["Rain", "Mira", "lofi/tracks/c3"]],
	synthwave: [["Neon", "Volt", "synthwave/tracks/s1"], ["Drive", "Grid Runner", "synthwave/tracks/s2"], ["Grid", "Volt", "synthwave/tracks/s3"]],
	Favorites: [["Neon", "Volt", "synthwave/tracks/s1"], ["Pixel", "Bit", "chiptune/tracks/p1"]],
};
const SHIMMER = "https://radio.cliamp.stream/lofi/tracks/3d984cd3b593ecfc";
const track = (id, index) => {
	const [title, artist, tail] = TRACKS[id][index];
	return { title, artist, album: "A", path: `https://radio.cliamp.stream/${tail}`, stream: true, ...(index ? { index } : {}) };
};
const answer = (list) => JSON.stringify({ ok: true, job: { state: "succeeded", result: { ok: true, total: list.length, tracks: list } } });
const tracks = (id) => answer(TRACKS[id].map((_, index) => track(id, index)));
// A player on Lofi's Shimmer: provider.playlists (cliamp's and the local ones), provider.tracks, provider.load and
// queue.play answer as `options` say. Its Favorites (favorites.toml, which `reply.favoritePaths` and
// `reply.toggle` stand for) start as TRACKS.Favorites, plus Shimmer when `loved`; a toggle adds or removes the
// track, or fails with `refuse` as its reason; `favorites: false` is a file that cannot be read.
function player({ state = "playing", load = true, queue = true, trackList = true, favorites = true, refuse, loved = false, track: playing } = {}) {
	const now = { text: status({ state, ...(playing ? { track: playing } : {}) }) };
	const saved = [...TRACKS.Favorites.map((_, index) => track("Favorites", index)), ...(loved ? [JSON.parse(status()).track] : [])];
	const reply = (args) => {
		if (args[0] === "status") return now.text;
		if (args[2] === "provider.playlists") return JSON.parse(args[4]).provider === "local" ? local() : playlists();
		if (args[2] === "provider.tracks") {
			const { playlist } = JSON.parse(args[4]);
			if (playlist === "Favorites") return favorites ? answer(saved.map((item, index) => ({ ...item, index }))) : loaded(false);
			return trackList ? tracks(playlist) : loaded(false);
		}
		if (args[2] === "provider.load") return loaded(load);
		if (args[2] === "queue.play") return loaded(queue);
		return "";
	};
	reply.favoritePaths = async () => (favorites ? new Set(saved.map((item) => item.path)) : undefined);
	reply.toggle = async (item) => {
		if (refuse) throw new Error(refuse);
		const at = saved.findIndex((other) => other.path === item.path);
		if (at >= 0) saved.splice(at, 1);
		else saved.unshift(item);
		return at < 0;
	};
	return { now, reply, saved };
}
const loaded = (ok = true) => JSON.stringify({ ok: true, job: { state: ok ? "succeeded" : "failed", result: { ok } } });

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// The side column on a wide fullscreen terminal, with cliamp answering `reply(args)` (undefined: not running).
async function column(t, reply, { overlay = true } = {}) {
	const calls = [];
	const saved = musicDeps.run;
	const store = { favoritePaths: musicDeps.favoritePaths, toggleFavorite: musicDeps.toggleFavorite, spawn: musicDeps.spawn, readPid: musicDeps.readPid, processName: musicDeps.processName, kill: musicDeps.kill };
	musicDeps.run = async (args) => (calls.push(args), reply(args));
	// favorites.toml is never touched here: its reads and toggles are recorded and answered by the player.
	musicDeps.favoritePaths = async () => (calls.push(READ_FAVORITES), reply.favoritePaths ? reply.favoritePaths() : new Set());
	musicDeps.toggleFavorite = async (item) => (calls.push(["toggle", item]), reply.toggle ? reply.toggle(item) : true);
	// No process is started or signalled here either: spawn, the pid file, /proc and kill are recorded.
	musicDeps.spawn = (command, args, options) => {
		calls.push(["spawn", command, args, options]);
		reply.spawned?.();
		return { on() {}, unref: () => calls.push(["unref"]) };
	};
	musicDeps.readPid = async () => (calls.push(["pid"]), reply.pid?.());
	musicDeps.processName = async (pid) => (calls.push(["comm", pid]), reply.comm?.(pid));
	musicDeps.kill = (pid, signal) => (calls.push(["kill", pid, signal]), reply.killed?.());
	t.after(() => Object.assign(musicDeps, { run: saved, ...store }));
	// Pi's overlay UI, recording what it is asked to show; component() builds it like Pi does.
	const popup = { custom: [], done: [] };
	const host = { terminal: { columns: 180, rows: 40 }, requestRender() {}, dispatchMouseToOverlay: () => ({ hit: false }) };
	const custom = (factory, options) => (popup.custom.push({ factory, options }), new Promise(() => {}));
	popup.component = () => popup.custom.at(-1).factory(host, theme, {}, (value) => popup.done.push(value));
	const loaded = await load({ mode: "tui", session: { id: "music-session", cwd: "/srv/app" }, ...(overlay ? { custom } : {}) });
	const native = { type: "vstack", entries: [] };
	const root = { render: () => [], [NODE]: () => native };
	const tui = { terminal: { columns: 180, rows: 40 }, mode: "fullscreen", layoutRoot: root, requestRender() {} };
	loaded.footer()?.(tui, theme, { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} });
	const rail = () => root[NODE]().entries?.[1]?.component?.[NODE]?.().entries?.[2]?.component;
	const raw = () => rail()?.render(60) ?? [];
	const rows = () => raw().map(plain);
	const mouse = (type, y, x) => rail().handleMouse({ type, button: "left", x, y, width: 60, height: 30, screenX: 120 + x, screenY: y });
	rows(); // the first draw asks cliamp
	await settle();
	return { ...loaded, rows, raw, mouse, calls, popup };
}

test("cliamp's status: the track, its position and the state; anything else is no player", () => {
	assert.deepEqual(parseStatus(status()), {
		state: "playing",
		title: "Shimmer ( LoFi , Chill )",
		artist: "HoliznaCC0",
		path: "https://radio.cliamp.stream/lofi/tracks/3d984cd3b593ecfc",
		playlist: "lofi",
		track: JSON.parse(status()).track,
		shuffle: false,
		repeat: "off",
		position: 136.4,
		duration: 180.66,
	});
	assert.equal(parseStatus(status({ ok: false })), undefined);
	assert.equal(parseStatus("not json"), undefined);
	assert.equal(parseStatus(undefined), undefined);
	assert.deepEqual(parseStatus(JSON.stringify({ ok: true, state: "stopped" })), { state: "stopped", title: "", artist: "", path: "", playlist: "", track: undefined, shuffle: false, repeat: "off", position: 0, duration: 0 });
	assert.equal(parseStatus(status({ shuffle: true })).shuffle, true);
	assert.equal(formatTime(0), "0:00");
	assert.equal(formatTime(136.4), "2:16");
	assert.equal(formatTime(3725), "1:02:05");
});

test("with cliamp playing MAIN draws a Music card under Context: the category, the artist and track on one row, a bar and the controls", async (t) => {
	const { rows, raw, calls } = await column(t, (args) => (args[0] === "status" ? status() : playlists()));
	assert.deepEqual(calls[0], ["status", "--json"]);
	assert.deepEqual(calls[1], PLAYLISTS_ARGS, "the categories, asked once the card shows");
	assert.deepEqual(calls[2], LOCAL_ARGS, "the local lists");
	assert.deepEqual(calls[3], READ_FAVORITES, "and favorites.toml's paths, which say what is a favorite");
	await settle();
	const out = rows().map((row) => row.replace(/ +│$/, ""));
	const top = out.findIndex((row) => row === "│ Music");
	assert.equal(top, 1, `the first card under Status and Context:\n${out.join("\n")}`);
	assert.equal(out[top + 1], "│", "a blank row under the title");
	assert.equal(out[top + 2], `│ ${LIST} Lofi · 120 tracks ▾`, "the current category, from the track's path, with how many tracks it has");
	assert.equal(out[top + 3], "│ HoliznaCC0 · Shimmer ( LoFi , Chill )", "the artist, then the title, on one row");
	assert.match(out[top + 4], /^│ ━+●─+$/, "cliamp's seek bar: played ━, the head ●, the rest ─");
	const bar = raw()[top + 4];
	assert.ok(painted(bar, "accent", "━") && painted(bar, "accent", "●"), "played part and head in accent");
	assert.ok(painted(bar, "dim", "─"), "the rest dim");
	assert.match(out[top + 5], new RegExp(`^│ 2:1\\d / 3:00 +${SEQUENCE}  ${REPEAT_OFF}  ${UNLOVED}  ${PREV}  ${PAUSE}  ${NEXT}  ${POWER}$`, "u"), "the time, shuffle, repeat, the ♥, playing, pause between previous and next, and ⏻");
	const drawn = raw();
	assert.ok(painted(drawn[top], "toolTitle", theme.bold("Music")), "the title like the Status card's");
	assert.ok(painted(drawn[top + 2], "text", "Lofi"));
	assert.ok(painted(drawn[top + 2], "dim", " ▾"));
	assert.ok(painted(drawn[top + 2], "muted", " · 120 tracks"), "the count muted");
	assert.ok(painted(drawn[top + 3], "muted", "HoliznaCC0 · "), "the artist muted, first");
	assert.ok(painted(drawn[top + 3], "text", "Shimmer ( LoFi , Chill )"), "then the title in text");
	assert.ok(painted(drawn[top + 5], "dim", UNLOVED), "not a favorite: an outlined heart, dim");
	assert.equal(calls.filter((args) => JSON.stringify(args) === JSON.stringify(PLAYLISTS_ARGS)).length, 1, "the categories are asked once");
});

test("an artist and title too long for the card are cut with … on their one row; without an artist, the title alone", async (t) => {
	const title = "Tranquil Mindscape ( Lofi , Happy , Reflection ) and a very long remix name";
	const long = await column(t, (args) => (args[0] === "status" ? status({ track: { title, artist: "HoliznaCC0 featuring Somebody", path: "https://radio.cliamp.stream/lofi/tracks/9" } }) : playlists()));
	await settle();
	const out = long.rows();
	const y = out.findIndex((row) => row.includes("Tranquil"));
	assert.match(out[y], /^│ HoliznaCC0 featuring Somebody · Tranquil Mindscape .*…\s*│$/u, out.join("\n"));
	assert.equal([...out[y]].length, [...out[y - 1]].length, "within the card");
	assert.ok(!out.some((row, index) => index !== y && /Somebody|Tranquil|remix/.test(row)), "no second row");
	assert.match(out[y + 1], /━|─/, "the bar right under it");
	const bare = await column(t, (args) => (args[0] === "status" ? status({ track: { title: "Song", path: "https://radio.cliamp.stream/lofi/tracks/8" } }) : playlists()));
	await settle();
	assert.ok(bare.rows().some((row) => /^│ Song +│$/.test(row)), bare.rows().join("\n"));
	assert.ok(!bare.rows().some((row) => row.includes("Song ·")));
});

test("a track from no known category, or no list, shows Playlists", async (t) => {
	const { rows } = await column(t, (args) => (args[0] === "status" ? status({ track: { title: "Song", path: "/home/me/song.mp3" } }) : playlists()));
	await settle();
	assert.ok(rows().some((row) => row.startsWith(`│ ${LIST} Playlists ▾`)), rows().join("\n"));
	const { rows: bare } = await column(t, (args) => (args[0] === "status" ? status() : undefined));
	await settle();
	assert.ok(bare().some((row) => row.startsWith(`│ ${LIST} Playlists ▾`)), bare().join("\n"));
});

// Opens the picker from the category row; returns the pop-up and its rows.
async function openPicker(t, reply) {
	const music = await column(t, reply);
	await settle();
	const out = music.rows();
	const y = out.findIndex((row) => row.includes(LIST));
	const x = [...out[y]].indexOf("▾");
	const before = music.calls.length;
	assert.equal(music.mouse("click", y, x)?.handled, true, "the category row takes the click");
	await settle();
	assert.equal(music.popup.custom.length, 1, "one pop-up");
	assert.equal(music.popup.custom[0].options.overlay, true);
	assert.deepEqual(music.calls.slice(before).filter((args) => args[0] !== "status"), [READ_FAVORITES], "opening reads the favorites again, nothing else");
	const picker = music.popup.component();
	const shown = () => picker.render(50).map(plain);
	return { ...music, picker, shown, before: music.calls.length };
}

test("a click on the category opens a pop-up over Pi with every category and its tracks, the current one selected", async (t) => {
	const { shown, popup, picker } = await openPicker(t, player().reply);
	const out = shown();
	assert.ok(out[1].includes("cliamp · Playlists"), out.join("\n"));
	const listed = out.filter((row) => row.includes(" tracks")).map((row) => row.replace(/^▏ [▸ ] /, "").replace(/ +▕$/, ""));
	assert.equal(listed.length, 16, out.join("\n"));
	assert.deepEqual(listed.map((row) => row.replace(/^● /, "")), [`${LOVED} Favorites · 2 tracks`, ...CATEGORIES.map(([, name, count]) => `${name} · ${count} tracks`)], "the Favorites first");
	assert.ok(painted(picker.render(50)[2], "error", LOVED), "a filled heart, red");
	assert.ok(out.some((row) => row.startsWith("▏ ▸ ● Lofi · 120 tracks")), "the current one marked and under the cursor");
	const place = popup.custom[0].options.overlayOptions();
	assert.ok(place.width <= 55);
});

test("the pop-up is centered over the Music card, wherever on the row the click was", async (t) => {
	const cols = [];
	for (const pick of [(row) => [...row].indexOf("▾"), () => 3]) {
		const music = await column(t, player().reply);
		await settle();
		const out = music.rows();
		const y = out.findIndex((row) => row.includes(LIST));
		music.mouse("click", y, pick(out[y]));
		await settle();
		music.popup.component();
		const place = music.popup.custom[0].options.overlayOptions();
		// The column spans screen columns 120..179 (60 wide, against the 180-column terminal's right edge): the pop-up's middle sits on the card's middle.
		assert.equal(place.col, 120 + Math.floor((60 - place.width) / 2), JSON.stringify(place));
		cols.push(place.col);
	}
	assert.equal(cols[0], cols[1], "the click's column does not move it");
});

// The track rows the pop-up shows, without the outline and the cursor.
const trackRows = (shown) => shown().filter((row) => row.includes(" · ") && !row.includes("cliamp ·") && !row.includes("Esc")).map((row) => row.replace(/^▏ [▸ ] [\u{F02D1}\u{F02D5}] /u, "").replace(/ +▕$/, ""));
const settled = async (picker, keys) => {
	for (const key of keys) picker.handleInput(key);
	await settle();
};

test("Enter on a category opens its tracks in the same pop-up; nothing is loaded", async (t) => {
	const { picker, calls, before, popup, shown } = await openPicker(t, player().reply);
	await settled(picker, ["\x1b[B", "j", "k", "j", "\r"]); // ↓ Meditative, ↓ Synthwave
	assert.deepEqual(calls.slice(before).filter((args) => args[0] !== "status"), [tracksArgs("synthwave")], "only the tracks are asked");
	assert.equal(popup.done.length, 0, "still open");
	const out = shown();
	assert.ok(out[1].includes("cliamp · Synthwave"), out.join("\n"));
	assert.deepEqual(trackRows(shown), ["Neon · Volt", "Drive · Grid Runner", "Grid · Volt"]);
	assert.ok(out.some((row) => row.startsWith(`▏ ▸ ${LOVED} Neon · Volt`)), "not the category playing: the first track selected, a favorite");
	assert.ok(out.some((row) => row.startsWith(`▏   ${UNLOVED} Drive · Grid Runner`)), "not a favorite: the outlined heart");
	assert.ok(out.some((row) => row.includes("← back") && row.includes(`f ${LOVED}`)));
	assert.ok(picker.render(50).some((row) => painted(row, "muted", "Grid Runner")), "the artist muted");
});

test("a track of another category is loaded at its index, then the status is read; play only when not playing", async (t) => {
	for (const [state, played] of [["playing", false], ["stopped", true]]) {
		const music = player({ state });
		const { picker, calls, before, popup } = await openPicker(t, music.reply);
		await settled(picker, ["j", "j", "\r"]);
		const listed = calls.length;
		await settled(picker, ["j", "\r"]); // Drive
		assert.equal(popup.done.length, 1, "the pop-up closed");
		const ran = calls.slice(listed);
		assert.deepEqual(ran.slice(0, 2), [loadArgs("synthwave", 1), ["status", "--json"]]);
		assert.ok(!ran.some((args) => args[2] === "queue.play"), "provider.load plays that track itself");
		assert.equal(ran.some((args) => args[0] === "play"), played, `${state}: play ${played ? "runs" : "does not run"}`);
		if (played) assert.deepEqual(ran[2], ["play"]);
		assert.ok(calls.slice(before).every((args) => args[2] !== "provider.load" || calls.indexOf(args) >= listed));
	}
});

test("a track of the category playing is loaded at its index too, never picked from a live queue that may hold another list; a click picks", async (t) => {
	const { picker, calls, popup, shown } = await openPicker(t, player().reply);
	await settled(picker, ["\r"]); // Lofi, the category playing
	const out = shown();
	assert.ok(out.some((row) => row.startsWith(`▏ ▸ ${UNLOVED} ● Shimmer ( LoFi , Chill ) · HoliznaCC0`)), out.join("\n"));
	const listed = calls.length;
	assert.deepEqual(picker.handleMouse({ type: "click", button: "left", x: 4, y: 2 + 2 }), { handled: true, render: true }); // top, title, then the third: Rain
	await settle();
	assert.equal(popup.done.length, 1);
	const ran = calls.slice(listed);
	assert.deepEqual(ran.slice(0, 2), [loadArgs("lofi", 2), ["status", "--json"]]);
	assert.ok(!ran.some((args) => args[2] === "queue.play" || args[0] === "play"), "no queue.play: the live queue may be Favorites or another list");
});

test("a failed load closes the pop-up and leaves the card as it was", async (t) => {
	for (const [options, keys, expected] of [[{ load: false }, ["j", "j", "\r", "\r"], [loadArgs("synthwave", 0)]], [{ load: false }, ["\r", "\r"], [loadArgs("lofi", 1)]]]) {
		const { picker, calls, popup, rows } = await openPicker(t, player(options).reply);
		await settled(picker, keys.slice(0, -1));
		const listed = calls.length;
		await settled(picker, keys.slice(-1));
		assert.equal(popup.done.length, 1);
		assert.deepEqual(calls.slice(listed).filter((args) => args[0] !== "status"), expected, "nothing after the failure");
		assert.ok(rows().some((row) => row.startsWith(`│ ${LIST} Lofi · 120 tracks ▾`)));
	}
});

test("Esc, ← or h on the tracks go back to the categories, the category still selected; q closes", async (t) => {
	const { picker, calls, popup, shown } = await openPicker(t, player().reply);
	for (const key of ["\x1b", "\x1b[D", "h"]) {
		await settled(picker, ["j", "j", "\r"]);
		assert.ok(shown()[1].includes("cliamp · Synthwave"));
		const listed = calls.length;
		await settled(picker, [key]);
		assert.equal(popup.done.length, 0, `${JSON.stringify(key)} did not close it`);
		assert.ok(shown()[1].includes("cliamp · Playlists"), shown().join("\n"));
		assert.ok(shown().some((row) => row.startsWith("▏ ▸ Synthwave")), "the category still selected");
		assert.deepEqual(calls.slice(listed).filter((args) => args[0] !== "status"), [], "nothing ran");
		await settled(picker, ["k", "k"]);
	}
	assert.equal(calls.filter((args) => JSON.stringify(args) === JSON.stringify(tracksArgs("synthwave"))).length, 1, "the tracks are asked once");
	await settled(picker, ["\r", "q"]);
	assert.equal(popup.done.length, 1, "q closed it");
});

test("the tracks that cannot be read show a row saying so", async (t) => {
	const { picker, shown } = await openPicker(t, player({ trackList: false }).reply);
	await settled(picker, ["\r"]);
	assert.ok(shown().some((row) => row.includes("Could not read the tracks")), shown().join("\n"));
	await settled(picker, ["\x1b"]);
	assert.ok(shown()[1].includes("cliamp · Playlists"));
});

test("a click on the track or the artist opens the tracks of the category playing, the current one marked", async (t) => {
	for (const text of ["Shimmer", "HoliznaCC0"]) {
		const music = await column(t, player().reply);
		await settle();
		const out = music.rows();
		const y = out.findIndex((row) => row.includes(text));
		const before = music.calls.length;
		assert.equal(music.mouse("click", y, 4)?.handled, true, text);
		assert.equal(music.popup.custom.length, 1);
		const picker = music.popup.component();
		await settle();
		const shown = () => picker.render(50).map(plain);
		assert.ok(shown()[1].includes("cliamp · Lofi"), shown().join("\n"));
		assert.ok(shown().some((row) => row.startsWith(`▏ ▸ ${UNLOVED} ● Shimmer ( LoFi , Chill ) · HoliznaCC0`)));
		assert.deepEqual(music.calls.slice(before).filter((args) => args[0] !== "status"), [READ_FAVORITES, tracksArgs("lofi")]);
		await settled(picker, ["\x1b"]);
		assert.ok(shown().some((row) => row.startsWith("▏ ▸ ● Lofi")), "Esc: the categories, Lofi selected");
	}
});

test("Favorites lists the local provider's favorites; a track plays from it with provider local", async (t) => {
	const { picker, calls, popup, shown } = await openPicker(t, player().reply);
	await settled(picker, ["k"]); // above Lofi: Favorites
	assert.ok(shown().some((row) => row.startsWith(`▏ ▸ ${LOVED} Favorites · 2 tracks`)), shown().join("\n"));
	let listed = calls.length;
	await settled(picker, ["\r"]);
	assert.deepEqual(calls.slice(listed).filter((args) => args[0] !== "status"), [tracksArgs("Favorites", "local")]);
	assert.ok(shown()[1].includes("cliamp · Favorites"));
	assert.deepEqual(trackRows(shown), ["Neon · Volt", "Pixel · Bit"]);
	assert.ok(shown().every((row) => !/Neon|Pixel/.test(row) || new RegExp(`^▏ [▸ ] ${LOVED} `, "u").test(row)), "every favorite has its filled heart");
	listed = calls.length;
	await settled(picker, ["j", "\r"]);
	assert.equal(popup.done.length, 1);
	const ran = calls.slice(listed);
	assert.deepEqual(ran.slice(0, 2), [loadArgs("Favorites", 1, "local"), ["status", "--json"]]);
	assert.ok(!ran.some((args) => args[2] === "queue.play" || args[0] === "play"));
});

test("f toggles the selected track's ♥ in favorites.toml, in a category and in Favorites", async (t) => {
	const { picker, calls, shown, popup } = await openPicker(t, player().reply);
	await settled(picker, ["j", "j", "\r"]); // Synthwave
	await settled(picker, ["j"]); // Drive
	let listed = calls.length;
	await settled(picker, ["f"]);
	assert.deepEqual(calls.slice(listed).filter((args) => args[0] !== "status"), [toggled(track("synthwave", 1)), READ_FAVORITES], "then the favorites are read again");
	assert.ok(shown().some((row) => row.startsWith(`▏ ▸ ${LOVED} Drive`)), shown().join("\n"));
	listed = calls.length;
	await settled(picker, ["f"]);
	assert.deepEqual(calls.slice(listed).filter((args) => args[0] !== "status"), [toggled(track("synthwave", 1)), READ_FAVORITES], "the same track");
	assert.ok(shown().some((row) => row.startsWith(`▏ ▸ ${UNLOVED} Drive`)));
	await settled(picker, ["\x1b", "k", "k", "k", "\r"]); // Favorites
	assert.ok(shown()[1].includes("cliamp · Favorites"), shown().join("\n"));
	listed = calls.length;
	await settled(picker, ["f"]);
	assert.deepEqual(calls.slice(listed).filter((args) => args[0] !== "status"), [toggled(track("Favorites", 0)), READ_FAVORITES]);
	assert.deepEqual(trackRows(shown), ["Neon · Volt", "Pixel · Bit"], "the un-favorited track stays");
	assert.ok(shown().some((row) => row.startsWith(`▏ ▸ ${UNLOVED} Neon`)));
	assert.equal(popup.done.length, 0, "f does not close it");
});

test("a ♥ that could not be saved flips back, and the card says why for a few seconds", async (t) => {
	const { picker, shown, rows, raw, calls } = await openPicker(t, player({ refuse: "cliamp's favorites are busy" }).reply);
	await settled(picker, ["j", "j", "\r"]);
	const listed = calls.length;
	await settled(picker, ["j", "f"]);
	assert.deepEqual(calls.slice(listed).filter((args) => args[0] !== "status"), [toggled(track("synthwave", 1))], "nothing read after a failure");
	assert.ok(shown().some((row) => row.startsWith(`▏ ▸ ${UNLOVED} Drive`)), shown().join("\n"));
	const notice = rows().findIndex((row) => row.includes(`${LOVED} not saved: cliamp's favorites are busy`));
	assert.ok(notice > 0, rows().join("\n"));
	assert.ok(painted(raw()[notice], "dim", `${LOVED} not saved: cliamp's favorites are busy`));
});

test("a card ♥ that could not be saved stays empty and says why", async (t) => {
	const { rows, raw, mouse } = await column(t, player({ refuse: "flock is not installed" }).reply);
	await settle();
	const out = rows();
	const y = out.findIndex((row) => row.includes(PAUSE));
	mouse("click", y, [...out[y]].indexOf(UNLOVED));
	await settle();
	assert.ok(painted(raw().find((line) => plain(line).includes(PAUSE)), "dim", UNLOVED));
	assert.ok(rows().some((row) => row.includes(`${LOVED} not saved: flock is not installed`)), rows().join("\n"));
});

test("the heart before previous: red when the track is in favorites.toml; a click toggles it, then reads the favorites", async (t) => {
	const music = player();
	const { rows, raw, mouse, calls } = await column(t, music.reply);
	await settle();
	const out = rows();
	const y = out.findIndex((row) => row.includes(PAUSE));
	assert.ok(painted(raw()[y], "dim", UNLOVED), "not in Favorites: an outlined heart");
	const before = calls.length;
	assert.equal(mouse("click", y, [...out[y]].indexOf(UNLOVED))?.handled, true);
	await settle();
	assert.deepEqual(calls.slice(before).filter((args) => args[0] !== "status"), [toggled(JSON.parse(status()).track), READ_FAVORITES]);
	assert.ok(music.saved.some((item) => item.path === SHIMMER));
	assert.ok(painted(raw().find((line) => plain(line).includes(PAUSE)), "error", LOVED), "now a filled heart, red");
	const loved = await column(t, player({ loved: true }).reply);
	await settle();
	assert.ok(painted(loved.raw().find((line) => plain(line).includes(PAUSE)), "error", LOVED), "in Favorites: a filled heart, red");
	const unknown = await column(t, player({ track: { title: "Song", path: "/home/me/song.mp3" } }).reply);
	await settle();
	assert.ok(!unknown.rows().some((line) => /[\u{F02D1}\u{F02D5}]/u.test(line)), "no category known: no heart");
});

test("the tracks' hearts come from Favorites, matched by path", async (t) => {
	const { picker, shown } = await openPicker(t, player({ loved: true }).reply);
	await settled(picker, ["\r"]); // Lofi
	const drawn = picker.render(50);
	assert.ok(shown().some((row) => row.startsWith(`▏ ▸ ${LOVED} ● Shimmer`)), shown().join("\n"));
	assert.ok(painted(drawn.find((row) => plain(row).includes("Shimmer")), "error", LOVED), "red");
	assert.ok(shown().some((row) => row.startsWith(`▏   ${UNLOVED} Dawn`)), "Dawn is not a favorite");
});

test("without the Favorites every heart is empty and a toggle still works", async (t) => {
	const music = player({ favorites: false });
	const { rows, raw, mouse, calls } = await column(t, music.reply);
	await settle();
	const out = rows();
	const y = out.findIndex((row) => row.includes(PAUSE));
	assert.ok(painted(raw()[y], "dim", UNLOVED));
	const before = calls.length;
	mouse("click", y, [...out[y]].indexOf(UNLOVED));
	await settle();
	assert.deepEqual(calls[before], toggled(JSON.parse(status()).track));
	assert.ok(painted(raw().find((line) => plain(line).includes(PAUSE)), "error", LOVED), "the toggle that succeeded shows");
});

test("Esc or q closes the picker without running anything", async (t) => {
	for (const key of ["\x1b", "q"]) {
		const { picker, calls, before, popup } = await openPicker(t, (args) => (args[0] === "status" ? status() : playlists()));
		picker.handleInput(key);
		await settle();
		assert.equal(popup.done.length, 1, `${JSON.stringify(key)} closed it`);
		assert.deepEqual(calls.slice(before).filter((args) => args[0] !== "status"), [], "nothing ran");
	}
});

test("without an overlay UI a click on the category does nothing", async (t) => {
	const { rows, mouse, calls } = await column(t, (args) => (args[0] === "status" ? status() : playlists()), { overlay: false });
	await settle();
	const out = rows();
	const y = out.findIndex((row) => row.includes(LIST));
	assert.ok(y > 0, "the category row is drawn");
	const before = calls.length;
	assert.equal(mouse("click", y, 4)?.handled, undefined);
	await settle();
	assert.deepEqual(calls.slice(before).filter((args) => args[0] !== "status"), []);
});

test("a paused player shows play in the middle", async (t) => {
	const { rows } = await column(t, () => status({ state: "paused" }));
	assert.ok(rows().some((row) => row.includes(`${PREV}  ${PLAY}  ${NEXT}`)));
});

test("without cliamp running there is no Music card", async (t) => {
	const { rows, calls } = await column(t, () => undefined);
	assert.ok(calls.length >= 1, "cliamp was asked");
	assert.ok(!rows().some((row) => row.includes("Music")));
});

test("while a new track loads (no duration yet) the bar stays, all dim like cliamp's buffering bar, and a click on it does nothing", async (t) => {
	const { rows, raw, mouse, calls } = await column(t, (args) => (args[0] === "status" ? status({ position: 0, duration: 0 }) : args[0] === "remote" ? playlists() : ""));
	const out = rows().map((row) => row.replace(/ +│$/, ""));
	const y = out.findIndex((row) => /^│ ─+$/.test(row));
	assert.ok(y > 0, `a dim bar while loading:\n${out.join("\n")}`);
	assert.ok(painted(raw()[y], "dim", "─"));
	assert.match(out[y + 1], /^│ 0:00 /, "the time under it");
	const before = calls.length;
	assert.equal(mouse("click", y, 10)?.handled, undefined, "nothing to seek yet");
	await settle();
	assert.ok(!calls.slice(before).some((args) => args[2] === "seek.absolute"));
});

test("a click on the seek bar jumps to that point of the track with seek.absolute, as cliamp's bar does", async (t) => {
	const { rows, mouse, calls } = await column(t, (args) => (args[0] === "status" ? status() : args[0] === "remote" && args[2] === "seek.absolute" ? JSON.stringify({ ok: true, job: { state: "succeeded", result: { ok: true } } }) : args[0] === "remote" ? playlists() : ""));
	const out = rows();
	const y = out.findIndex((row) => row.includes("●") && row.includes("━"));
	const inner = [...out[y]].length - 4; // "│ " and " │"
	const seek = (x) => {
		const before = calls.length;
		assert.equal(mouse("click", y, x)?.handled, true);
		return calls.slice(before);
	};
	assert.deepEqual(seek(2)[0], ["remote", "call", "seek.absolute", "--params", JSON.stringify({ value: 0 }), "--wait"], "the first column: the start");
	await settle();
	const half = 2 + Math.floor(inner / 2);
	assert.deepEqual(seek(half)[0], ["remote", "call", "seek.absolute", "--params", JSON.stringify({ value: Math.round((Math.floor(inner / 2) / inner) * 180.66) }), "--wait"], "the middle");
	await settle();
	assert.ok(calls.slice(-3).some((args) => args[0] === "status"), "the status is read after the jump");
	const before = calls.length;
	assert.equal(mouse("click", y + 1, half)?.handled, undefined, "the time row is not the bar");
	await settle();
	assert.ok(!calls.slice(before).some((args) => args[2] === "seek.absolute"));
});

test("a click on previous, play/pause or next runs that cliamp command and reads the status again", async (t) => {
	const { rows, mouse, calls } = await column(t, (args) => (args[0] === "status" ? status() : args[0] === "remote" ? playlists() : ""));
	const out = rows();
	const y = out.findIndex((row) => row.includes(PAUSE));
	const at = (glyph) => [...out[y]].indexOf(glyph);
	assert.ok(at(SEQUENCE) >= 0 && at(SEQUENCE) < at(PREV), "shuffle first");
	for (const [glyph, command] of [[PREV, "prev"], [PAUSE, "toggle"], [NEXT, "next"]]) {
		const before = calls.length;
		assert.equal(mouse("click", y, at(glyph))?.handled, true, command);
		await settle();
		assert.deepEqual(calls[before], [command], `${command} ran`);
		assert.ok(calls.slice(before + 1).some((args) => args[0] === "status"), `the status is read after ${command}`);
	}
	const before = calls.length;
	assert.equal(mouse("click", y, 3)?.handled, undefined, "the time does nothing");
	assert.equal(mouse("click", y - 1, at(PAUSE))?.handled, true, "the bar above seeks instead");
	await settle();
	assert.ok(!calls.slice(before).some((args) => ["prev", "toggle", "next"].includes(args[0])));
});

test("shuffle: on in accent, off dim; a click runs cliamp shuffle toggle, flips it at once, then reads the status", async (t) => {
	const on = await column(t, (args) => (args[0] === "status" ? status({ shuffle: true }) : args[0] === "remote" ? playlists() : ""));
	const lit = on.raw().find((row) => plain(row).includes(PAUSE));
	assert.ok(painted(lit, "accent", SHUFFLE), "on: the shuffle glyph in accent");
	assert.ok(!plain(lit).includes(SEQUENCE));
	let shuffle = false;
	const off = await column(t, (args) => (args[0] === "status" ? status({ shuffle }) : args[0] === "remote" ? playlists() : ""));
	const out = off.rows();
	const y = out.findIndex((row) => row.includes(PAUSE));
	assert.ok(painted(off.raw()[y], "dim", SEQUENCE), "off: the shuffle-disabled glyph dim");
	const before = off.calls.length;
	assert.equal(off.mouse("click", y, [...out[y]].indexOf(SEQUENCE))?.handled, true);
	assert.ok(painted(off.raw()[y], "accent", SHUFFLE), "flipped at once");
	shuffle = false; // cliamp did not take it: the status settles it
	await settle();
	assert.deepEqual(off.calls[before], ["shuffle", "toggle"]);
	assert.deepEqual(off.calls[before + 1], ["status", "--json"]);
	assert.ok(painted(off.raw()[y], "dim", SEQUENCE), "the status read back wins");
	const hidden = await column(t, player({ track: { title: "Song", path: "/home/me/song.mp3" } }).reply);
	await settle();
	const row = hidden.rows().find((line) => line.includes(PAUSE));
	assert.ok(row.replace(/ +│$/, "").match(new RegExp(`${SEQUENCE}  ${REPEAT_OFF}  ${PREV}`, "u")), "no ♥: shuffle and repeat first, before previous");
});

test("repeat: off dim, all and one in accent; a click runs cliamp repeat cycle, moves to the next mode at once, then reads the status", async (t) => {
	for (const [mode, glyph, role] of [["Off", REPEAT_OFF, "dim"], ["All", REPEAT_ALL, "accent"], ["One", REPEAT_ONE, "accent"]]) {
		const music = await column(t, (args) => (args[0] === "status" ? status({ repeat: mode }) : args[0] === "remote" ? playlists() : ""));
		const row = music.raw().find((line) => plain(line).includes(PAUSE));
		assert.ok(painted(row, role, glyph), `${mode}: ${role}`);
		assert.match(plain(row), new RegExp(`${SEQUENCE}  ${glyph}  `, "u"), `${mode}: right after shuffle`);
	}
	let repeat = "Off";
	const music = await column(t, (args) => (args[0] === "status" ? status({ repeat }) : args[0] === "remote" ? playlists() : ""));
	const out = music.rows();
	const y = out.findIndex((row) => row.includes(PAUSE));
	const before = music.calls.length;
	assert.equal(music.mouse("click", y, [...out[y]].indexOf(REPEAT_OFF))?.handled, true);
	assert.ok(painted(music.raw()[y], "accent", REPEAT_ALL), "off moves to all at once");
	repeat = "All";
	await settle();
	assert.deepEqual(music.calls[before], ["repeat", "cycle"]);
	assert.deepEqual(music.calls[before + 1], ["status", "--json"]);
	assert.ok(painted(music.raw()[y], "accent", REPEAT_ALL));
});

test("the card's ♥ is filled the moment the toggle is saved, before the favorites are read back", async (t) => {
	const music = player();
	const { rows, raw, mouse, calls } = await column(t, music.reply);
	await settle();
	music.reply.favoritePaths = () => new Promise(() => {}); // the read back never comes
	const out = rows();
	const y = out.findIndex((row) => row.includes(PAUSE));
	mouse("click", y, [...out[y]].indexOf(UNLOVED));
	await settle();
	assert.deepEqual(calls.filter((args) => args[0] === "toggle"), [toggled(JSON.parse(status()).track)], "favorites.toml gets the full title");
	assert.equal(calls.find((args) => args[0] === "toggle")[1].title, "Shimmer ( LoFi , Chill )");
	assert.ok(painted(raw()[y], "error", LOVED), raw()[y]);
});

test("Favorites counts favorites.toml's tracks, follows a toggle at once, and says 1 track", async (t) => {
	const { picker, shown } = await openPicker(t, player({ loved: true }).reply);
	const favorites = () => shown().find((row) => row.includes("Favorites ·"));
	assert.match(favorites(), /Favorites · 3 tracks/, "favorites.toml has 3, cliamp's list says 2");
	await settled(picker, ["j", "j", "\r"]); // Synthwave
	await settled(picker, ["j", "f"]); // Drive loved
	await settled(picker, ["\x1b"]);
	assert.match(favorites(), /Favorites · 4 tracks/, "without opening it again");
	await settled(picker, ["\r", "f", "j", "f", "k", "k", "f"]); // Synthwave: Drive, Grid… Neon un-loved
	await settled(picker, ["\x1b"]);
	assert.match(favorites(), /Favorites · 3 tracks/, favorites());
	const { picker: other, shown: again } = await openPicker(t, player().reply);
	await settled(other, ["k", "\r"]); // Favorites: Neon, Pixel
	await settled(other, ["f"]);
	await settled(other, ["\x1b"]);
	assert.ok(again().some((row) => /Favorites · 1 track\b/.test(row) && !/1 tracks/.test(row)), again().join("\n"));
});

// cliamp installed with no player running, as a stopped() player: `--version` answers when `installed`, the
// status once the spawned daemon is up (never when it `starts` false); its pid file holds `pid`, whose
// /proc/<pid>/comm is `comm`; SIGTERM stops it.
function stopped({ installed = true, starts = true, pid = 4242, comm = "cliamp" } = {}) {
	const music = player();
	const on = { running: false };
	const reply = (args) => {
		if (args[0] === "--version") return installed ? "cliamp version v2.3.0\n" : undefined;
		if (args[0] === "status" && !on.running) return undefined;
		return music.reply(args);
	};
	Object.assign(reply, {
		favoritePaths: music.reply.favoritePaths,
		toggle: music.reply.toggle,
		spawned: () => starts && setTimeout(() => (on.running = true), 30),
		pid: () => pid,
		comm: (asked) => (asked === pid ? comm : undefined),
		killed: () => (on.running = false),
	});
	return { on, reply };
}

const quick = (t) => {
	const saved = { ...musicTiming };
	Object.assign(musicTiming, { startPollMs: 10, startMs: 200, noticeMs: 200 });
	t.after(() => Object.assign(musicTiming, saved));
};
const until = async (check, ms = 1000) => {
	for (const end = Date.now() + ms; Date.now() < end && !check(); ) await new Promise((resolve) => setTimeout(resolve, 10));
	return check();
};
const START = "│ ▶ Start cliamp";

test("with cliamp installed and no player the card offers to start it; nothing starts by itself", async (t) => {
	quick(t);
	const { rows, raw, calls } = await column(t, stopped().reply);
	await settle();
	const out = rows().map((row) => row.replace(/ +│$/, ""));
	assert.equal(out[1], "│ Music", out.join("\n"));
	assert.equal(out[3], START);
	assert.ok(painted(raw()[3], "accent", "▶ Start cliamp"));
	assert.equal(calls.filter((args) => args[0] === "--version").length, 1, "installed is asked once");
	assert.deepEqual(calls.find((args) => args[0] === "--version"), ["--version"]);
	await new Promise((resolve) => setTimeout(resolve, 100));
	rows();
	assert.ok(!calls.some((args) => args[0] === "spawn"), "never started without a click");
});

test("without cliamp installed there is no card and nothing to start", async (t) => {
	const { rows, calls } = await column(t, stopped({ installed: false }).reply);
	await settle();
	assert.ok(!rows().some((row) => row.includes("Music") || row.includes("Start cliamp")));
	assert.ok(!calls.some((args) => args[0] === "spawn"));
});

test("a click on Start runs cliamp --daemon detached, shows Starting…, then the card and the playlist picker", async (t) => {
	quick(t);
	const { rows, raw, mouse, calls, popup } = await column(t, stopped().reply);
	await settle();
	const y = rows().findIndex((row) => row.startsWith(START));
	assert.equal(mouse("click", y, 3)?.handled, true);
	assert.deepEqual(calls.filter((args) => args[0] === "spawn" || args[0] === "unref"), [["spawn", "cliamp", ["--daemon"], { detached: true, stdio: "ignore" }], ["unref"]]);
	const at = rows().findIndex((row) => row.includes("Starting…"));
	assert.ok(at > 0, rows().join("\n"));
	assert.ok(painted(raw()[at], "dim", "Starting…"));
	assert.equal(mouse("click", at, 3)?.handled, undefined, "a click while starting does nothing");
	assert.equal(calls.filter((args) => args[0] === "spawn").length, 1);
	assert.ok(await until(() => popup.custom.length === 1), "the picker opens once the player answers");
	assert.ok(rows().some((row) => row.startsWith("│ HoliznaCC0 · Shimmer")), rows().join("\n"));
	const picker = popup.component();
	assert.ok(plain(picker.render(50)[1]).includes("cliamp · Playlists"), "the categories");
});

test("a player that never answers says so for a few seconds, then offers Start again", async (t) => {
	quick(t);
	const { rows, raw, mouse, popup } = await column(t, stopped({ starts: false }).reply);
	await settle();
	mouse("click", rows().findIndex((row) => row.startsWith(START)), 3);
	assert.ok(await until(() => rows().some((row) => row.includes("cliamp did not start"))), rows().join("\n"));
	assert.ok(painted(raw().find((row) => plain(row).includes("did not start")), "dim", "cliamp did not start"));
	assert.ok(await until(() => rows().some((row) => row.startsWith(START))), "Start again");
	assert.equal(popup.custom.length, 0);
});

test("⏻ stops the player with SIGTERM to the cliamp in its pid file, then offers Start", async (t) => {
	quick(t);
	const music = stopped();
	music.on.running = true;
	const { rows, mouse, calls } = await column(t, music.reply);
	await settle();
	const out = rows();
	const y = out.findIndex((row) => row.includes(POWER));
	assert.ok(y > 0 && out[y].replace(/ +│$/, "").endsWith(`${NEXT}  ${POWER}`), out.join("\n"));
	const before = calls.length;
	assert.equal(mouse("click", y, [...out[y]].indexOf(POWER))?.handled, true);
	assert.ok(await until(() => rows().some((row) => row.startsWith(START))), rows().join("\n"));
	assert.deepEqual(calls.slice(before).filter((args) => ["pid", "comm", "kill"].includes(args[0])), [["pid"], ["comm", 4242], ["kill", 4242, "SIGTERM"]]);
	assert.ok(!calls.some((args) => args[0] === "stop" || args[0] === "remote" && args[2] === "quit"), "no IPC quit: cliamp v2.3 has none");
});

test("a stale pid file is never signalled; the card says why", async (t) => {
	quick(t);
	for (const options of [{ comm: null }, { comm: "bash" }, { pid: null }]) {
		const music = stopped(options);
		music.on.running = true;
		const { rows, mouse, calls } = await column(t, music.reply);
		await settle();
		const out = rows();
		const y = out.findIndex((row) => row.includes(POWER));
		mouse("click", y, [...out[y]].indexOf(POWER));
		assert.ok(await until(() => rows().some((row) => row.includes("⏻ not stopped"))), `${JSON.stringify(options)}\n${rows().join("\n")}`);
		assert.ok(!calls.some((args) => args[0] === "kill"), JSON.stringify(options));
		assert.ok(rows().some((row) => row.startsWith("│ HoliznaCC0 · Shimmer")), "the player is still shown");
	}
});
